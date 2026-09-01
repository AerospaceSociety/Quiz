/* ==========================================================================
   QUIZZITCH — core/state.js
   Central reactive state manager, session store and event bus.

   Nothing in this module touches the DOM. Views subscribe to `bus` events and
   repaint; controllers mutate `S` and announce the change. Keeping the two
   directions separate is what makes the portal testable and editable.
   ========================================================================== */

import { mmss, wallTime } from '../utils/timer.js';

/* --- 01 · CONFIGURATION (populated by core/app.js at boot) ---------------- */
export const CFG = {
  settings: null,   // parsed config/settings.json
  questions: [],    // parsed config/questions.json
  modules: [],      // settings.modules
  schemes: {},      // settings.schemes
  maxScore: 0,      // sum of every item's `correct` value
  letters: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']
};

/** Convenience accessors used everywhere. */
export const scheme = (key) => CFG.schemes[key] || CFG.schemes.standard;
export const moduleOf = (catId) => CFG.modules[catId] || { code: '—', short: '—', name: '—' };

/* --- 02 · EVENT BUS ------------------------------------------------------- */
const channels = new Map();

export const bus = {
  /** Subscribe. Returns an unsubscribe function. */
  on(event, fn) {
    if (!channels.has(event)) channels.set(event, new Set());
    channels.get(event).add(fn);
    return () => bus.off(event, fn);
  },
  off(event, fn) {
    const set = channels.get(event);
    if (set) set.delete(fn);
  },
  emit(event, payload) {
    const set = channels.get(event);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try {
        fn(payload);
      } catch (err) {
        // A listener must never be able to break the exam loop.
        console.error(`[quizzitch] listener failed on "${event}"`, err);
      }
    }
  }
};

/* Event names, centralised so a typo fails loudly rather than silently. */
export const EV = {
  STAGE: 'stage',            // 'preflight' | 'live' | 'sealed'
  LOG: 'log',                // one security-log entry appended
  TOAST: 'toast',            // {title, body, kind, ttl}
  STRIKE: 'strike',          // {count, max, reason}
  LOCKOUT: 'lockout',        // {trigger}
  QUESTION: 'question',      // current item changed
  MATRIX: 'matrix',          // matrix cell states changed
  PROGRESS: 'progress',      // answered / flagged counts changed
  CLOCK: 'clock',            // {remaining, elapsed}
  OPTIC: 'optic',            // optical telemetry sample
  GATES: 'gates',            // pre-flight gate evaluation
  DIAG: 'diag',              // one diagnostic probe resolved
  SEALED: 'sealed',          // dossier payload ready
  // Intents raised by the view layer, consumed by quiz/engine.js
  INTENT_NAV: 'intent:nav',        // absolute item index
  INTENT_PICK: 'intent:pick',      // option index
  INTENT_MODULE: 'intent:module'   // module (catId)
};

/* --- 03 · SESSION STATE --------------------------------------------------- */
export const S = {
  /* lifecycle */
  stage: 'preflight',        // preflight | live | sealed
  locked: false,
  degraded: false,           // running without an optical link
  sessionId: '',
  bootedAt: null,

  /* candidate */
  candidate: { name: '', id: '', grade: '', school: '' },

  /* optical */
  stream: null,
  camLabel: '—',
  baseline: null,

  /* paper */
  idx: 0,
  activeModule: 0,
  qEnterTs: 0,
  responses: [],

  /* clock */
  clock: null,               // countdown instance from utils/timer.js
  startTs: 0,
  remaining: 0,

  /* security */
  strikes: 0,
  blurCount: 0,
  fsBreaches: 0,
  opticalFlags: 0,
  lastFocusTs: 0,
  log: [],

  /* verdict */
  verdict: 'ACCEPTED',
  dqReason: '',
  submitReason: '',

  /* diagnostics */
  diag: {},
  diagFails: 0,

  /* optical telemetry accumulator */
  optic: {
    luma: 0,
    motion: 0,
    edges: 0,
    stability: 99,
    faces: 1,
    gadget: false,
    frames: 0,
    presencePct: 0,
    presenceSum: 0,
    stabilitySum: 0,
    absenceRun: 0,
    multiRun: 0,
    gadgetRun: 0,
    box: null,
    metrics: { fill: 0, aspect: 0, area: 0, brightRatio: 0 },
    cooldown: { absent: 0, multi: 0, gadget: 0 },
    counts: { absent: 0, multi: 0, gadget: 0 }
  }
};

/** Builds a blank response ledger sized to the loaded question bank. */
export function initResponses() {
  S.responses = CFG.questions.map(() => ({
    sel: [],
    flagged: false,
    visits: 0,
    timeMs: 0
  }));
}

/* --- 04 · SESSION VAULT --------------------------------------------------- */
/* sessionStorage where available, volatile in-memory fallback otherwise
   (file:// origins and hardened privacy modes block web storage outright). */
export const Vault = (() => {
  let usable = true;
  const mem = Object.create(null);

  try {
    sessionStorage.setItem('__qz_probe', '1');
    sessionStorage.removeItem('__qz_probe');
  } catch (_) {
    usable = false;
  }

  return {
    get available() { return usable; },
    set(key, value) {
      try {
        if (usable) sessionStorage.setItem(key, value);
        else mem[key] = value;
      } catch (_) {
        usable = false;
        mem[key] = value;
      }
    },
    get(key) {
      try {
        return usable ? sessionStorage.getItem(key) : (key in mem ? mem[key] : null);
      } catch (_) {
        return key in mem ? mem[key] : null;
      }
    },
    remove(key) {
      try {
        if (usable) sessionStorage.removeItem(key);
        else delete mem[key];
      } catch (_) { /* no-op */ }
    }
  };
})();

/* --- 05 · SHARED PRIMITIVES ---------------------------------------------- */
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** FNV-1a 32-bit — a short, deterministic integrity tag for the dossier. */
export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ('00000000' + h.toString(16)).slice(-8).toUpperCase();
}

export function newSessionId() {
  return 'QZ' + Date.now().toString(36).toUpperCase().slice(-6)
       + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
}

/* --- 06 · CLOCK HELPERS --------------------------------------------------- */
export function elapsedSeconds() {
  return S.startTs ? (Date.now() - S.startTs) / 1000 : 0;
}

/** "T‑45:00" before launch, "T+07:22" once the paper is running. */
export function clockStamp() {
  if (!S.startTs) return 'T‑' + mmss(CFG.settings ? CFG.settings.exam.durationSeconds : 0);
  return 'T+' + mmss(elapsedSeconds());
}

/* --- 07 · SECURITY LOG ---------------------------------------------------- */
/**
 * Appends a timestamped entry to the permanent incident ledger.
 * @param {'info'|'ok'|'scan'|'warn'|'crit'} severity
 * @param {string} cls   short event class, e.g. 'FOCUS', 'DISPLAY', 'OPTICAL'
 * @param {string} message
 * @param {boolean} [isStrike]
 */
export function logEvent(severity, cls, message, isStrike = false) {
  const entry = {
    clock: clockStamp(),
    wall: wallTime(),
    iso: new Date().toISOString(),
    sev: severity,
    cls,
    msg: message,
    strike: !!isStrike
  };
  S.log.push(entry);
  bus.emit(EV.LOG, entry);
  return entry;
}

/** Raises a transient notification. */
export function toast(title, body, kind = '', ttl = 6000) {
  bus.emit(EV.TOAST, { title, body, kind, ttl });
}

/* --- 08 · STRIKE LEDGER --------------------------------------------------- */
/**
 * Records one security strike. On reaching the configured maximum this emits
 * EV.LOCKOUT; quiz/engine.js owns the consequence (seal + force-submit).
 */
export function registerStrike(cls, reason) {
  if (S.locked) return S.strikes;

  const max = CFG.settings.security.maxStrikes;
  S.strikes += 1;

  logEvent('crit', cls, `${reason} → security strike ${S.strikes}/${max}`, true);
  bus.emit(EV.STRIKE, { count: S.strikes, max, reason });
  toast(`Security strike ${S.strikes}/${max}`, reason, 'danger', 8000);

  if (S.strikes >= max) {
    bus.emit(EV.LOCKOUT, { trigger: `${cls} — ${reason}` });
  }
  return S.strikes;
}

/* --- 09 · DERIVED COUNTS -------------------------------------------------- */
export const answeredCount = () => S.responses.filter((r) => r.sel.length > 0).length;
export const flaggedCount = () => S.responses.filter((r) => r.flagged).length;

/** Commits the dwell time accrued on the current item. */
export function commitDwell() {
  if (!S.qEnterTs) return;
  S.responses[S.idx].timeMs += performance.now() - S.qEnterTs;
  S.qEnterTs = 0;
}

/* --- 10 · STAGE ROUTER SIGNAL -------------------------------------------- */
export function setStage(stage) {
  S.stage = stage;
  document.body.dataset.stage = stage;
  document.body.className = `stage-${stage}`;
  bus.emit(EV.STAGE, stage);
}
