/* ==========================================================================
   QUIZZITCH — submission.js
   Live telemetry (heartbeat + rate-limited incident events), the sealed
   submission package with its salted SHA-256 checksum, dispatch to Firebase
   (system of record, with an offline retry outbox) and Jotform (mirror), and
   the printable receipt.

   Network economy: the heartbeat carries only a few state flags. Informational
   ledger lines stay in memory and travel once, inside the final package.
   ========================================================================== */

import { S, cfg, bus, EV, Stage, Level, now, answeredCount, markedCount, unansweredCount } from './session.js';
import { responseItems, moduleProgress } from './engine.js';
import * as fb from './firebase.js';
import { sha256Hex, canonicalJSON, istStamp } from './util.js';

const OUTBOX = 'qz.outbox.v2';
const LIVE_EVENTS = new Set(['SIGNED_IN', 'EXAM_STARTED', 'SESSION_RESUMED', 'SUBMITTED', 'CLOCK_ANOMALY']);

let heartbeat = null;
let pushTimer = null;
let closed = false;          // set at seal: the sealing batch owns the final session write
const lastEventByType = new Map();

/* --- 01 · TELEMETRY ------------------------------------------------------- */
export function sessionPatch() {
  return {
    sessionId: S.sessionId,
    identityKey: S.identityKey,
    schoolUid: S.candidate.schoolUid,
    teamId: S.candidate.teamId,
    name: S.candidate.name,
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
    clientTs: now()
  };
}

/** Coalesces bursts of state changes into one write. */
export function pushSoon(delay = 2000) {
  if (closed || !heartbeat) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { if (!closed) fb.writeSession(sessionPatch()); }, delay);
}

export function startTelemetry() {
  if (heartbeat || closed) return;
  fb.writeSession(sessionPatch());
  heartbeat = setInterval(() => { if (!closed) fb.writeSession(sessionPatch()); }, cfg().telemetry.heartbeatSeconds * 1000);
  bus.on(EV.STATUS, () => pushSoon(500));
  bus.on(EV.STAGE, () => pushSoon(0));
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
 *   strikes always (with a thumbnail when one exists),
 *   advisories at most once per type per `advisoryRateLimitSeconds`,
 *   informational entries only for lifecycle milestones.
 */
export function wireEventStream(getThumb) {
  bus.on(EV.INCIDENT, (entry) => {
    if (entry.level === Level.INFO && !LIVE_EVENTS.has(entry.type)) return;
    if (entry.level === Level.ADVISORY) {
      const last = lastEventByType.get(entry.type) || 0;
      if (entry.t - last < cfg().telemetry.advisoryRateLimitSeconds * 1000) return;
      lastEventByType.set(entry.type, entry.t);
    }
    fb.pushEvent(eventDoc(entry, entry.level === Level.STRIKE ? getThumb() : null));
    if (entry.level >= Level.ADVISORY) pushSoon();
  });
}

/* --- 02 · SEALED PACKAGE -------------------------------------------------- */
export function identityKeyFor(schoolUid, teamId, name) {
  return sha256Hex(`${schoolUid}|${teamId}|${name}`).then((h) => h.slice(0, 40));
}

function deviceInfo() {
  return {
    ua: navigator.userAgent.slice(0, 200),
    cores: navigator.hardwareConcurrency || 0,
    memoryGb: navigator.deviceMemory || 0,
    screen: `${screen.width}x${screen.height}@${window.devicePixelRatio}`,
    extendedDisplay: !!(screen.isExtended)
  };
}

/** Keeps the forensic document under Firestore's 1 MiB document cap. */
function fitForensics(doc) {
  const limit = 900 * 1024;
  let size = JSON.stringify(doc).length;
  while (size > limit && doc.thumbs.length) { doc.thumbs.pop(); size = JSON.stringify(doc).length; }
  if (size > limit) {
    doc.ledger = doc.ledger.filter((e) => e.level > Level.INFO);
    doc.ledgerTruncated = true;
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
    v: 2,
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
    baseline: S.baseline ? { photo: S.baseline.photo, pose: S.baseline.pose, noise: S.baseline.noise, light: S.baseline.light, camera: S.baseline.camera, capturedAt: S.baseline.capturedAt } : null,
    thumbs: S.thumbs.slice(),
    ledger: S.ledger.map((e) => ({ ...e })),
    ledgerTruncated: false,
    device: deviceInfo(),
    checksum
  });

  return { submission: { ...body, checksum, checksumAlgo: 'SHA-256(salt|canonicalJSON(body))' }, forensics, checksum };
}

/* --- 03 · DISPATCH -------------------------------------------------------- */
function readOutbox() {
  try { return JSON.parse(localStorage.getItem(OUTBOX) || 'null'); } catch (_) { return null; }
}

function writeOutbox(v) {
  try {
    if (v) localStorage.setItem(OUTBOX, JSON.stringify(v));
    else localStorage.removeItem(OUTBOX);
  } catch (_) { /* quota — the in-memory retry loop still runs */ }
}

async function commitToFirebase(pkg) {
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

  if (fb.isReady()) {
    try {
      await commitToFirebase(pkg);
      status.firebase = 'recorded';
      writeOutbox(null);
    } catch (err) {
      console.warn('[submission] firebase commit failed, queued for retry:', err.message);
      writeOutbox(pkg);
      status.firebase = 'queued';
      scheduleRetry(pkg, onRetrySuccess);
    }
  }

  status.jotform = await sendToJotform(pkg);
  return status;
}

let retryHandle = null;
function scheduleRetry(pkg, onSuccess) {
  if (retryHandle) return;
  const attempt = async () => {
    try {
      await commitToFirebase(pkg);
      writeOutbox(null);
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
  const sub = pkg.submission;
  const summary = [
    `${cfg().meta.event} · ${cfg().meta.round} · ${sub.paperId}`,
    `School UID: ${sub.candidate.schoolUid}  Team: ${sub.candidate.teamId}${sub.candidate.memberId ? ` (${sub.candidate.memberId})` : ''}  Name: ${sub.candidate.name}`,
    `Answered ${sub.answered}/${sub.total} · Marked ${sub.marked} · Strikes ${sub.strikes} · Verdict ${sub.verdict}`,
    `Sealed ${istStamp(sub.sealedAt)} · Reason ${sub.reason}`,
    `SHA-256 ${sub.checksum}`,
    ...sub.items.map((it) => `Q${it.n} [${it.id}] ${it.displayed.join(',') || '—'}${it.marked ? ' (marked)' : ''} ${it.seconds}s`)
  ].join('\n');

  const values = {
    schoolUid: sub.candidate.schoolUid,
    teamId: sub.candidate.memberId ? `${sub.candidate.teamId} (${sub.candidate.memberId})` : sub.candidate.teamId,
    candidateName: sub.candidate.name,
    division: sub.candidate.division,
    sessionId: sub.sessionId,
    answered: `${sub.answered}/${sub.total}`,
    verdict: sub.verdict,
    checksum: sub.checksum,
    responsesJson: JSON.stringify(sub.items.map((it) => ({ n: it.n, id: it.id, sel: it.original, marked: it.marked, s: it.seconds }))),
    summaryText: summary
  };

  try {
    if (jf.webhookUrl) {
      const token = await fb.getIdToken().catch(() => null);
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const res = await fetch(jf.webhookUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...values,
          formId: jf.formId,
          package: pkg
        }),
        keepalive: true
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.warn(`[submission] webhook rejected (${res.status}):`, text);
        return 'failed';
      }
    } else {
      const form = new FormData();
      form.append('formID', jf.formId);
      Object.entries(jf.fieldMap || {}).forEach(([key, field]) => {
        if (field && values[key] != null) form.append(field, values[key]);
      });
      // Jotform does not send CORS headers; an opaque response is the best confirmation available.
      await fetch(`${jf.submitUrl}${jf.formId}`, { method: 'POST', body: form, mode: 'no-cors', keepalive: true });
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
