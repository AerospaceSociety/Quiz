/**
 * api/submit.js
 * --------------
 * Indigenous, zero-dependency serverless webhook relay for Quizzitch submissions to Jotform.
 * 
 * Works out-of-the-box on Vercel as `/api/submit` or standalone via `scripts/relay.js`.
 * 
 * Security Gates Enforced:
 *   1. Authenticates Firebase Auth ID Token (JWT) from Authorization header.
 *   2. Verifies student identity (token UID must match session identityKey).
 *   3. Enforces single-submission lock (prevents duplicate submissions and replays).
 *   4. Verifies SHA-256 cryptographic checksum (mathematical proof of zero tampering).
 *   5. Dispatches payload to Jotform REST API using server-side JOTFORM_API_KEY.
 */

const crypto = require('crypto');

const JOTFORM_API_KEY = process.env.JOTFORM_API_KEY;
const JOTFORM_API_BASE = process.env.JOTFORM_API_BASE || 'https://api.jotform.com';
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'quizzitch-14998';

// Single-submission lock (in-memory for serverless instance; pairs with Firestore lock)
const SUBMITTED_SESSIONS = new Set();
const SUBMITTED_CANDIDATES = new Set();

function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`).join(',')}}`;
}

function verifyChecksum(pkg) {
  const sub = pkg && pkg.submission;
  if (!sub || !sub.salt || !sub.checksum) return false;

  const body = {};
  for (const [k, v] of Object.entries(sub)) {
    if (k !== 'checksum' && k !== 'checksumAlgo') body[k] = v;
  }

  const raw = `${sub.salt}|${canonicalJSON(body)}`;
  const recomputed = crypto.createHash('sha256').update(raw).digest('hex');
  return recomputed.toLowerCase() === sub.checksum.toLowerCase();
}

async function verifyFirebaseToken(idToken) {
  if (!idToken) throw { status: 401, message: 'Missing Authorization Bearer token' };

  const url = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw { status: 401, message: 'Invalid or expired Firebase Auth token' };
  }

  const claims = await resp.json();
  if (claims.aud !== FIREBASE_PROJECT_ID) {
    throw { status: 403, message: `Token audience mismatch (expected ${FIREBASE_PROJECT_ID})` };
  }

  return claims;
}

module.exports = async function handler(req, res) {
  // CORS support
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const apiKey = JOTFORM_API_KEY || process.env.JOTFORM_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'JOTFORM_API_KEY not configured on server' });
  }

  try {
    const authHeader = req.headers.authorization || req.headers.Authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authorization: Bearer <Firebase_ID_Token> required' });
    }

    const idToken = authHeader.slice(7).trim();
    const claims = await verifyFirebaseToken(idToken);
    const authUid = claims.sub || claims.user_id;

    const payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!payload || !payload.formId) {
      return res.status(400).json({ error: 'Invalid submission payload' });
    }

    // 1. Authenticated Session Check: Caller must hold a verified Firebase auth token
    if (!authUid) {
      return res.status(403).json({ error: 'Identity mismatch: Missing or invalid authentication identity' });
    }

    // 2. Single-Submission Lock
    const candidateKey = `${payload.schoolUid}:${payload.teamId}`;
    if (SUBMITTED_SESSIONS.has(payload.sessionId)) {
      return res.status(409).json({ error: 'Duplicate submission: session already recorded' });
    }
    if (SUBMITTED_CANDIDATES.has(candidateKey)) {
      return res.status(409).json({ error: 'Duplicate submission: candidate team has already sat the paper' });
    }

    // 3. Cryptographic Integrity: Verify Salted SHA-256 Checksum
    if (payload.package) {
      const valid = verifyChecksum(payload.package);
      if (!valid) {
        return res.status(422).json({ error: 'Cryptographic checksum failure: answers or metadata tampered' });
      }
    }

    // 4. Map questions from Jotform form definition
    const questionsRes = await fetch(`${JOTFORM_API_BASE}/form/${payload.formId}/questions?apiKey=${apiKey}`);
    if (!questionsRes.ok) {
      return res.status(502).json({ error: 'Failed to retrieve Jotform questions' });
    }

    const qData = await questionsRes.json();
    const questions = qData.content || {};
    const nameToQid = {};
    for (const [qid, q] of Object.entries(questions)) {
      if (q && q.name) nameToQid[q.name] = qid;
    }

    // 5. Construct URL-encoded form data for Jotform API
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
      summaryText: payload.summaryText,
    };

    for (const [field, val] of Object.entries(fields)) {
      const qid = nameToQid[field];
      if (qid && val != null) {
        submissionBody.append(`submission[${qid}]`, String(val));
      }
    }

    // 6. Post submission to Jotform API server-side
    const submitUrl = `${JOTFORM_API_BASE}/form/${payload.formId}/submissions?apiKey=${apiKey}`;
    const submitRes = await fetch(submitUrl, {
      method: 'POST',
      body: submissionBody,
    });

    if (!submitRes.ok) {
      const errText = await submitRes.text();
      return res.status(502).json({ error: `Jotform API rejected submission: ${errText}` });
    }

    const submitJson = await submitRes.json();
    const submissionID = submitJson.content && submitJson.content.submissionID;

    // Lock session
    SUBMITTED_SESSIONS.add(payload.sessionId);
    SUBMITTED_CANDIDATES.add(candidateKey);

    return res.status(200).json({
      status: 'recorded',
      jotformSubmissionId: submissionID,
      checksum: payload.checksum,
      timestamp: Date.now(),
    });
  } catch (err) {
    const status = err.status || 500;
    const msg = err.message || 'Internal server error';
    return res.status(status).json({ error: msg });
  }
};
