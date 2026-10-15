import { authenticate, allowedOrigin, commitWrites, getDocument, json, jsonDepthWithin, readLimitedBody, HttpError } from '../_lib/firebase-admin.js';
import { enforceActionRateLimit, enforceIpRateLimit, enforceUserRateLimit } from '../_lib/rate-limit.js';

function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`;
}

async function digest(value) {
  const bytes = new TextEncoder().encode(value);
  const result = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function checksumValid(submission) {
  const body = Object.fromEntries(Object.entries(submission).filter(([key]) => key !== 'checksum' && key !== 'checksumAlgo'));
  return (await digest(`${submission.salt}|${canonicalJSON(body)}`)) === String(submission.checksum || '').toLowerCase();
}

function summary(submission) {
  const candidate = submission.candidate;
  return [
    `CelesteCon 2026 · Preliminary Screening · ${submission.paperId}`,
    `School UID: ${candidate.schoolUid}  Team: ${candidate.teamId}${candidate.memberId ? ` (${candidate.memberId})` : ''}  Name: ${candidate.name}`,
    `Answered ${submission.serverAnswered ?? submission.answered}/${submission.total} · Marked ${submission.serverMarked ?? submission.marked} · Client-reported strikes ${submission.clientReportedStrikes ?? submission.strikes} · Client-reported verdict ${submission.clientReportedVerdict || submission.verdict}`,
    `Received ${new Date(submission.receivedAt || submission.sealedAt).toISOString()} · Reason ${submission.reason}`,
    `SHA-256 ${submission.checksum}`,
    ...submission.items.map((item) => `Q${item.n} [${item.id}] ${item.displayed.join(',') || '—'}${item.marked ? ' (marked)' : ''} ${item.seconds}s`)
  ].join('\n');
}

export async function onRequestOptions({ request, env }) {
  const origin = allowedOrigin(request, env);
  if (origin === false) return json({ error: 'Origin not allowed' }, 403);
  return new Response(null, { status: 204, headers: {
    ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin'
  } });
}

export async function onRequestPost({ request, env }) {
  const origin = allowedOrigin(request, env);
  if (origin === false) return json({ error: 'Origin not allowed' }, 403);
  try {
    enforceIpRateLimit(request.headers.get('CF-Connecting-IP'));
    const contentLength = Number(request.headers.get('content-length') || 0);
    if (contentLength > 600 * 1024) return json({ error: 'Payload too large' }, 413, origin);
    const { uid } = await authenticate(request, env);
    enforceUserRateLimit(uid);
    enforceActionRateLimit(uid, 'submit');
    const rawBody = await readLimitedBody(request, 600 * 1024);
    if (!jsonDepthWithin(rawBody)) throw new HttpError(400, 'JSON nesting is too deep');
    let payload;
    try { payload = JSON.parse(rawBody); } catch (_) { throw new HttpError(400, 'Malformed JSON payload'); }
    const sub = payload && payload.package && payload.package.submission;
    if (!sub || sub.uid !== uid || typeof sub.sessionId !== 'string' || !sub.candidate || !sub.checksum || !(await checksumValid(sub))) {
      throw new HttpError(422, 'Invalid or mismatched sealed submission');
    }
    const stored = await getDocument(env, `submissions/${uid}`);
    if (!stored || stored.data.checksum !== sub.checksum || stored.data.sessionId !== sub.sessionId) {
      throw new HttpError(403, 'Only the authoritative sealed Firestore submission may be mirrored');
    }
    const submission = stored.data;
    const apiKey = env.JOTFORM_API_KEY;
    const formId = env.JOTFORM_FORM_ID || '262450769915063';
    const apiBase = env.JOTFORM_API_BASE || 'https://api.jotform.com';
    if (!apiKey) throw new HttpError(503, 'Jotform server credentials are not configured');
    if (!/^\d+$/.test(formId) || !/^https:\/\/(?:api|eu-api|hipaa-api)\.jotform\.com$/.test(apiBase)) {
      throw new HttpError(503, 'Jotform relay configuration is invalid');
    }

    const mirrorPath = `jotform_mirror/${uid}`;
    const existing = await getDocument(env, mirrorPath);
    if (existing && existing.data.checksum !== sub.checksum) {
      throw new HttpError(409, 'A different Jotform mirror is already recorded for this account; reconcile it manually');
    }
    if (existing && existing.data.status === 'recorded' && existing.data.checksum === sub.checksum) {
      return json({ status: 'recorded', idempotent: true }, 200, origin);
    }
    if (existing && existing.data.status === 'uncertain' && existing.data.checksum === sub.checksum) {
      return json({ status: 'uncertain', message: 'Check Jotform before retrying this mirror' }, 409, origin);
    }
    if (existing && existing.data.status === 'pending') {
      const age = Date.now() - Number(existing.data.updatedAt || 0);
      if (age < 15 * 60 * 1000) return json({ status: 'pending', message: 'A Jotform mirror request is already in progress' }, 202, origin);
      return json({ status: 'uncertain', message: 'Check Jotform and reconcile the stale mirror before retrying' }, 409, origin);
    }
    const pending = { uid, sessionId: sub.sessionId, checksum: sub.checksum, status: 'pending', updatedAt: Date.now() };
    let postAttempted = false;
    try {
      await commitWrites(env, [existing
        ? { path: mirrorPath, data: pending, updateTime: existing.updateTime }
        : { path: mirrorPath, data: pending, create: true }]);
    } catch (error) {
      if (error.status === 409) return json({ status: 'pending' }, 202, origin);
      throw error;
    }

    try {
      const questionsResponse = await fetch(`${apiBase}/form/${encodeURIComponent(formId)}/questions`, {
        headers: { APIKEY: apiKey }, redirect: 'manual', signal: AbortSignal.timeout(15000)
      });
      if (!questionsResponse.ok) throw new Error('Failed to fetch Jotform field definitions');
      const questionData = await questionsResponse.json();
      if (questionData.responseCode !== 200 || !questionData.content || typeof questionData.content !== 'object') {
        throw new Error('Jotform returned invalid field definitions');
      }
      const nameToQid = new Map();
      for (const [qid, question] of Object.entries(questionData.content || {})) {
        if (!/^\d+$/.test(qid) || !question || typeof question.name !== 'string' || !question.name) continue;
        if (nameToQid.has(question.name)) throw new Error(`Jotform field name is ambiguous: ${question.name}`);
        nameToQid.set(question.name, qid);
      }
      const candidate = submission.candidate;
      const fields = {
        schoolUid: candidate.schoolUid,
        teamId: candidate.memberId ? `${candidate.teamId} (${candidate.memberId})` : candidate.teamId,
        candidateName: candidate.name,
        division: candidate.division,
        sessionId: submission.sessionId,
        answered: `${submission.serverAnswered ?? submission.answered}/${submission.total}`,
        verdict: submission.clientReportedVerdict || submission.verdict,
        checksum: submission.checksum,
        responsesJson: JSON.stringify(submission.items.map((item) => ({ n: item.n, id: item.id, sel: item.original, marked: item.marked, s: item.seconds }))),
        summaryText: summary(submission)
      };
      const form = new URLSearchParams();
      for (const [fieldName, value] of Object.entries(fields)) {
        const qid = nameToQid.get(fieldName);
        if (!qid) throw new Error(`Jotform form is missing required field: ${fieldName}`);
        if (value != null) form.append(`submission[${qid}]`, String(value));
      }
      postAttempted = true;
      const postResponse = await fetch(`${apiBase}/form/${encodeURIComponent(formId)}/submissions`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', APIKEY: apiKey },
        body: form.toString(),
        signal: AbortSignal.timeout(15000)
      });
      if (!postResponse.ok) throw new Error('Jotform rejected the submission');
      const postData = await postResponse.json().catch(() => ({}));
      const jotformSubmissionId = postData.content?.submissionID;
      if (postData.responseCode !== 200 || !/^[0-9]+$/.test(String(jotformSubmissionId || ''))) {
        throw new Error('Jotform did not confirm a submission ID');
      }
      const current = await getDocument(env, mirrorPath);
      if (!current || current.data.status !== 'pending' || current.data.updatedAt !== pending.updatedAt) {
        throw new HttpError(409, 'Jotform mirror lock changed before recording the result');
      }
      await commitWrites(env, [{
        path: mirrorPath,
        data: { ...pending, status: 'recorded', jotformSubmissionId: String(jotformSubmissionId), updatedAt: Date.now() },
        merge: true,
        updateTime: current.updateTime
      }]);
      return json({ status: 'recorded', checksum: submission.checksum }, 200, origin);
    } catch (error) {
      const current = await getDocument(env, mirrorPath).catch(() => null);
      if (current && current.data.status === 'pending' && current.data.updatedAt === pending.updatedAt) {
        await commitWrites(env, [{
          path: mirrorPath,
          data: { ...pending, status: postAttempted ? 'uncertain' : 'failed', updatedAt: Date.now() },
          merge: true,
          updateTime: current.updateTime
        }]).catch(() => {});
      }
      if (error.status === 409) throw error;
      throw new HttpError(502, postAttempted ? 'Jotform result is uncertain; check Jotform before retrying' : 'Jotform mirror failed before submission');
    }
  } catch (error) {
    const status = error.status || 500;
    return json({ error: status >= 500 ? 'Jotform relay is temporarily unavailable' : error.message || 'Request failed' }, status, origin);
  }
}
