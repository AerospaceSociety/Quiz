/* ==========================================================================
   QUIZZITCH — quiz/engine.js
   Navigation, response capture, marking-scheme evaluation, the mission clock
   listener, sealing and audit-dossier assembly.
   ========================================================================== */

import {
  CFG, S, bus, EV,
  scheme, moduleOf, clamp, hash32, clockStamp,
  logEvent, toast, commitDwell, answeredCount, flaggedCount, setStage
} from '../core/state.js';

import { createCountdown, mmss, wallTime } from '../utils/timer.js';
import * as view from './render.js';
import { stopAnalyser, releaseStream } from '../security/proctor.js';
import { exitFullscreen, disarmMonitor } from '../security/monitor.js';
import { submitAssessmentToJotForm } from '../utils/jotform.js';

let dossier = null;

/** The completed audit dossier, or null while the paper is still open. */
export const getDossier = () => dossier;

/* --- 01 · NAVIGATION ------------------------------------------------------ */
export function go(index) {
  if (S.locked || S.stage !== 'live') return;
  if (index < 0 || index >= CFG.questions.length) return;

  commitDwell();
  S.idx = index;
  S.activeModule = CFG.questions[index].catId;
  S.responses[index].visits += 1;
  S.qEnterTs = performance.now();

  bus.emit(EV.QUESTION, index);
  bus.emit(EV.MATRIX);
}

export const next = () => go((S.idx + 1) % CFG.questions.length);
export const prev = () => go(S.idx - 1);

export function setModule(catId) {
  if (S.locked || S.stage !== 'live') return;
  S.activeModule = catId;
  const first = CFG.questions.findIndex((q) => q.catId === catId);
  if (first > -1) go(first);
  else bus.emit(EV.MATRIX);
}

/* --- 02 · RESPONSE CAPTURE ------------------------------------------------ */
export function pick(optionIndex) {
  if (S.locked || S.stage !== 'live') return;

  const q = CFG.questions[S.idx];
  const r = S.responses[S.idx];
  const sc = scheme(q.scheme);
  if (optionIndex < 0 || optionIndex >= q.options.length) return;

  if (sc.multi) {
    const at = r.sel.indexOf(optionIndex);
    if (at > -1) r.sel.splice(at, 1);
    else r.sel.push(optionIndex);
    r.sel.sort((a, b) => a - b);
  } else {
    // Tapping the selected option again clears it.
    r.sel = (r.sel.length === 1 && r.sel[0] === optionIndex) ? [] : [optionIndex];
  }

  bus.emit(EV.QUESTION, S.idx);
  bus.emit(EV.MATRIX);
  bus.emit(EV.PROGRESS);
}

export function clearResponse() {
  if (S.locked || S.stage !== 'live') return;
  S.responses[S.idx].sel = [];
  logEvent('info', 'RESPONSE', `Response cleared on item ${S.idx + 1}`);
  bus.emit(EV.QUESTION, S.idx);
  bus.emit(EV.MATRIX);
  bus.emit(EV.PROGRESS);
}

export function toggleFlag() {
  if (S.locked || S.stage !== 'live') return;
  const r = S.responses[S.idx];
  r.flagged = !r.flagged;
  logEvent('info', 'REVIEW', `${r.flagged ? 'Flagged' : 'Unflagged'} item ${S.idx + 1} for review`);
  bus.emit(EV.QUESTION, S.idx);
  bus.emit(EV.MATRIX);
  bus.emit(EV.PROGRESS);
}

/* --- 03 · MARKING --------------------------------------------------------- */
/**
 * Evaluates a single item against its marking scheme.
 *  standard   +2 correct /  0 incorrect / 0 unattempted
 *  highstakes +2 correct / −1 incorrect / 0 unattempted
 *  multi      +4 all-correct / −2 partial, excess or wrong / 0 unattempted
 */
export function scoreItem(index) {
  const q = CFG.questions[index];
  const r = S.responses[index];
  const sc = scheme(q.scheme);

  if (!r.sel.length) return { status: 'UNATTEMPTED', marks: sc.unattempted || 0 };

  const key = q.correct;
  const exact = r.sel.length === key.length && r.sel.every((v) => key.indexOf(v) > -1);

  return exact
    ? { status: 'CORRECT', marks: sc.correct }
    : { status: 'INCORRECT', marks: sc.incorrect };
}

/* --- 04 · MISSION CLOCK --------------------------------------------------- */
export function startClock() {
  const exam = CFG.settings.exam;

  S.clock = createCountdown({
    durationSeconds: exam.durationSeconds,
    tickMs: exam.clockTickMs,
    warnAt: exam.warnAtSeconds,
    critAt: exam.criticalAtSeconds,
    onTick: (remaining, elapsed) => {
      S.remaining = remaining;
      bus.emit(EV.CLOCK, { remaining, elapsed });
    },
    onThreshold: (level) => {
      if (level === 'warn') {
        logEvent('warn', 'CLOCK', `${mmss(exam.warnAtSeconds)} remaining`);
        toast('Time advisory', `${mmss(exam.warnAtSeconds)} of the paper remains.`, 'warn');
      } else {
        logEvent('crit', 'CLOCK', `${mmss(exam.criticalAtSeconds)} remaining — final window`);
        toast('Final window', `${mmss(exam.criticalAtSeconds)} remaining. Review flagged items now.`, 'danger');
      }
    },
    onExpire: () => {
      S.remaining = 0;
      logEvent('crit', 'CLOCK', 'Mission clock expired at T‑00:00 — paper force-submitted');
      if (exam.autoSubmitOnExpiry) sealPaper('TIME_EXPIRY');
    }
  });

  S.clock.start();
  S.startTs = S.clock.startTs;
}

/* --- 05 · PAPER LIFECYCLE ------------------------------------------------- */
export function startPaper() {
  setStage('live');
  S.activeModule = CFG.questions[0].catId;

  bus.emit(EV.MATRIX);
  go(0);
  startClock();
  view.paintStrikes();
  view.renderProgress();
}

export function openSubmitDialog() {
  if (S.locked || S.stage !== 'live') return;
  view.overlay.submit();
}

/**
 * Freezes the paper, generates the dossier and (unless a lockout overlay is
 * being held on screen) routes to Stage 3.
 */
export function sealPaper(reason, keepOverlay = false) {
  if (S.stage === 'sealed') return;

  commitDwell();
  S.submitReason = reason;
  S.stage = 'sealed';

  if (S.clock) S.clock.stop();
  stopAnalyser();
  disarmMonitor();

  logEvent('ok', 'SESSION', `Paper sealed · reason=${reason} · elapsed=${mmss(CFG.settings.exam.durationSeconds - S.remaining)}`);

  dossier = buildDossier(reason);
  bus.emit(EV.SEALED, dossier);

  /* Forward payload to JotForm */
  submitAssessmentToJotForm(dossier).then((res) => {
    if (res.ok) {
      logEvent('ok', 'JOTFORM', `Assessment saved to JotForm · ref=${res.id}`);
      toast('Submitted to JotForm', `Registration reference: ${res.id}`, 'ok');
    } else {
      logEvent('warn', 'JOTFORM', `JotForm dispatch issue: ${res.error || 'Check network'}`);
    }
  }).catch((err) => {
    logEvent('warn', 'JOTFORM', `JotForm dispatch skipped: ${err.message}`);
  });

  if (!keepOverlay) revealDossier();
}

export function revealDossier() {
  exitFullscreen();
  releaseStream();
  view.clearToasts();
  view.overlay.closeAll();
  view.overlay.close('ov-lock');
  setStage('sealed');
  view.paintSealedClock(CFG.settings.exam.durationSeconds - S.remaining);
  window.scrollTo(0, 0);
}

/** Strike ledger exhausted — disqualify, seal and hold the lockout overlay. */
export function lockout(trigger) {
  if (S.locked) return;

  S.locked = true;
  S.verdict = 'DISQUALIFIED';
  S.dqReason = trigger;

  view.overlay.closeAll();
  logEvent('crit', 'LOCKOUT', 'Strike ledger exhausted — portal locked and paper force-submitted');

  const criticals = S.log.filter((l) => l.sev === 'crit').length;
  view.overlay.lockout(trigger, `${clockStamp()} · ${wallTime()}`, criticals);

  sealPaper('STRIKE_LOCKOUT', true);
}

/* --- 06 · DOSSIER ASSEMBLY ------------------------------------------------ */
export function buildDossier(reason) {
  const exam = CFG.settings.exam;
  const perModule = CFG.modules.map((m) => ({
    id: m.id, code: m.code, short: m.short, name: m.name,
    attempted: 0, correct: 0, incorrect: 0, unattempted: 0, marks: 0, max: 0
  }));

  let total = 0;
  let correct = 0;
  let attempted = 0;

  const items = CFG.questions.map((q, i) => {
    const r = S.responses[i];
    const sc = scheme(q.scheme);
    const res = scoreItem(i);
    const bucket = perModule[q.catId] || perModule[0];

    bucket.max += sc.correct;
    if (res.status === 'UNATTEMPTED') {
      bucket.unattempted += 1;
    } else {
      bucket.attempted += 1;
      attempted += 1;
      if (res.status === 'CORRECT') { bucket.correct += 1; correct += 1; }
      else bucket.incorrect += 1;
    }
    bucket.marks += res.marks;
    total += res.marks;

    return {
      n: i + 1,
      id: q.id,
      moduleCode: moduleOf(q.catId).code,
      moduleShort: moduleOf(q.catId).short,
      scheme: q.scheme,
      schemeLabel: sc.label,
      response: r.sel.length ? r.sel.map((v) => CFG.letters[v]).join(' + ') : '—',
      key: q.correct.map((v) => CFG.letters[v]).join(' + '),
      status: res.status,
      marks: res.marks,
      seconds: +(r.timeMs / 1000).toFixed(1),
      visits: r.visits,
      flagged: r.flagged
    };
  });

  const o = S.optic;
  const consumed = clamp(exam.durationSeconds - S.remaining, 0, exam.durationSeconds);
  const incidents = S.log.filter((l) => l.sev === 'crit' || l.sev === 'warn').length;

  const payload = {
    meta: {
      portal: CFG.settings.meta.portal,
      event: CFG.settings.meta.event,
      round: CFG.settings.meta.round,
      organiser: CFG.settings.meta.organiser,
      build: CFG.settings.meta.build,
      sessionId: S.sessionId,
      generated: new Date().toISOString(),
      submitReason: reason,
      verdict: S.verdict,
      dqReason: S.dqReason,
      proctored: !S.degraded,
      integrityHash: ''
    },
    candidate: { ...S.candidate },
    result: {
      score: total,
      max: CFG.maxScore,
      attempted,
      correct,
      incorrect: attempted - correct,
      unattempted: CFG.questions.length - attempted,
      accuracyPct: attempted ? +((correct / attempted) * 100).toFixed(2) : 0,
      timeConsumedSec: Math.round(consumed),
      timeRemainingSec: Math.round(S.remaining)
    },
    modules: perModule,
    items,
    proctoring: {
      strikes: S.strikes,
      maxStrikes: CFG.settings.security.maxStrikes,
      focusBreaches: S.blurCount,
      fullscreenReleases: S.fsBreaches,
      opticalFlags: S.opticalFlags,
      opticalSamples: o.frames,
      sampleRateHz: +(1000 / CFG.settings.proctoring.sampleIntervalMs).toFixed(0),
      presencePct: +o.presencePct.toFixed(2),
      meanStabilityPct: o.frames ? +(o.stabilitySum / o.frames).toFixed(2) : null,
      baselineCaptured: !!S.baseline,
      degradedMode: S.degraded,
      incidents
    },
    diagnostics: S.diag,
    incidents: S.log
  };

  const serialised = JSON.stringify(payload);
  payload.meta.integrityHash = `${hash32(serialised)}-${hash32(S.sessionId + serialised.length)}`;

  return payload;
}

/* --- 07 · INTENT WIRING --------------------------------------------------- */
/** Connects view intents and the lockout signal to the engine. */
export function bindEngine() {
  bus.on(EV.INTENT_NAV, go);
  bus.on(EV.INTENT_PICK, pick);
  bus.on(EV.INTENT_MODULE, setModule);
  bus.on(EV.LOCKOUT, ({ trigger }) => lockout(trigger));
}

/* Re-exported so app.js can surface counts without importing state directly. */
export { answeredCount, flaggedCount };
