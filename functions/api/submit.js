/**
 * functions/api/submit.js
 * -----------------------
 * Cloudflare Pages Function (Worker) webhook relay for Quizzitch submissions to Jotform.
 * 
 * Routes to: POST /api/submit
 * 
 * Security & Reliability:
 *   1. Authenticates Firebase Auth ID Token (JWT) via Google Identity Toolkit REST API.
 *   2. Validates identity: caller UID must match payload package UID.
 *   3. Enforces payload shape, size cap (<= 500 KB), and valid fields.
 *   4. Verifies salted SHA-256 cryptographic checksum.
 *   5. Idempotent on sessionId (in-memory per-isolate registry).
 *   6. Forwards to Jotform REST API using env.JOTFORM_API_KEY (Cloudflare secret).
 *   7. Safe failure: Jotform mirror errors never affect Firestore authoritative status.
 */

const SUBMITTED_SESSIONS = new Set();

function jsonResponse(data, status = 200, origin = '*') {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Cache-Control': 'no-store'
    }
  });
}

function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`).join(',')}}`;
}

async function sha256Hex(str) {
  const buf = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function verifyChecksum(pkg) {
  const sub = pkg && pkg.submission;
  if (!sub || !sub.salt || !sub.checksum) return false;
  const body = {};
  for (const [k, v] of Object.entries(sub)) {
    if (k !== 'checksum' && k !== 'checksumAlgo') body[k] = v;
  }
  const raw = `${sub.salt}|${canonicalJSON(body)}`;
  const recomputed = await sha256Hex(raw);
  return recomputed.toLowerCase() === sub.checksum.toLowerCase();
}

async function verifyFirebaseToken(idToken, webApiKey, projectId) {
  if (!idToken) throw { status: 401, message: 'Missing Authorization Bearer token' };

  // Use Google Identity Toolkit accounts:lookup with the web API key
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(webApiKey)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken })
  });

  if (!resp.ok) {
    // Fallback: verify via Google's tokeninfo endpoint
    const fallbackUrl = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`;
    const fbResp = await fetch(fallbackUrl);
    if (!fbResp.ok) {
      throw { status: 401, message: 'Invalid or expired Firebase Auth token' };
    }
    const claims = await fbResp.json();
    if (projectId && claims.aud !== projectId) {
      throw { status: 403, message: `Token audience mismatch (expected ${projectId})` };
    }
    return claims.sub || claims.user_id;
  }

  const data = await resp.json();
  const user = data.users && data.users[0];
  if (!user || !user.localId) {
    throw { status: 401, message: 'Invalid token payload' };
  }
  return user.localId;
}

export async function onRequestOptions(context) {
  const origin = context.request.headers.get('Origin') || '*';
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400'
    }
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const origin = request.headers.get('Origin') || '*';

  // Enforce payload size limit (max 500 KB)
  const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
  if (contentLength > 512 * 1024) {
    return jsonResponse({ error: 'Payload too large (max 500 KB)' }, 413, origin);
  }

  const apiKey = env.JOTFORM_API_KEY;
  if (!apiKey) {
    return jsonResponse({ error: 'JOTFORM_API_KEY is not configured on Cloudflare' }, 503, origin);
  }

  const firebaseApiKey = env.FIREBASE_WEB_API_KEY || 'FIREBASE_API_KEY_PLACEHOLDER';
  const firebaseProjectId = env.FIREBASE_PROJECT_ID || 'quizzitch-14998';
  const jotformApiBase = env.JOTFORM_API_BASE || 'https://api.jotform.com';

  try {
    const authHeader = request.headers.get('authorization') || request.headers.get('Authorization') || '';
    if (!authHeader.startsWith('Bearer ')) {
      return jsonResponse({ error: 'Authorization: Bearer <token> required' }, 401, origin);
    }
    const idToken = authHeader.slice(7).trim();

    const authUid = await verifyFirebaseToken(idToken, firebaseApiKey, firebaseProjectId);

    const rawBody = await request.text();
    if (rawBody.length > 512 * 1024) {
      return jsonResponse({ error: 'Payload too large' }, 413, origin);
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch (_) {
      return jsonResponse({ error: 'Malformed JSON payload' }, 400, origin);
    }

    if (!payload || !payload.formId || !payload.sessionId || !payload.schoolUid || !payload.teamId) {
      return jsonResponse({ error: 'Missing required submission fields' }, 400, origin);
    }

    // Require caller UID matches submission package UID
    const subUid = payload.package && payload.package.submission && payload.package.submission.uid;
    if (subUid && subUid !== authUid) {
      return jsonResponse({ error: 'Identity mismatch: token UID does not match submission package' }, 403, origin);
    }

    // Idempotency: return recorded if already mirrored
    if (SUBMITTED_SESSIONS.has(payload.sessionId)) {
      return jsonResponse({
        status: 'recorded',
        idempotent: true,
        sessionId: payload.sessionId,
        message: 'Session already mirrored to Jotform'
      }, 200, origin);
    }

    // Verify cryptographic checksum if package is attached
    if (payload.package) {
      const valid = await verifyChecksum(payload.package);
      if (!valid) {
        return jsonResponse({ error: 'Cryptographic checksum mismatch: payload tampered' }, 422, origin);
      }
    }

    // Map questions on the form
    const questionsUrl = `${jotformApiBase}/form/${encodeURIComponent(payload.formId)}/questions?apiKey=${encodeURIComponent(apiKey)}`;
    const qResp = await fetch(questionsUrl);
    if (!qResp.ok) {
      return jsonResponse({ error: 'Failed to fetch Jotform form fields' }, 502, origin);
    }
    const qData = await qResp.json();
    const questions = qData.content || {};
    const nameToQid = {};
    for (const [qid, q] of Object.entries(questions)) {
      if (q && q.name) nameToQid[q.name] = qid;
    }

    // Build URL-encoded form data
    const submissionBody = new URLSearchParams();
    const fields = {
      schoolUid: payload.schoolUid,
      teamId: payload.teamId,
      candidateName: payload.candidateName,
      division: payload.division,
      sessionId: payload.sessionId,
      answered: payload.answered,
      verdict: payload.verdict,
      checksum: payload.checksum,
      responsesJson: payload.responsesJson,
      summaryText: payload.summaryText
    };

    for (const [fieldName, val] of Object.entries(fields)) {
      const qid = nameToQid[fieldName];
      if (qid && val != null) {
        submissionBody.append(`submission[${qid}]`, String(val));
      }
    }

    // Dispatch to Jotform
    const submitUrl = `${jotformApiBase}/form/${encodeURIComponent(payload.formId)}/submissions?apiKey=${encodeURIComponent(apiKey)}`;
    const postResp = await fetch(submitUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: submissionBody.toString()
    });

    if (!postResp.ok) {
      const errText = await postResp.text().catch(() => '');
      return jsonResponse({ error: `Jotform API error: ${errText}` }, 502, origin);
    }

    const postJson = await postResp.json().catch(() => ({}));
    const submissionID = postJson.content && postJson.content.submissionID;

    SUBMITTED_SESSIONS.add(payload.sessionId);

    return jsonResponse({
      status: 'recorded',
      jotformSubmissionId: submissionID,
      checksum: payload.checksum,
      timestamp: Date.now()
    }, 200, origin);
  } catch (err) {
    const status = err.status || 500;
    const msg = err.message || 'Internal server error';
    return jsonResponse({ error: msg }, status, origin);
  }
}
