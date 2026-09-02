/* ==========================================================================
   QUIZZITCH — core/app.js
   Application bootstrapper, unique code verification, and stage routing.
   ========================================================================== */

import {
  CFG, S, bus, EV, Vault,
  buildQuestionSession, newSessionId, setStage,
  logEvent, toast
} from './state.js';

import * as view from '../quiz/render.js';
import * as engine from '../quiz/engine.js';
import { installSandbox } from '../security/sandbox.js';
import {
  installMonitor, armMonitor,
  requestFullscreen
} from '../security/monitor.js';
import {
  installProctor, engageCamera, captureBaseline, mountLiveFeed
} from '../security/proctor.js';
import { exportJSON, printDossier } from '../utils/export.js';

/* --- 01 · CONFIG LOADING & VALIDATION -------------------------------------- */
async function loadJSON(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status} ${res.statusText}`);
  return await res.json();
}

function validateConfig(settings, questions) {
  const problems = [];
  if (!settings || typeof settings !== 'object') problems.push('settings.json did not parse to an object.');
  if (!Array.isArray(questions) || !questions.length) problems.push('questions.json must be a non-empty array.');

  ['exam', 'security', 'proctoring', 'schemes', 'modules', 'registry', 'meta', 'briefing']
    .forEach((key) => {
      if (!(key in settings)) problems.push(`settings.json is missing the "${key}" block.`);
    });

  questions.forEach((q, i) => {
    const at = `questions.json item ${i + 1} (id ${q && q.id})`;
    if (!q || typeof q !== 'object') { problems.push(`${at}: not an object.`); return; }
    if (typeof q.question !== 'string' || !q.question.trim()) problems.push(`${at}: "question" is missing.`);
    if (!Array.isArray(q.options) || q.options.length < 2) problems.push(`${at}: needs at least two options.`);
  });

  return problems;
}

/* --- 02 · UNIQUE CODE & REGISTRY EVALUATION -------------------------------- */
function validateAccessCode(code) {
  const accessCfg = CFG.settings.accessCodes || { enabled: true };
  if (!accessCfg.enabled) return true;

  const trimmed = (code || '').trim().toUpperCase();
  if (!trimmed) return false;

  const validList = (accessCfg.validCodes || []).map((c) => c.toUpperCase());
  if (validList.includes(trimmed)) return true;

  if (accessCfg.pattern) {
    try {
      const reg = new RegExp(accessCfg.pattern, 'i');
      if (reg.test(trimmed)) return true;
    } catch (_) { /* pattern error */ }
  }

  // Fallback demo/valid format
  return trimmed.length >= 6;
}

function readRegistry() {
  S.candidate.code = view.el('in-code')?.value.trim().toUpperCase() || '';
  S.candidate.name = view.el('in-name')?.value.trim() || '';
  S.candidate.id = view.el('in-id')?.value.trim().toUpperCase() || '';
  S.candidate.grade = view.el('in-grade')?.value || '';
  S.candidate.school = view.el('in-school')?.value.trim() || '';
}

function evaluateGates() {
  readRegistry();
  const reg = CFG.settings.registry;
  const idPattern = new RegExp(reg.idPattern || '.*', 'i');
  const idOk = idPattern.test(S.candidate.id);
  const codeOk = validateAccessCode(S.candidate.code);

  const gates = {
    code: codeOk,
    registry: S.candidate.name.length >= (reg.minNameLength || 3)
      && idOk
      && !!S.candidate.grade
      && S.candidate.school.length >= 2,
    optic: !!S.baseline || S.degraded || !CFG.settings.proctoring.requireBaselineSnapshot,
    ack: view.el('ack')?.checked || false
  };

  view.markFieldValidity(
    'in-code',
    codeOk || S.candidate.code.length === 0,
    'hint-code',
    codeOk
      ? 'Access Code Verified'
      : (S.candidate.code.length ? 'Invalid access code. Please check your invitation.' : 'Enter unique code from invitation')
  );

  view.markFieldValidity(
    'in-id',
    idOk || S.candidate.id.length === 0,
    'hint-id',
    idOk || S.candidate.id.length === 0
      ? `Format ${reg.idPlaceholder.replace(/0/g, 'X')}`
      : `Expected ${reg.idPlaceholder.replace(/0/g, 'X')}`
  );

  let note = '';
  if (!codeOk && S.candidate.code.length > 0) {
    note = 'Valid access code required to unlock waiting lounge.';
  } else if (!gates.registry) {
    note = 'Complete candidate information to proceed.';
  } else if (!gates.optic) {
    note = 'Camera baseline verification required.';
  } else if (!gates.ack) {
    note = 'Please acknowledge the examination honor code.';
  }

  view.paintGates(gates, note);
  bus.emit(EV.GATES, gates);
  return Object.values(gates).every(Boolean);
}

/* --- 03 · STAGE TRANSITIONS ----------------------------------------------- */
function enterWaitingRoom() {
  if (!evaluateGates()) return;

  logEvent('ok', 'STAGE', `Candidate authenticated with access code: ${S.candidate.code}`);
  toast('Access Granted', `Welcome ${S.candidate.name}. Entering waiting lounge.`, 'ok', 4000);

  // Transition to Waiting Room Stage
  setStage('lounge');

  // Start synchronized lounge countdown
  engine.startLoungeTimer(() => {
    toast('Synchronized Start', 'The assessment is starting now!', 'accent', 4000);
    launchExam();
  });
}

async function launchExam() {
  engine.cancelLoungeTimer();

  const btn = view.el('btn-lounge-start');
  if (btn) btn.disabled = true;

  if (CFG.settings.security.requireFullscreen) {
    try {
      await requestFullscreen();
    } catch (_) {
      console.warn('Fullscreen request deferred.');
    }
  }

  setTimeout(beginExam, 200);
}

function beginExam() {
  setStage('live');
  mountLiveFeed();
  armMonitor();
  engine.startClock();
  engine.go(0);
  logEvent('ok', 'STAGE', 'Candidate entered live assessment workspace');
  toast('Assessment Started', 'Good luck! Answers will record automatically.', 'ok', 5000);
}

/* --- 04 · CONTROLS & EVENT WIRING ----------------------------------------- */
function wireControls() {
  ['in-code', 'in-name', 'in-id', 'in-grade', 'in-school'].forEach((id) => {
    const n = view.el(id);
    if (n) {
      n.addEventListener('input', evaluateGates);
      n.addEventListener('change', evaluateGates);
    }
  });

  const ack = view.el('ack');
  if (ack) ack.addEventListener('change', evaluateGates);

  const camBtn = view.el('btn-cam');
  if (camBtn) camBtn.addEventListener('click', engageCamera);

  const snapBtn = view.el('btn-snap');
  if (snapBtn) snapBtn.addEventListener('click', captureBaseline);

  // Step Action: Proceed to Waiting Room
  const launchBtn = view.el('btn-launch');
  if (launchBtn) launchBtn.addEventListener('click', enterWaitingRoom);

  // Lounge Action: Start Assessment (Synchronized or override)
  const loungeStartBtn = view.el('btn-lounge-start');
  if (loungeStartBtn) loungeStartBtn.addEventListener('click', launchExam);

  // Exam Workspace navigation & response actions
  const prevBtn = view.el('btn-prev');
  if (prevBtn) prevBtn.addEventListener('click', engine.prev);

  const nextBtn = view.el('btn-next');
  if (nextBtn) nextBtn.addEventListener('click', engine.next);

  const clearBtn = view.el('btn-clear');
  if (clearBtn) clearBtn.addEventListener('click', engine.clearResponse);

  const flagBtn = view.el('btn-flag');
  if (flagBtn) flagBtn.addEventListener('click', engine.toggleFlag);

  const submitBtn = view.el('btn-submit');
  if (submitBtn) {
    submitBtn.addEventListener('click', () => {
      const answered = S.responses.filter((r) => r.sel && r.sel.length).length;
      const total = CFG.questions.length;
      if (confirm(`Are you sure you want to submit your assessment?\n\nYou have answered ${answered} of ${total} questions. Your choices will be submitted to JotForm.`)) {
        engine.sealExam('CANDIDATE_SUBMIT');
      }
    });
  }

  // Dossier actions
  const exportJsonBtn = view.el('btn-export-json');
  if (exportJsonBtn) exportJsonBtn.addEventListener('click', () => exportJSON(engine.getDossier()));

  const printBtn = view.el('btn-print');
  if (printBtn) printBtn.addEventListener('click', printDossier);

  // Intent subscriptions
  bus.on(EV.INTENT_NAV, (i) => engine.go(i));
  bus.on(EV.INTENT_PICK, (optIdx) => engine.pick(optIdx));
  bus.on(EV.INTENT_MODULE, (catId) => engine.setModule(catId));
}

/* --- 05 · BOOTSTRAPPER ---------------------------------------------------- */
async function boot() {
  S.bootedAt = Date.now();
  S.sessionId = newSessionId();
  view.paintSession(S.sessionId);

  try {
    const [settings, rawQuestions] = await Promise.all([
      loadJSON('config/settings.json'),
      loadJSON('config/questions.json')
    ]);

    const problems = validateConfig(settings, rawQuestions);
    if (problems.length) {
      console.error('[Quizzitch] Config validation faults:', problems);
    }

    CFG.settings = settings;
    CFG.rawQuestions = rawQuestions;
    CFG.modules = settings.modules || [];
    CFG.schemes = settings.schemes || {};

    // Pool questions randomly and shuffle options
    buildQuestionSession();

    view.bindRenderer();
    view.buildStaticUI();

    installSandbox();
    installMonitor();
    installProctor({ onCalibrationChange: evaluateGates });

    wireControls();
    evaluateGates();

    console.log(`[Quizzitch] Portal booted successfully. Questions pooled: ${CFG.questions.length}/${CFG.rawQuestions.length}`);
  } catch (err) {
    console.error('[Quizzitch] Boot failed:', err);
    toast('Boot Error', `Failed to load portal configuration: ${err.message}`, 'danger', 10000);
  }
}

document.addEventListener('DOMContentLoaded', boot);
