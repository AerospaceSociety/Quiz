import { commitWrites, getDocument, json, listDocuments } from '../_lib/firebase-admin.js';

async function tokenMatches(actual, expected) {
  if (!actual || !expected) return false;
  const encoder = new TextEncoder();
  const [actualDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(actual)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected))
  ]);
  const left = new Uint8Array(actualDigest);
  const right = new Uint8Array(expectedDigest);
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
  return difference === 0;
}

async function markStillsPurged(env, startedAt, now) {
  const paths = ['privacy_controls/stills', 'privacy_controls/stills_guard'];
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await Promise.all(paths.map((path) => getDocument(env, path)));
    const data = { purgedStartedAt: startedAt, updatedAt: now };
    try {
      await commitWrites(env, paths.map((path, index) => current[index]
        ? { path, data, merge: true, updateTime: current[index].updateTime }
        : { path, data, create: true }));
      return;
    } catch (error) {
      if (error.status !== 409 || attempt > 1) throw error;
    }
  }
}

function authHeader(request) {
  const match = /^Bearer ([^\s]+)$/.exec(request.headers.get('Authorization') || '');
  return match ? match[1] : '';
}

export async function onRequestPost({ request, env }) {
  if (!(await tokenMatches(authHeader(request), env.RETENTION_PURGE_TOKEN))) return json({ error: 'Unauthorized' }, 401);
  const days = Math.max(1, Math.min(365, Number(env.RETENTION_DAYS) || 30));
  const now = Date.now();
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  try {
    const control = await getDocument(env, 'exam_control/status');
    const eventEndedAt = Number(control?.data.eventEndedAt) || 0;
    if (!control) return json({ purgedDocuments: 0, skipped: 'control_missing' });
    if (control?.data.status === 'active') return json({ purgedDocuments: 0, skipped: 'event_active' });
    if (eventEndedAt && control?.data.retentionPurgedAt >= eventEndedAt) {
      return json({ purgedDocuments: 0, skipped: 'already_purged', eventEndedAt });
    }
    if (eventEndedAt && now < eventEndedAt + days * 24 * 60 * 60 * 1000) {
      return json({ purgedDocuments: 0, skipped: 'retention_period_not_elapsed', eventEndedAt });
    }
    await markStillsPurged(env, Number(control.data.startedAt) || 0, now);
    const eligibleSessions = new Set();
    for (const session of await listDocuments(env, 'sessions')) {
      const heartbeatAt = Number(session.data.heartbeatAt) || 0;
      const belongsToEndedEvent = eventEndedAt && heartbeatAt > 0
        && heartbeatAt <= eventEndedAt + 2 * 60 * 1000 && heartbeatAt <= cutoff + 2 * 60 * 1000;
      const expiredWithoutEnd = !eventEndedAt && heartbeatAt > 0 && heartbeatAt <= cutoff;
      if ((belongsToEndedEvent || expiredWithoutEnd) && session.data.sessionId) eligibleSessions.add(session.data.sessionId);
    }
    for (const submission of await listDocuments(env, 'submissions')) {
      const receivedAt = Number(submission.data.receivedAt || submission.data.sealedAt) || 0;
      const belongsToEndedEvent = eventEndedAt && receivedAt > 0
        && receivedAt <= eventEndedAt + 2 * 60 * 1000 && receivedAt <= cutoff + 2 * 60 * 1000;
      const expiredWithoutEnd = !eventEndedAt && receivedAt > 0 && receivedAt <= cutoff;
      if ((belongsToEndedEvent || expiredWithoutEnd) && submission.data.sessionId) eligibleSessions.add(submission.data.sessionId);
    }

    const writes = [];
    const forensics = await listDocuments(env, 'forensics');
    for (const record of forensics) {
      const data = record.data;
      const updatedAt = Number(data.updatedAt) || 0;
      const belongsToEndedEvent = eventEndedAt && updatedAt > 0
        && updatedAt <= eventEndedAt + 2 * 60 * 1000 && updatedAt <= cutoff + 2 * 60 * 1000;
      const expiredWithoutEnd = !eventEndedAt && updatedAt > 0 && updatedAt <= cutoff;
      if (!eligibleSessions.has(data.sessionId) && !belongsToEndedEvent && !expiredWithoutEnd) continue;
      const hasPhoto = data.baseline && typeof data.baseline === 'object'
        && Object.prototype.hasOwnProperty.call(data.baseline, 'photo');
      const hasThumbs = Array.isArray(data.thumbs) ? data.thumbs.length > 0 : Object.prototype.hasOwnProperty.call(data, 'thumbs');
      if (!hasPhoto && !hasThumbs) continue;
      const baseline = data.baseline && typeof data.baseline === 'object' ? { ...data.baseline } : null;
      if (baseline) delete baseline.photo;
      writes.push({ path: `forensics/${record.id}`, data: {
        thumbs: [],
        ...(baseline ? { baseline } : {}),
        stillsPurgedAt: now
      }, merge: true });
    }
    const events = await listDocuments(env, 'events');
    for (const record of events) {
      const ts = Number(record.data.ts) || 0;
      const belongsToEndedEvent = eventEndedAt && ts > 0
        && ts <= eventEndedAt + 2 * 60 * 1000 && ts <= cutoff + 2 * 60 * 1000;
      const expiredWithoutEnd = !eventEndedAt && ts > 0 && ts <= cutoff;
      if ((!eligibleSessions.has(record.data.sessionId) && !belongsToEndedEvent && !expiredWithoutEnd)
        || !Object.prototype.hasOwnProperty.call(record.data, 'thumb')) continue;
      writes.push({ path: `events/${record.id}`, data: { thumb: undefined, stillsPurgedAt: now }, merge: true });
    }
    for (const record of await listDocuments(env, 'candidate_papers')) {
      const createdAt = Number(record.data.createdAt) || 0;
      if (eligibleSessions.has(record.data.sessionId) || (createdAt > 0 && createdAt <= cutoff)) writes.push({ path: `candidate_papers/${record.id}`, delete: true });
    }
    let purged = 0;
    const chunks = [];
    for (let index = 0; index < writes.length; index += 400) chunks.push(writes.slice(index, index + 400));
    if (!chunks.length && eventEndedAt) chunks.push([]);
    for (let index = 0; index < chunks.length; index++) {
      const latestControl = await getDocument(env, 'exam_control/status');
      if (!latestControl || latestControl.data.status === 'active'
        || (Number(latestControl.data.eventEndedAt) || 0) !== eventEndedAt) {
        return json({ purgedDocuments: purged, skipped: 'control_changed_during_purge' });
      }
      const finalChunk = index === chunks.length - 1;
      const controlPatch = eventEndedAt && finalChunk ? { retentionPurgedAt: now } : { retentionPurgeBatchAt: now };
      const chunk = chunks[index];
      await commitWrites(env, [
        ...chunk,
        { path: 'exam_control/status', data: controlPatch, merge: true, updateTime: latestControl.updateTime }
      ]);
      purged += chunk.length;
    }
    return json({ purgedDocuments: purged, cutoff, eventEndedAt: eventEndedAt || null });
  } catch (error) {
    return json({ error: error.message || 'Retention purge failed' }, error.status || 500);
  }
}

export async function onRequestGet() {
  return json({ error: 'Method not allowed' }, 405);
}
