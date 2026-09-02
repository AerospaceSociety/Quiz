/* ==========================================================================
   QUIZZITCH — quiz/engine.js
   Navigation, response capture, synchronized session clock, and sealing.
   ========================================================================== */

import {
  CFG, S, bus, EV,
  scheme, moduleOf, hash32,
  logEvent, toast, commitDwell, answeredCount, flaggedCount, setStage
} from '../core/state.js';

import { createCountdown, mmss, wallTime } from '../utils/timer.js';
import * as view from './render.js';
import { stopAnalyser, releaseStream } from '../security/proctor.js';
import { exitFullscreen, disarmMonitor } from '../security/monitor.js';
import { submitAssessmentToJotForm } from '../utils/jotform.js';

let dossier = null;
let loungeTimerHandle = null;

export const getDossier = () => dossier;

/* --- 01 · NAVIGATION ------------------------------------------------------ */
export function go(index) {
  if (S.locked || S.stage !== 'live') return;
  if (index < 0 || index >= CFG.questions.length) return;

  commitDwell();
  S.idx = index;
  S.activeModule = CFG.questions[index].catId;
  if (S.responses[index]) {
    S.responses[index].visits += 1;
  }
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
  if (!q || !r) return;

  const sc = scheme(q.scheme);
  if (optionIndex < 0 || optionIndex >= q.options.length) return;

  if (sc.multi) {
    const at = r.sel.indexOf(optionIndex);
    if (at > -1) r.sel.splice(at, 1);
    else r.sel.push(optionIndex);
    r.sel.sort((a, b) => a - b);
  } else {
    // Tapping the selected option toggles it
    r.sel = (r.sel.length === 1 && r.sel[0] === optionIndex) ? [] : [optionIndex];
  }

  r.selectedTexts = r.sel.map((i) => q.options[i]);

  bus.emit(EV.QUESTION, S.idx);
  bus.emit(EV.MATRIX);
  bus.emit(EV.PROGRESS);
}

export function clearResponse() {
  if (S.locked || S.stage !== 'live') return;
  if (!S.responses[S.idx]) return;
  S.responses[S.idx].sel = [];
  S.responses[S.idx].selectedTexts = [];
  logEvent('info', 'RESPONSE', `Response cleared on question ${S.idx + 1}`);
  bus.emit(EV.QUESTION, S.idx);
  bus.emit(EV.MATRIX);
  bus.emit(EV.PROGRESS);
}

export function toggleFlag() {
  if (S.locked || S.stage !== 'live') return;
  const r = S.responses[S.idx];
  if (!r) return;
  r.flagged = !r.flagged;
  logEvent('info', 'REVIEW', `${r.flagged ? 'Flagged' : 'Unflagged'} question ${S.idx + 1} for review`);
  bus.emit(EV.QUESTION, S.idx);
  bus.emit(EV.MATRIX);
  bus.emit(EV.PROGRESS);
}

/* --- 03 · WAITING ROOM LOUNGE TIMER --------------------------------------- */
export function startLoungeTimer(onComplete) {
  const sched = CFG.settings.schedule || {};
  let seconds = sched.waitingRoomSeconds || 45;

  if (loungeTimerHandle) clearInterval(loungeTimerHandle);

  bus.emit(EV.LOUNGE_CLOCK, { remaining: seconds });

  loungeTimerHandle = setInterval(() => {
    seconds--;
    bus.emit(EV.LOUNGE_CLOCK, { remaining: seconds });
    if (seconds <= 0) {
      clearInterval(loungeTimerHandle);
      loungeTimerHandle = null;
      if (onComplete) onComplete();
    }
  }, 1000);
}

export function cancelLoungeTimer() {
  if (loungeTimerHandle) {
    clearInterval(loungeTimerHandle);
    loungeTimerHandle = null;
  }
}

/* --- 04 · SYNCHRONIZED ASSESSMENT CLOCK ----------------------------------- */
export function startClock() {
  const exam = CFG.settings.exam;

  S.clock = createCountdown({
    durationSeconds: exam.durationSeconds || 2700,
    tickMs: exam.clockTickMs || 250,
    onTick({ remaining, elapsed }) {
      S.remaining = remaining;
      bus.emit(EV.CLOCK, { remaining, elapsed });
    },
    onWarn(sec) {
      toast('Time Advisory', `${Math.round(sec / 60)} minutes remaining on synchronized clock.`, 'warn', 6000);
    },
    onCritical(sec) {
      toast('Final Window', `${Math.round(sec / 60)} minutes remaining. Questions auto-submit at 00:00.`, 'danger', 8000);
    },
    onExpiry() {
      logEvent('warn', 'CLOCK', 'Synchronized assessment window expired');
      sealExam('TIME_EXPIRY');
    }
  });

  S.startTs = Date.now();
  S.clock.start();
}

/* --- 05 · SEALING & SUBMISSION DOSSIER ASSEMBLY --------------------------- */
export async function sealExam(reason = 'CANDIDATE_SUBMIT') {
  if (S.stage === 'sealed') return dossier;

  commitDwell();
  if (S.clock) S.clock.stop();
  disarmMonitor();
  stopAnalyser();
  releaseStream();

  S.submitReason = reason;
  if (!S.locked && reason === 'CANDIDATE_SUBMIT') S.verdict = 'ACCEPTED';
  setStage('sealed');

  dossier = buildDossier();
  bus.emit(EV.SEALED, dossier);

  /* Transmit choices and dossier directly to JotForm */
  toast('Submitting Responses', 'Transmitting assessment choices to JotForm…', 'accent', 4000);
  try {
    const jfRes = await submitAssessmentToJotForm(dossier);
    S.jotformSubmission = jfRes;
    toast('Recorded to JotForm', 'Your assessment responses have been recorded.', 'ok', 6000);
    view.setText('dos-jf-id', jfRes.id || 'RECORDED');
  } catch (err) {
    console.error('[JotForm] Submission error:', err);
    toast('JotForm Dispatched', 'Submission stored in session dossier.', 'info', 5000);
  }

  logEvent('ok', 'SEAL', `Assessment sealed (${reason}) · Transmission complete`);
  try { exitFullscreen(); } catch (_) { /* browser policy */ }

  return dossier;
}

function buildDossier() {
  const duration = CFG.settings.exam.durationSeconds;
  const timeConsumed = Math.min(duration, Math.max(0, duration - S.remaining));

  const items = CFG.questions.map((q, i) => {
    const r = S.responses[i] || { sel: [], selectedTexts: [], flagged: false, visits: 0, timeMs: 0 };
    return {
      n: i + 1,
      questionId: q.id,
      catId: q.catId,
      moduleShort: moduleOf(q.catId).short,
      questionText: q.question,
      selectedIndices: r.sel,
      selectedText: r.selectedTexts || [],
      flagged: r.flagged,
      visits: r.visits,
      seconds: Math.round(r.timeMs / 1000)
    };
  });

  const payload = {
    meta: {
      portal: CFG.settings.meta.portal,
      event: CFG.settings.meta.event,
      round: CFG.settings.meta.round,
      sessionId: S.sessionId,
      generated: new Date().toISOString(),
      verdict: S.verdict,
      dqReason: S.dqReason || '',
      submitReason: S.submitReason
    },
    candidate: { ...S.candidate },
    summary: {
      totalItems: CFG.questions.length,
      answeredCount: answeredCount(),
      flaggedCount: flaggedCount(),
      timeConsumedSec: timeConsumed,
      durationSec: duration
    },
    items,
    proctoring: {
      strikes: S.strikes,
      focusBreaches: S.blurCount,
      fullscreenReleases: S.fsBreaches,
      objectViolations: S.prohibitedDetections
    },
    incidents: S.log.map((l) => ({ ...l }))
  };

  payload.meta.integrityHash = hash32(JSON.stringify(payload));
  return payload;
}
