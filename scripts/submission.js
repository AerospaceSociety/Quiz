/* ==========================================================================
   QUIZZITCH — submission.js
   Live telemetry (heartbeat + rate-limited incident events), the sealed
   submission package with its salted SHA-256 checksum, dispatch to Firebase
   (system of record, with an offline retry outbox) and Jotform (mirror), and
   the printable receipt.

   Network economy: the heartbeat carries only a few state flags. Informational
   ledger lines stay in memory and travel once, inside the final package.
   ========================================================================== */

import { S, cfg, bus, EV, Stage, Level, now, answeredCount, markedCount, unansweredCount, persist } from './session.js';
import { responseItems, moduleProgress } from './engine.js';
import * as fb from './firebase.js';
import { sha256Hex, canonicalJSON, randomHex } from './util.js';

const OUTBOX = 'qz.outbox.v2';
const OUTBOX_SUBMISSION_KEYS = new Set(['v', 'uid', 'sessionId', 'paperId', 'candidate', 'identityKey', 'reason', 'verdict', 'strikes', 'advisories', 'startedAt', 'sealedAt', 'elapsedSec', 'clockSource', 'resumes', 'total', 'answered', 'unanswered', 'marked', 'modules', 'items', 'salt', 'checksum', 'checksumAlgo']);
const OUTBOX_CANDIDATE_KEYS = new Set(['schoolUid', 'teamId', 'memberId', 'name', 'division', 'schoolName', 'rosterVerified', 'isIndividual', 'consentVersion', 'consentAt']);
const OUTBOX_ITEM_KEYS = new Set(['n', 'id', 'catId', 'scheme', 'displayed', 'selected', 'original', 'text', 'marked', 'visits', 'seconds']);
const OUTBOX_MODULE_KEYS = new Set(['id', 'code', 'answered', 'total']);
const LIVE_EVENTS = new Set(['SIGNED_IN', 'EXAM_STARTED', 'SESSION_RESUMED', 'SUBMITTED', 'CLOCK_ANOMALY']);

let heartbeat = null;
let pushTimer = null;
let closed = false;          // set at seal: the sealing batch owns the final session write
let eventSeq = 0;            // capped at 80 (0..79)
let lastWrittenSessionDigest = '';
const advisoryBuffer = [];
const lastAdvisoryByType = new Map();

function sessionDigest(p) {
  return `${p.stage}|${p.status}|${p.strikes}|${p.advisories}|${p.answered}|${p.marked}|${p.currentQ}|${p.fullscreen}|${p.lastEvent}`;
}

async function sendEvent(doc) {
  if (eventSeq >= 80) return;
  const uid = S.uid || (fb.currentUser() && fb.currentUser().uid);
  if (!uid) return;
  const id = randomHex(16);
  eventSeq++;
  await fb.writeEvent(id, doc);
}

export async function flushAdvisories() {
  while (advisoryBuffer.length && eventSeq < 80) {
    const adv = advisoryBuffer.shift();
    await sendEvent(eventDoc(adv, null));
  }
}

/* --- 01 · TELEMETRY ------------------------------------------------------- */
export function sessionPatch() {
  return {
    sessionId: S.sessionId,
    identityKey: S.identityKey,
    schoolUid: S.candidate.schoolUid,
    teamId: S.candidate.teamId,
    name: S.candidate.name,
    attemptedBy: S.candidate.attemptedBy || S.candidate.name,
    division: S.candidate.division,
    schoolName: S.candidate.schoolName || '',
    stage: S.stage,
    status: S.stage === Stage.SEALED ? 'submitted' : S.status,
    strikes: S.strikes,
    advisories: Object.values(S.advisories).reduce((a, b) => a + b, 0),
    answered: S.paper.length ? answeredCount() : 0,
    marked: S.paper.length ? markedCount() : 0,
    total: S.paper.length,
    currentQ: S.paper.length ? S.idx + 1 : 0,
    fullscreen: !!document.fullscreenElement,
    lastEvent: S.ledger.length ? S.ledger[S.ledger.length - 1].type : '',
    consentVersion: (S.candidate && S.candidate.consentVersion) || (cfg().security ? cfg().security.consentVersion : '2026.1-DPDP-DRAFT'),
    consentAt: (S.candidate && S.candidate.consentAt) || null,
    clientTs: now()
  };
}

/** Coalesces bursts of state changes into one write only if state actually changed. */
export function pushSoon(delay = 2000) {
  if (closed || !heartbeat) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    if (closed) return;
    const p = sessionPatch();
    const d = sessionDigest(p);
    if (d !== lastWrittenSessionDigest) {
      lastWrittenSessionDigest = d;
      fb.writeSession(p);
    }
  }, delay);
}

export async function startTelemetry() {
  if (heartbeat || closed) return true;
  const initial = sessionPatch();
  lastWrittenSessionDigest = sessionDigest(initial);
  const initialSaved = await fb.writeSession(initial);
  if (fb.isReady() && !initialSaved) {
    closed = false;
    return false;
  }

  heartbeat = setInterval(() => {
    if (closed) return;
    const p = sessionPatch();
    lastWrittenSessionDigest = sessionDigest(p);
    fb.writeSession(p);
    flushAdvisories();
  }, cfg().telemetry.heartbeatSeconds * 1000);

  bus.on(EV.STATUS, () => pushSoon(500));
  bus.on(EV.STAGE, () => pushSoon(0));
  return true;
}

/** Must run before the stage flips to SEALED, so no heartbeat can race the sealing batch. */
export function stopTelemetry() {
  closed = true;
  clearInterval(heartbeat);
  clearTimeout(pushTimer);
  heartbeat = null;
}

function eventDoc(entry, thumb) {
  return {
    identityKey: S.identityKey,
    sessionId: S.sessionId,
    schoolUid: S.candidate.schoolUid,
    teamId: S.candidate.teamId,
    name: S.candidate.name,
    division: S.candidate.division,
    type: entry.type,
    level: entry.level,
    message: entry.message,
    strikes: S.strikes,
    elapsed: entry.elapsed,
    clientTs: entry.t,
    ...(thumb ? { thumb } : {})
  };
}

/**
 * Forwards ledger entries to the live admin feed:
 *   strikes always (with a thumbnail when one exists, written immediately),
 *   advisories buffered and deduped within 10s, flushed on heartbeat and seal,
 *   informational entries only for lifecycle milestones.
 */
export function wireEventStream(getThumb) {
  bus.on(EV.INCIDENT, (entry) => {
    if (entry.level === Level.INFO) {
      if (LIVE_EVENTS.has(entry.type)) {
        sendEvent(eventDoc(entry, null));
        pushSoon(200);
      }
      return;
    }

    if (entry.level === Level.ADVISORY) {
      const last = lastAdvisoryByType.get(entry.type) || 0;
      if (entry.t - last >= 10000) {
        lastAdvisoryByType.set(entry.type, entry.t);
        advisoryBuffer.push(entry);
      }
      pushSoon(2000);
      return;
    }

    if (entry.level === Level.STRIKE) {
      sendEvent(eventDoc(entry, getThumb ? getThumb() : null));
      const p = sessionPatch();
      lastWrittenSessionDigest = sessionDigest(p);
      fb.writeSession(p);
      persist();
    }
  });
}

/* --- 02 · SEALED PACKAGE -------------------------------------------------- */
function deviceInfo() {
  return {
    ua: navigator.userAgent.slice(0, 200),
    cores: navigator.hardwareConcurrency || 0,
    memoryGb: navigator.deviceMemory || 0,
    screen: `${screen.width}x${screen.height}@${window.devicePixelRatio}`,
    extendedDisplay: !!(screen.isExtended)
  };
}

/** Keeps the forensic document under 500KB and caps at 8 thumbnails. */
export function fitForensics(doc) {
  const limit = 500 * 1024;
  if (doc.thumbs && doc.thumbs.length > 8) {
    doc.thumbs = doc.thumbs.slice(0, 8);
  }
  let size = JSON.stringify(doc).length;
  while (size > limit && doc.thumbs && doc.thumbs.length) {
    doc.thumbs.pop();
    size = JSON.stringify(doc).length;
  }
  if (size > limit && doc.ledger) {
    doc.ledger = doc.ledger.filter((e) => e.level > Level.INFO);
    doc.ledgerTruncated = true;
    size = JSON.stringify(doc).length;
  }
  while (size > limit && doc.ledger && doc.ledger.length > 50) {
    doc.ledger.pop();
    size = JSON.stringify(doc).length;
  }
  return doc;
}

/**
 * The checksum covers `body` (everything in the submission except the
 * checksum itself): SHA-256( salt + "|" + canonicalJSON(body) ).
 * The salt is a per-session random nonce stored with the record so an
 * invigilator can recompute and verify it.
 */
export async function buildPackage(reason) {
  const s = cfg();
  const items = responseItems();
  const body = {
    v: 3,
    uid: S.uid || fb.currentUid(),
    sessionId: S.sessionId,
    paperId: s.meta.paperId,
    candidate: { ...S.candidate },
    identityKey: S.identityKey,
    reason,
    verdict: S.verdict,
    strikes: S.strikes,
    advisories: { ...S.advisories },
    startedAt: S.examStartedAt,
    sealedAt: now(),
    elapsedSec: S.examStartedAt ? Math.round((now() - S.examStartedAt) / 1000) : 0,
    clockSource: S.clockSource,
    resumes: S.resumes,
    total: S.paper.length,
    answered: answeredCount(),
    unanswered: unansweredCount(),
    marked: markedCount(),
    modules: moduleProgress().map((p) => ({ id: p.module.id, code: p.module.code, answered: p.answered, total: p.total })),
    items,
    salt: S.salt
  };
  const checksum = await sha256Hex(`${S.salt}|${canonicalJSON(body)}`);

  const forensics = fitForensics({
    sessionId: S.sessionId,
    baseline: !S.stillsPurged && S.baseline ? { photo: S.baseline.photo, pose: S.baseline.pose, noise: S.baseline.noise, light: S.baseline.light, camera: S.baseline.camera, capturedAt: S.baseline.capturedAt } : null,
    thumbs: S.stillsPurged ? [] : S.thumbs.slice(),
    ledger: S.ledger.map((e) => ({ ...e })),
    ledgerTruncated: false,
    device: deviceInfo(),
    checksum
  });

  return { submission: { ...body, checksum, checksumAlgo: 'SHA-256(salt|canonicalJSON(body))' }, forensics, checksum };
}

/* --- 03 · DISPATCH -------------------------------------------------------- */
export function readOutbox() {
  let stored;
  try {
    const raw = localStorage.getItem(OUTBOX) || 'null';
    if (raw.length > 700 * 1024) throw new Error('Stored retry package is oversized');
    stored = JSON.parse(raw);
  }
  catch (_) {
    try { localStorage.removeItem(OUTBOX); } catch (_) {}
    return null;
  }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored) || !stored.submission || typeof stored.submission !== 'object') {
    try { localStorage.removeItem(OUTBOX); } catch (_) {}
    return null;
  }
  if (!safeOutboxSubmission(stored.submission)) {
    try { localStorage.removeItem(OUTBOX); } catch (_) {}
    return null;
  }
  const sanitized = prepareOutboxPackage(stored);
  try { localStorage.setItem(OUTBOX, JSON.stringify(sanitized)); }
  catch (_) {
    try { localStorage.setItem(OUTBOX, JSON.stringify(minimalOutboxPackage(sanitized))); }
    catch (_) { try { localStorage.removeItem(OUTBOX); } catch (_) {} }
  }
  return sanitized;
}

function safeOutboxSubmission(submission) {
  if (!submission || typeof submission !== 'object' || Array.isArray(submission)
    || Object.keys(submission).some((key) => !OUTBOX_SUBMISSION_KEYS.has(key))) return false;
  const candidate = submission.candidate;
  if (candidate && (typeof candidate !== 'object' || Array.isArray(candidate)
    || Object.keys(candidate).some((key) => !OUTBOX_CANDIDATE_KEYS.has(key)))) return false;
  if (submission.items != null && (!Array.isArray(submission.items) || submission.items.some((item) => !item
    || typeof item !== 'object' || Array.isArray(item)
    || Object.keys(item).some((key) => !OUTBOX_ITEM_KEYS.has(key))))) return false;
  if (submission.modules != null && (!Array.isArray(submission.modules) || submission.modules.some((module) => !module
    || typeof module !== 'object' || Array.isArray(module)
    || Object.keys(module).some((key) => !OUTBOX_MODULE_KEYS.has(key))))) return false;
  if (submission.advisories != null && (!submission.advisories || typeof submission.advisories !== 'object' || Array.isArray(submission.advisories)
    || Object.values(submission.advisories).some((count) => !Number.isSafeInteger(count) || count < 0))) return false;
  const pending = [submission];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'string' && /data:image\//i.test(value)) return false;
    if (Array.isArray(value)) value.forEach((item) => pending.push(item));
    else if (value && typeof value === 'object') Object.values(value).forEach((item) => pending.push(item));
  }
  return true;
}

export function prepareOutboxPackage(pkg) {
  if (!pkg) return null;
  const forensic = pkg.forensics;
  const text = (value, max) => typeof value === 'string' && !/data:image\//i.test(value) ? value.slice(0, max) : '';
  const number = (value, min, max) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Number(value))) : 0;
  return {
    checksum: typeof pkg.checksum === 'string' && /^[a-f0-9]{64}$/i.test(pkg.checksum) ? pkg.checksum : '',
    submission: pkg.submission,
    forensics: forensic ? {
      sessionId: text(forensic.sessionId, 80),
      checksum: typeof forensic.checksum === 'string' && /^[a-f0-9]{64}$/i.test(forensic.checksum) ? forensic.checksum : '',
      baseline: forensic.baseline ? {
        pose: forensic.baseline.pose && typeof forensic.baseline.pose === 'object' ? {
          yaw: number(forensic.baseline.pose.yaw, -180, 180),
          pitch: number(forensic.baseline.pose.pitch, -180, 180)
        } : null,
        noise: number(forensic.baseline.noise, 0, 1000),
        capturedAt: number(forensic.baseline.capturedAt, 0, Date.now())
      } : null,
      thumbs: [],
      ledger: safeOutboxLedger(forensic.ledger),
      ledgerTruncated: forensic.ledgerTruncated === true,
      device: forensic.device ? {
        ua: text(forensic.device.ua, 200),
        cores: number(forensic.device.cores, 0, 128),
        memoryGb: number(forensic.device.memoryGb, 0, 1024),
        screen: text(forensic.device.screen, 40),
        extendedDisplay: forensic.device.extendedDisplay === true
      } : {},
      updatedAt: number(forensic.updatedAt, 0, Date.now())
    } : null
  };
}

function safeOutboxLedger(entries, strikesOnly = false) {
  if (!Array.isArray(entries)) return [];
  return entries.filter((entry) => entry && typeof entry === 'object' && (!strikesOnly || entry.level >= Level.STRIKE))
    .slice(-600).map((entry) => ({
      seq: Number.isSafeInteger(entry.seq) ? Math.max(0, Math.min(100000, entry.seq)) : 0,
      t: Number.isFinite(Number(entry.t)) ? Math.max(0, Number(entry.t)) : 0,
      elapsed: Number.isFinite(Number(entry.elapsed)) ? Math.max(0, Math.min(86400, Number(entry.elapsed))) : 0,
      type: typeof entry.type === 'string' && !/data:image\//i.test(entry.type) ? entry.type.slice(0, 100) : '',
      level: [0, 1, 2].includes(entry.level) ? entry.level : 0,
      message: typeof entry.message === 'string' && !/data:image\//i.test(entry.message) ? entry.message.slice(0, 500) : '',
      ...(Number.isSafeInteger(entry.strike) ? { strike: entry.strike } : {})
    }));
}

export function minimalOutboxPackage(pkg) {
  return {
    checksum: pkg.checksum,
    submission: pkg.submission,
    forensics: {
      sessionId: pkg.submission ? pkg.submission.sessionId : '',
      checksum: pkg.checksum,
      thumbs: [],
      ledger: safeOutboxLedger(pkg.forensics && pkg.forensics.ledger, true)
    }
  };
}

function stripLocalStills(pkg) {
  if (!pkg?.forensics) return;
  if (pkg.forensics.baseline) delete pkg.forensics.baseline.photo;
  pkg.forensics.thumbs = [];
}

function writeOutbox(v) {
  if (!v) {
    try { localStorage.removeItem(OUTBOX); } catch (_) {}
    return;
  }
  try {
    const stripped = prepareOutboxPackage(v);
    localStorage.setItem(OUTBOX, JSON.stringify(stripped));
  } catch (err) {
    console.warn('[submission] localStorage outbox quota exceeded, trying minimal outbox:', err.message);
    try {
      const minimal = minimalOutboxPackage(v);
      localStorage.setItem(OUTBOX, JSON.stringify(minimal));
    } catch (err2) {
      console.warn('[submission] minimal localStorage outbox write failed:', err2.message);
    }
  }
}

async function commitToFirebase(pkg) {
  try { await flushAdvisories(); } catch (_) { /* non-blocking */ }
  await fb.commitSubmission({
    submission: pkg.submission,
    forensics: pkg.forensics,
    session: { ...sessionPatch(), stage: Stage.SEALED, status: 'submitted', checksum: pkg.checksum },
    identityKey: S.identityKey
  });
}

/**
 * @returns {{firebase:'recorded'|'queued'|'offline-mode', jotform:'dispatched'|'failed'|'disabled'}}
 */
export async function dispatch(pkg, onRetrySuccess) {
  const status = { firebase: 'offline-mode', jotform: 'disabled' };

  try {
    if (fb.isReady()) {
      try {
        await commitToFirebase(pkg);
        status.firebase = 'recorded';
        writeOutbox(null);
      } catch (err) {
        console.warn('[submission] firebase commit failed, queued for retry:', err.message);
        const retryPackage = prepareOutboxPackage(pkg);
        writeOutbox(pkg);
        status.firebase = 'queued';
        scheduleRetry(retryPackage, onRetrySuccess);
      }
    }
  } finally {
    stripLocalStills(pkg);
  }

  if (status.firebase === 'recorded') status.jotform = await sendToJotform(pkg);
  else status.jotform = fb.isReady() ? 'failed' : 'disabled';
  return status;
}

let retryHandle = null;
function scheduleRetry(pkg, onSuccess) {
  if (retryHandle) return;
  const attempt = async () => {
    try {
      await commitToFirebase(pkg);
      writeOutbox(null);
      await sendToJotform(pkg);
      clearInterval(retryHandle);
      retryHandle = null;
      window.removeEventListener('online', attempt);
      onSuccess && onSuccess();
    } catch (_) { /* keep trying */ }
  };
  retryHandle = setInterval(attempt, 15000);
  window.addEventListener('online', attempt);
}

/** A sealed package left behind by a crash or a closed tab is re-sent at next boot. */
export async function flushOutbox() {
  const pkg = readOutbox();
  if (!pkg || !fb.isReady()) return false;
  try {
    await fb.commitSubmission({
      submission: pkg.submission,
      forensics: pkg.forensics,
      session: { stage: Stage.SEALED, status: 'submitted', checksum: pkg.checksum, sessionId: pkg.submission.sessionId },
      identityKey: pkg.submission.identityKey
    });
    writeOutbox(null);
      await sendToJotform(pkg);
    return true;
  } catch (err) {
    console.warn('[submission] outbox flush failed:', err.message);
    return false;
  }
}

export function hasOutbox() { return !!readOutbox(); }

async function sendToJotform(pkg) {
  const jf = cfg().jotform;
  if (!jf || !jf.enabled) return 'disabled';
  try {
    const endpoint = new URL('/api/submit', location.href);
    if (endpoint.origin !== location.origin || endpoint.pathname !== '/api/submit' || endpoint.search || endpoint.hash) return 'failed';
    const token = await fb.getIdToken().catch(() => null);
    if (!token) return 'failed';
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ package: { submission: pkg.submission } }),
      signal: AbortSignal.timeout(12000)
    });
    if (!res.ok) {
      console.warn(`[submission] Jotform relay rejected (${res.status})`);
      return 'failed';
    }
    return 'dispatched';
  } catch (err) {
    console.warn('[submission] jotform dispatch failed:', err.message);
    return 'failed';
  }
}

/* --- 04 · RECEIPT --------------------------------------------------------- */
export function printReceipt(filenameStem) {
  const original = document.title;
  document.title = filenameStem;
  const restore = () => { document.title = original; window.removeEventListener('afterprint', restore); };
  window.addEventListener('afterprint', restore);
  setTimeout(restore, 10000);
  window.print();
}
