/* ==========================================================================
   QUIZZITCH — session.js
   Session state, event bus and the Security Audit Ledger.

   Everything here lives in ES-module scope: nothing is attached to `window`,
   so the browser console has no reference to reach the state through.
   Configuration and the question paper are deep-frozen; the whole state tree
   is frozen at seal time so nothing can be altered after the checksum.
   ========================================================================== */

import { deepFreeze } from './util.js';

export const Stage = Object.freeze({
  SIGNIN: 'signin',
  CALIBRATE: 'calibrate',
  PROTOCOL: 'protocol',
  EXAM: 'exam',
  SEALED: 'sealed'
});

/** 0 = informational, 1 = advisory (amber, logged), 2 = strike (red). */
export const Level = Object.freeze({ INFO: 0, ADVISORY: 1, STRIKE: 2 });

/* --- 01 · EVENT BUS ------------------------------------------------------- */
const channels = new Map();

export const bus = Object.freeze({
  on(event, fn) {
    if (!channels.has(event)) channels.set(event, new Set());
    channels.get(event).add(fn);
    return () => channels.get(event).delete(fn);
  },
  emit(event, payload) {
    const set = channels.get(event);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try { fn(payload); } catch (err) { console.error(`[bus] "${event}" listener failed`, err); }
    }
  }
});

export const EV = Object.freeze({
  STAGE: 'stage',
  INCIDENT: 'incident',
  STATUS: 'status',          // proctor status LED: secure | warning | flagged
  LOCKOUT: 'lockout',
  QUESTION: 'question',
  ANSWERS: 'answers',
  CLOCK: 'clock',
  CONTROL: 'control',
  FULLSCREEN: 'fullscreen',
  TOAST: 'toast'
});

/* --- 02 · STATE ----------------------------------------------------------- */
let settings = null;
let serverNow = () => Date.now();
let startedAt = null;

export function bindSettings(s) { settings = s; }
export const cfg = () => settings;
export function setClockSource(fn) { serverNow = fn; }
export const now = () => serverNow();

export const S = {
  stage: 'boot',
  sessionId: '',
  uid: '',
  salt: '',
  identityKey: '',
  candidate: { schoolUid: '', teamId: '', name: '', division: '', schoolName: '', rosterVerified: false },

  baseline: null,            // { photo, pose: {yaw, pitch}, noise, capturedAt }
  paper: [],                 // frozen question objects for this candidate
  answers: [],               // [{ sel: number[], marked, visits, timeMs }]
  idx: 0,
  enteredAt: 0,              // performance.now() when the current question was opened

  examStartedAt: null,       // server ms (authoritative)
  examEndAt: null,           // server ms (authoritative)
  clockSource: '',

  strikes: 0,
  advisories: {},            // type → count
  lastAdvisoryAt: 0,
  ledger: [],
  thumbs: [],                // incident thumbnails [{ seq, type, dataUrl, t }]
  resumes: 0,

  status: 'secure',
  locked: false,
  verdict: 'CLEAN',
  submitReason: '',
  sealed: null               // sealed package, once built
};

export function setStage(stage) {
  if (S.stage === stage) return;
  S.stage = stage;
  document.body.dataset.stage = stage;
  bus.emit(EV.STAGE, stage);
}

export function markExamStart(ms) { startedAt = ms; S.examStartedAt = ms; }
const elapsedSec = () => (startedAt ? Math.max(0, Math.round((now() - startedAt) / 1000)) : 0);

export function toast(title, body, kind = 'info', ttl = 4500) {
  bus.emit(EV.TOAST, { title, body, kind, ttl });
}

/* --- 03 · SECURITY AUDIT LEDGER ------------------------------------------- */
const LEDGER_CAP = 2000;
const lastByType = new Map();

/**
 * Appends to the ledger and applies the strike policy.
 *   level 1 advisories escalate to a strike every `advisoriesPerStrike` of one type;
 *   level 2 is a strike; reaching `maxStrikes` locks the paper and forces submission.
 * @param {{type:string, level:number, message:string, data?:object, cooldownMs?:number, thumb?:string}} inc
 * @returns the ledger entry, or null when suppressed by cooldown / lock
 */
export function recordIncident(inc) {
  if (S.stage === Stage.SEALED && inc.level > Level.INFO) return null;
  const t = now();
  if (inc.cooldownMs) {
    const last = lastByType.get(inc.type) || 0;
    if (t - last < inc.cooldownMs) return null;
    lastByType.set(inc.type, t);
  }

  const entry = {
    seq: S.ledger.length + 1,
    t,
    elapsed: elapsedSec(),
    type: inc.type,
    level: inc.level,
    message: inc.message,
    data: inc.data || null
  };
  if (S.ledger.length < LEDGER_CAP) S.ledger.push(entry);

  const sec = settings ? settings.security : { maxStrikes: 3, advisoriesPerStrike: 3 };
  const live = S.stage === Stage.EXAM && !S.locked;

  const NON_ESCALATING = new Set(['WINDOW_BLUR', 'GAZE_EVASION', 'DEVICE_FREEZE', 'POSE_UNKNOWN']);

  if (live && inc.level === Level.ADVISORY) {
    S.advisories[inc.type] = (S.advisories[inc.type] || 0) + 1;
    S.lastAdvisoryAt = t;
    bus.emit(EV.INCIDENT, entry);
    if (!NON_ESCALATING.has(inc.type) && S.advisories[inc.type] % sec.advisoriesPerStrike === 0) {
      recordIncident({
        type: `${inc.type}_ESCALATED`,
        level: Level.STRIKE,
        message: `${sec.advisoriesPerStrike} advisories of ${inc.type} escalated to a strike`
      });
    }
  } else if (live && inc.level === Level.STRIKE) {
    S.strikes += 1;
    entry.strike = S.strikes;
    bus.emit(EV.INCIDENT, entry);
    if (S.strikes >= sec.maxStrikes) {
      S.locked = true;
      S.verdict = 'DISQUALIFIED';
      bus.emit(EV.LOCKOUT, { reason: `MAX_STRIKES (${entry.type})` });
    }
  } else {
    bus.emit(EV.INCIDENT, entry);
  }
  refreshStatus();
  return entry;
}

/** Proctor status LED: flagged once any strike exists, warning for 60 s after an advisory. */
export function refreshStatus() {
  const next = S.strikes > 0 ? 'flagged'
    : (S.lastAdvisoryAt && now() - S.lastAdvisoryAt < 60000) ? 'warning'
    : 'secure';
  if (next !== S.status) {
    S.status = next;
    bus.emit(EV.STATUS, next);
  }
}

export function attachThumb(entry, dataUrl) {
  const cap = settings ? settings.proctoring.incidentThumbs : 12;
  if (!entry || !dataUrl || S.thumbs.length >= cap) return;
  S.thumbs.push({ seq: entry.seq, type: entry.type, level: entry.level, t: entry.t, dataUrl });
}

/* --- 04 · COUNTS ---------------------------------------------------------- */
export const isAnswered = (a) => !!a && a.sel.length > 0;
export const answeredCount = () => S.answers.filter(isAnswered).length;
export const markedCount = () => S.answers.filter((a) => a.marked).length;
export const unansweredCount = () => S.answers.length - answeredCount();

/* --- 05 · CRASH-RECOVERY SNAPSHOT ----------------------------------------- */
const SNAP_KEY = 'qz.session.v2';

/** Persists enough to resume after a reload or browser crash. Never contains the answer key (there is none client-side). */
export function persist() {
  if (!S.identityKey || S.stage === Stage.SEALED) return;
  try {
    localStorage.setItem(SNAP_KEY, JSON.stringify({
      v: 2,
      identityKey: S.identityKey,
      sessionId: S.sessionId,
      uid: S.uid,
      salt: S.salt,
      candidate: S.candidate,
      stage: S.stage,
      answers: S.answers,
      idx: S.idx,
      strikes: S.strikes,
      advisories: S.advisories,
      ledger: S.ledger.slice(-600),
      examStartedAt: S.examStartedAt,
      resumes: S.resumes,
      savedAt: Date.now()
    }));
  } catch (_) { /* storage full or blocked — resume simply won't be offered */ }
}

export function loadSnapshot() {
  try {
    const raw = localStorage.getItem(SNAP_KEY);
    const snap = raw ? JSON.parse(raw) : null;
    return snap && snap.v === 2 ? snap : null;
  } catch (_) {
    return null;
  }
}

export function clearSnapshot() {
  try { localStorage.removeItem(SNAP_KEY); } catch (_) { /* no-op */ }
}

/** After sealing, the state tree becomes immutable. */
export function freezeState() {
  deepFreeze(S.candidate);
  deepFreeze(S.answers);
  deepFreeze(S.ledger);
  Object.freeze(S.advisories);
}
