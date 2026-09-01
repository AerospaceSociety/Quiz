/* ==========================================================================
   QUIZZITCH — core/app.js
   Application bootstrapper and stage router.

   Boot order:
     1. load + validate config/settings.json and config/questions.json
     2. build the static UI from that config
     3. install the security layers (sandbox, monitor, proctor)
     4. run the Stage 0 diagnostic sweep
     5. wire controls and evaluate the launch gates
   ========================================================================== */

import {
  CFG, S, bus, EV, Vault,
  initResponses, newSessionId, setStage,
  logEvent, toast, clockStamp
} from './state.js';

import { utcOffset } from '../utils/timer.js';
import * as view from '../quiz/render.js';
import * as engine from '../quiz/engine.js';
import { installSandbox } from '../security/sandbox.js';
import {
  installMonitor, armMonitor, acknowledgeFocusAlarm, redock,
  requestFullscreen, fullscreenSupported
} from '../security/monitor.js';
import {
  installProctor, engageCamera, captureBaseline, mountLiveFeed
} from '../security/proctor.js';
import { exportJSON, printDossier } from '../utils/export.js';

/* --- 01 · CONFIG LOADING -------------------------------------------------- */
async function loadJSON(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status} ${res.statusText}`);
  try {
    return await res.json();
  } catch (err) {
    throw new Error(`${path} is not valid JSON — ${err.message}`);
  }
}

function validateConfig(settings, questions) {
  const problems = [];

  if (!settings || typeof settings !== 'object') problems.push('settings.json did not parse to an object.');
  if (!Array.isArray(questions)) problems.push('questions.json must be a top-level array.');
  if (problems.length) return problems;

  ['exam', 'security', 'proctoring', 'schemes', 'modules', 'registry', 'meta', 'briefing']
    .forEach((key) => {
      if (!(key in settings)) problems.push(`settings.json is missing the "${key}" block.`);
    });

  if (!questions.length) problems.push('questions.json contains no items.');

  questions.forEach((q, i) => {
    const at = `questions.json item ${i + 1} (id ${q && q.id})`;
    if (!q || typeof q !== 'object') { problems.push(`${at}: not an object.`); return; }
    if (typeof q.question !== 'string' || !q.question.trim()) problems.push(`${at}: "question" is missing.`);
    if (!Array.isArray(q.options) || q.options.length < 2) problems.push(`${at}: needs at least two options.`);
    if (!settings.schemes || !settings.schemes[q.scheme]) problems.push(`${at}: unknown scheme "${q.scheme}".`);
    if (!Array.isArray(q.correct) || !q.correct.length) problems.push(`${at}: "correct" must be a non-empty array.`);
    else if (Array.isArray(q.options)) {
      q.correct.forEach((k) => {
        if (!Number.isInteger(k) || k < 0 || k >= q.options.length) {
          problems.push(`${at}: correct index ${k} is outside the option range.`);
        }
      });
    }
    const modIds = (settings.modules || []).map((m) => m.id);
    if (!modIds.includes(q.catId)) problems.push(`${at}: catId ${q.catId} has no matching module.`);
  });

  return problems;
}

/* --- 02 · STAGE 0 DIAGNOSTIC PROBES -------------------------------------- */
const PROBES = [
  {
    key: 'runtime',
    name: 'Runtime engine',
    detail: 'User-agent and JavaScript core',
    run() {
      const ua = navigator.userAgent;
      const engineName = /Firefox\//.test(ua) ? 'Gecko'
        : /Edg\//.test(ua) ? 'Chromium / Edge'
        : /Chrome\//.test(ua) ? 'Chromium'
        : /Safari\//.test(ua) ? 'WebKit'
        : 'Unknown';
      return { ok: true, text: `${engineName} · OK` };
    }
  },
  {
    key: 'raster',
    name: 'Display geometry',
    detail: 'Screen resolution and pixel ratio',
    run() {
      const w = screen.width;
      const h = screen.height;
      const dpr = window.devicePixelRatio || 1;
      const roomy = w >= 1024 && h >= 600;
      return {
        ok: true,
        warn: !roomy,
        text: `${w}×${h} @${dpr.toFixed(2)}× · ${roomy ? 'OK' : 'below recommended'}`
      };
    }
  },
  {
    key: 'optic',
    name: 'Optical device API',
    detail: 'Secure context and getUserMedia',
    run() {
      const api = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
      const secure = window.isSecureContext !== false;
      if (!secure) {
        return {
          ok: false,
          text: 'Insecure origin · FAIL',
          fix: 'Serve the portal over HTTPS or from localhost — browsers refuse camera access on plain HTTP.'
        };
      }
      return {
        ok: api,
        text: api ? 'Available · OK' : 'Unsupported · FAIL',
        fix: api ? null : 'This browser does not expose getUserMedia. Use a current desktop Chrome, Edge or Firefox.'
      };
    }
  },
  {
    key: 'fullscreen',
    name: 'Fullscreen containment',
    detail: 'Element.requestFullscreen',
    run() {
      const ok = fullscreenSupported();
      return {
        ok,
        text: ok ? 'Supported · OK' : 'Unsupported · FAIL',
        fix: ok ? null : 'This browser cannot lock the display (common on iPhone/iPad). Use a desktop or laptop browser.'
      };
    }
  },
  {
    key: 'canvas',
    name: 'Raster pipeline',
    detail: '2D canvas and getImageData',
    run() {
      try {
        const c = document.createElement('canvas');
        c.width = 4; c.height = 4;
        const ctx = c.getContext('2d');
        ctx.fillRect(0, 0, 2, 2);
        ctx.getImageData(0, 0, 4, 4);
        return { ok: true, text: '2D context · OK' };
      } catch (_) {
        return { ok: false, text: 'Blocked · FAIL', fix: 'Canvas readback is blocked; disable anti-fingerprinting for this origin.' };
      }
    }
  },
  {
    key: 'vault',
    name: 'Session storage',
    detail: 'sessionStorage / volatile fallback',
    run() {
      return Vault.available
        ? { ok: true, text: 'sessionStorage · OK' }
        : { ok: true, warn: true, text: 'Volatile fallback · WARN' };
    }
  },
  {
    key: 'network',
    name: 'Network latency',
    detail: 'Probe against the font CDN edge',
    async: true,
    run() {
      return new Promise((resolve) => {
        if (!navigator.onLine) { resolve({ ok: true, warn: true, text: 'Offline · local mode' }); return; }

        const t0 = performance.now();
        let settled = false;
        const finish = (r) => { if (!settled) { settled = true; resolve(r); } };
        const timeout = setTimeout(() => finish({ ok: true, warn: true, text: 'No probe · local mode' }), 3200);

        fetch('https://fonts.gstatic.com/generate_204', { mode: 'no-cors', cache: 'no-store' })
          .then(() => {
            clearTimeout(timeout);
            const ms = Math.round(performance.now() - t0);
            finish({ ok: true, warn: ms > 800, text: `${ms} ms · ${ms > 800 ? 'degraded' : 'nominal'}` });
          })
          .catch(() => {
            clearTimeout(timeout);
            finish({ ok: true, warn: true, text: 'No probe · local mode' });
          });
      });
    }
  }
];

async function runDiagnostics() {
  PROBES.forEach((p, i) => view.addDiagRow(p, i));

  view.paintEnvironment({
    node: (navigator.platform || navigator.userAgentData?.platform || 'Unknown').toUpperCase(),
    raster: `${screen.width}×${screen.height}`,
    locale: (navigator.language || 'en').toUpperCase(),
    offset: utcOffset()
  });

  let fails = 0;
  let warns = 0;

  for (const probe of PROBES) {
    await new Promise((r) => setTimeout(r, 160));
    let result;
    try {
      result = probe.async ? await probe.run() : probe.run();
    } catch (err) {
      result = { ok: false, text: 'Exception · FAIL', fix: err.message };
    }
    S.diag[probe.key] = result;
    view.setDiagResult(probe.key, result);
    if (!result.ok) fails++;
    else if (result.warn) warns++;
  }

  S.diagFails = fails;
  view.setDiagSummary(fails, warns);
  logEvent(fails ? 'crit' : 'ok', 'DIAG',
    `Diagnostic sweep complete · ${fails} fault(s), ${warns} advisory(ies)`);
  evaluateGates();
}

/* --- 03 · LAUNCH GATES ---------------------------------------------------- */
function readRegistry() {
  S.candidate.name = view.el('in-name').value.trim();
  S.candidate.id = view.el('in-id').value.trim().toUpperCase();
  S.candidate.grade = view.el('in-grade').value;
  S.candidate.school = view.el('in-school').value.trim();
}

function evaluateGates() {
  readRegistry();
  const reg = CFG.settings.registry;
  const idPattern = new RegExp(reg.idPattern, 'i');
  const idOk = idPattern.test(S.candidate.id);

  const gates = {
    diag: S.diagFails === 0,
    registry: S.candidate.name.length >= reg.minNameLength
      && idOk
      && !!S.candidate.grade
      && S.candidate.school.length >= 2,
    optic: !!S.baseline || S.degraded || !CFG.settings.proctoring.requireBaselineSnapshot,
    ack: view.el('ack').checked
  };

  view.markFieldValidity(
    'in-id',
    idOk || S.candidate.id.length === 0,
    'hint-id',
    idOk || S.candidate.id.length === 0
      ? `Format ${reg.idPlaceholder.replace(/0/g, 'X')}`
      : `Expected ${reg.idPlaceholder.replace(/0/g, 'X')}`
  );

  const broken = Object.keys(S.diag).filter((k) => S.diag[k] && S.diag[k].ok === false);
  const note = broken.length
    ? 'Portal cannot arm — ' + broken.map((k) => S.diag[k].fix || `${k} check failed.`).join('  ')
    : '';

  view.paintGates(gates, note);
  bus.emit(EV.GATES, gates);
  return Object.values(gates).every(Boolean);
}

/* --- 04 · STAGE TRANSITIONS ---------------------------------------------- */
async function launchExam() {
  if (!evaluateGates()) return;

  const btn = view.el('btn-launch');
  btn.disabled = true;

  if (CFG.settings.security.requireFullscreen) {
    try {
      await requestFullscreen();
    } catch (_) {
      btn.disabled = false;
      toast('Handshake rejected',
        'Fullscreen was refused by the browser. Allow fullscreen and retry — the paper cannot arm without display containment.',
        'danger', 9000);
      return;
    }
  }

  // Let the fullscreen transition settle before the workspace paints.
  setTimeout(beginExam, 180);
}

function beginExam() {
  engine.startPaper();
  mountLiveFeed();
  armMonitor();

  logEvent('ok', 'SESSION',
    `Secure session armed · candidate=${S.candidate.id || 'UNREGISTERED'} · session=${S.sessionId}`);
  logEvent(S.stream ? 'ok' : 'crit', 'OPTICAL', S.stream
    ? `Optical proctoring active · sensor=${S.camLabel.slice(0, 44)}`
    : 'Paper running UNPROCTORED — optical link waived at pre-flight');
  logEvent('info', 'CLOCK',
    `Mission clock started · duration ${Math.round(CFG.settings.exam.durationSeconds / 60)} minutes`);

  toast('Paper armed',
    `${Math.round(CFG.settings.exam.durationSeconds / 60)}:00 to complete ${CFG.questions.length} items.`,
    'accent');
}

/* --- 05 · CONTROL WIRING -------------------------------------------------- */
function wireControls() {
  /* Stage 0 */
  view.el('btn-cam').addEventListener('click', engageCamera);
  view.el('btn-snap').addEventListener('click', captureBaseline);
  view.el('ack').addEventListener('change', evaluateGates);
  ['in-name', 'in-id', 'in-grade', 'in-school'].forEach((id) => {
    const node = view.el(id);
    node.addEventListener('input', evaluateGates);
    node.addEventListener('change', evaluateGates);
  });
  view.el('btn-launch').addEventListener('click', launchExam);

  /* Stage 1/2 — paper controls */
  view.el('btn-prev').addEventListener('click', engine.prev);
  view.el('btn-next').addEventListener('click', engine.next);
  view.el('btn-clear').addEventListener('click', engine.clearResponse);
  view.el('btn-flag').addEventListener('click', engine.toggleFlag);
  view.el('btn-submit').addEventListener('click', engine.openSubmitDialog);

  view.el('btn-sub-cancel').addEventListener('click', () => view.overlay.close('ov-submit'));
  view.el('btn-sub-confirm').addEventListener('click', () => {
    view.overlay.close('ov-submit');
    engine.sealPaper('CANDIDATE_SUBMIT');
  });

  /* Security overlays */
  view.el('btn-ack-focus').addEventListener('click', acknowledgeFocusAlarm);
  view.el('btn-redock').addEventListener('click', redock);
  view.el('btn-lock-dossier').addEventListener('click', engine.revealDossier);

  /* Stage 3 — dossier actions */
  view.el('btn-export').addEventListener('click', () => exportJSON(engine.getDossier()));
  view.el('btn-print').addEventListener('click', printDossier);
  view.el('btn-restart').addEventListener('click', () => location.reload());
}

/* --- 06 · BOOT ------------------------------------------------------------ */
async function boot() {
  try {
    const [settings, questions] = await Promise.all([
      loadJSON('config/settings.json'),
      loadJSON('config/questions.json')
    ]);

    const problems = validateConfig(settings, questions);
    if (problems.length) {
      view.overlay.bootError(
        'The portal could not start because the configuration is invalid.',
        problems.join('\n')
      );
      return;
    }

    CFG.settings = settings;
    CFG.questions = questions;
    CFG.modules = settings.modules;
    CFG.schemes = settings.schemes;
    CFG.maxScore = questions.reduce((sum, q) => sum + settings.schemes[q.scheme].correct, 0);

    initResponses();

    /* View + controller wiring */
    view.bindRenderer();
    engine.bindEngine();
    view.buildStaticUI();

    /* Session identity */
    S.sessionId = newSessionId();
    S.bootedAt = new Date().toISOString();
    Vault.set('qz.session', S.sessionId);
    view.paintSession(S.sessionId);

    /* Security layers */
    installSandbox({
      onLaunch: launchExam,
      onPrev: engine.prev,
      onNext: engine.next,
      onPick: engine.pick,
      onFlag: engine.toggleFlag
    });
    installMonitor();
    installProctor({ onCalibrationChange: evaluateGates });

    setStage('preflight');
    logEvent('info', 'BOOT', `Portal initialised · session ${S.sessionId} · build ${settings.meta.build}`);
    logEvent('info', 'BOOT',
      `Vault mode: ${Vault.available ? 'sessionStorage' : 'volatile in-memory fallback'}`);
    logEvent('info', 'BOOT',
      `Paper loaded · ${questions.length} items · ${CFG.maxScore} marks · ${settings.modules.length} modules`);

    wireControls();
    await runDiagnostics();
    evaluateGates();
  } catch (err) {
    console.error('[quizzitch] boot failed', err);

    const looksLikeFileProtocol = location.protocol === 'file:'
      || /Failed to fetch|NetworkError|Load failed/i.test(err.message || '');

    view.overlay.bootError(
      looksLikeFileProtocol
        ? 'The portal could not load its configuration files.'
        : 'The portal failed to start.',
      (err.stack || err.message || String(err))
      + (looksLikeFileProtocol
        ? '\n\nQuizzitch loads config/settings.json and config/questions.json over fetch(), which a browser '
          + 'blocks on the file:// protocol. Serve the folder over HTTP instead — for example '
          + '"python3 -m http.server 8000" or "npx serve" from the quizzitch-portal directory — then open '
          + 'http://localhost:8000.'
        : '')
    );
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

/* Exposed for console-side invigilation checks; harmless in production. */
window.QUIZZITCH = { CFG, S, bus, EV, engine, view, clockStamp };
