/* ==========================================================================
   QUIZZITCH — core/state.js
   Central reactive state manager, session store and event bus.
   ========================================================================== */

import { mmss, wallTime } from '../utils/timer.js';

/* --- 01 · CONFIGURATION --------------------------------------------------- */
export const CFG = {
  settings: null,       // parsed config/settings.json
  rawQuestions: [],   // entire 40+ item question bank from questions.json
  questions: [],      // randomized active session subset (e.g. 20 questions)
  modules: [],        // settings.modules
  schemes: {},        // settings.schemes
  letters: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']
};

export const scheme = (key) => CFG.schemes[key] || CFG.schemes.standard;
export const moduleOf = (catId) => CFG.modules[catId] || { code: '—', short: '—', name: '—' };

/* --- 02 · EVENT BUS ------------------------------------------------------- */
const channels = new Map();

export const bus = {
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
        console.error(`[quizzitch] listener failed on "${event}"`, err);
      }
    }
  }
};

export const EV = {
  STAGE: 'stage',            // 'preflight' | 'lounge' | 'live' | 'sealed'
  LOG: 'log',                // one security-log entry appended
  TOAST: 'toast',            // {title, body, kind, ttl}
  STRIKE: 'strike',          // {count, max, reason}
  LOCKOUT: 'lockout',        // {trigger}
  QUESTION: 'question',      // current item changed
  MATRIX: 'matrix',          // matrix cell states changed
  PROGRESS: 'progress',      // answered / flagged counts changed
  CLOCK: 'clock',            // {remaining, elapsed}
  LOUNGE_CLOCK: 'lounge_clock', // lounge countdown
  OPTIC: 'optic',            // optical telemetry sample
  OBJECT_DETECTED: 'object_detected', // AI object detection result
  GATES: 'gates',            // gate evaluation
  SEALED: 'sealed',          // dossier payload ready
  INTENT_NAV: 'intent:nav',
  INTENT_PICK: 'intent:pick',
  INTENT_MODULE: 'intent:module'
};

/* --- 03 · SESSION STATE --------------------------------------------------- */
export const S = {
  /* lifecycle */
  stage: 'preflight',        // preflight | lounge | live | sealed
  locked: false,
  degraded: false,
  sessionId: '',
  bootedAt: null,

  /* candidate credentials */
  candidate: {
    code: '',
    name: '',
    id: '',
    grade: '',
    school: ''
  },

  /* schedule */
  schedule: {
    loungeRemaining: 45,
    examRemaining: 2700,
    startTime: null,
    stopTime: null
  },

  /* optical & AI */
  stream: null,
  camLabel: '—',
  baseline: null,
  aiModelLoaded: false,
  detectedObjects: [],
  prohibitedDetections: 0,

  /* paper & questions */
  idx: 0,
  activeModule: 0,
  qEnterTs: 0,
  responses: [],             // [{ sel: [], selectedTexts: [], flagged: false, visits: 0, timeMs: 0 }]

  /* clock */
  clock: null,
  startTs: 0,
  remaining: 0,

  /* security & violations */
  strikes: 0,
  blurCount: 0,
  fsBreaches: 0,
  opticalFlags: 0,
  lastFocusTs: 0,
  log: [],

  /* verdict & submission */
  verdict: 'ACCEPTED',
  dqReason: '',
  submitReason: '',
  jotformSubmission: null,

  /* optical telemetry */
  optic: {
    luma: 0,
    motion: 0,
    stability: 99,
    faces: 1,
    gadget: false,
    frames: 0,
    box: null
  }
};

/**
 * Pools questions from raw bank (e.g. 5 per module, 20 total) and shuffles options.
 */
export function buildQuestionSession() {
  const poolCfg = CFG.settings.questionPool || { enabled: true, totalItemsPerSession: 20, itemsPerModule: 5 };
  const raw = CFG.rawQuestions || [];

  let selected = [];
  const modules = CFG.modules || [];

  if (poolCfg.enabled) {
    modules.forEach((mod) => {
      const inMod = raw.filter((q) => q.catId === mod.id);
      // Reshuffle questions only within this section/module
      const shuffled = (poolCfg.shuffleQuestions !== false)
        ? [...inMod].sort(() => Math.random() - 0.5)
        : [...inMod];
      const take = Math.min(shuffled.length, poolCfg.itemsPerModule || 5);
      selected.push(...shuffled.slice(0, take));
    });

    // If needed, supplement up to totalItemsPerSession
    if (selected.length < (poolCfg.totalItemsPerSession || 20)) {
      const remaining = raw.filter((q) => !selected.includes(q));
      remaining.sort(() => Math.random() - 0.5);
      selected.push(...remaining.slice(0, poolCfg.totalItemsPerSession - selected.length));
    }
  } else {
    // Group all by module in module order, shuffling only within each module
    modules.forEach((mod) => {
      const inMod = raw.filter((q) => q.catId === mod.id);
      const shuffled = (poolCfg.shuffleQuestions !== false)
        ? [...inMod].sort(() => Math.random() - 0.5)
        : [...inMod];
      selected.push(...shuffled);
    });
    const extra = raw.filter((q) => !selected.includes(q));
    selected.push(...extra);
  }

  // NOTE: Do NOT sort across modules — reshuffling is strictly within each section.

  // Shuffle options for each question while preserving option metadata
  CFG.questions = selected.map((q, i) => {
    const opts = (q.options || []).map((text, origIdx) => ({ text, origIdx }));
    if (poolCfg.shuffleOptions !== false) {
      opts.sort(() => Math.random() - 0.5);
    }
    return {
      id: q.id || `Q-${i + 1}`,
      catId: q.catId,
      scheme: q.scheme || 'standard',
      question: q.question,
      supplement: q.supplement || '',
      options: opts.map((o) => o.text),
      origOptionIndices: opts.map((o) => o.origIdx)
    };
  });

  initResponses();
}

/** Builds response ledger for the active session questions. */
export function initResponses() {
  S.responses = CFG.questions.map(() => ({
    sel: [],
    selectedTexts: [],
    flagged: false,
    visits: 0,
    timeMs: 0
  }));
}

/* --- 04 · SESSION VAULT --------------------------------------------------- */
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

export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0').toUpperCase();
}

export function newSessionId() {
  const t = Date.now().toString(36).toUpperCase();
  const r = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `QZ-${t}-${r}`;
}

export function clockStamp() {
  return S.clock ? S.clock.format() : '00:00';
}

/* --- 06 · SECURITY LOGGING & STRIKES -------------------------------------- */
export function logEvent(level, category, message, data = null) {
  const entry = {
    seq: S.log.length + 1,
    iso: new Date().toISOString(),
    wall: wallTime(),
    clock: clockStamp(),
    level,
    category,
    message,
    data
  };
  S.log.push(entry);
  bus.emit(EV.LOG, entry);
  return entry;
}

export function registerStrike(reason) {
  if (S.locked) return;
  const max = (CFG.settings && CFG.settings.security && CFG.settings.security.maxStrikes) || 3;
  S.strikes += 1;

  logEvent('crit', 'STRIKE', `Strike ${S.strikes} of ${max}: ${reason}`);
  bus.emit(EV.STRIKE, { count: S.strikes, max, reason });

  if (S.strikes >= max) {
    lockout(`Max strikes exceeded (${reason})`);
  } else {
    toast(`Security Alert (${S.strikes}/${max})`, `${reason}`, 'danger', 7000);
  }
}

export function lockout(trigger) {
  if (S.locked) return;
  S.locked = true;
  S.verdict = 'DISQUALIFIED';
  S.dqReason = trigger;
  logEvent('crit', 'LOCKOUT', `Assessment Locked: ${trigger}`);
  bus.emit(EV.LOCKOUT, { trigger });
}

export function setStage(stage) {
  if (S.stage === stage) return;
  S.stage = stage;
  document.body.className = `stage-${stage}`;
  document.body.setAttribute('data-stage', stage);
  bus.emit(EV.STAGE, stage);
}

export function toast(title, body, kind = 'info', ttl = 4500) {
  bus.emit(EV.TOAST, { title, body, kind, ttl });
}

export function commitDwell() {
  if (!S.qEnterTs || S.idx == null || !S.responses[S.idx]) return;
  const now = performance.now();
  S.responses[S.idx].timeMs += Math.round(now - S.qEnterTs);
  S.qEnterTs = now;
}

export const answeredCount = () => S.responses.filter((r) => r && r.sel && r.sel.length > 0).length;
export const flaggedCount = () => S.responses.filter((r) => r && r.flagged).length;
