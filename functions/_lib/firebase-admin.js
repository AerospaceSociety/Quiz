const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FIREBASE_CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const tokenCache = new Map();
let certificateCache = null;
let certificateExpiry = 0;
let certificateFetch = null;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function json(data, status = 200, origin = null) {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Vary': 'Origin'
  };
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
  }
  return new Response(JSON.stringify(data), { status, headers });
}

export function allowedOrigin(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return null;
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((item) => item.trim()).filter(Boolean);
  return allowed.includes(origin) ? origin : false;
}

export async function readLimitedBody(request, maxBytes) {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, 'Payload too large');
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

export function jsonDepthWithin(text, maxDepth = 64) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '{' || char === '[') {
      depth++;
      if (depth > maxDepth) return false;
    } else if (char === '}' || char === ']') {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0 && !inString && !escaped;
}

function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64url(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function readTokenPart(token, index) {
  const part = token.split('.')[index];
  if (!part) throw new HttpError(401, 'Invalid Firebase ID token');
  try { return JSON.parse(new TextDecoder().decode(decodeBase64url(part))); }
  catch (_) { throw new HttpError(401, 'Invalid Firebase ID token'); }
}

function readDer(bytes, offset) {
  if (offset >= bytes.length) throw new HttpError(503, 'Firebase signing certificate is malformed');
  const tag = bytes[offset];
  let cursor = offset + 1;
  const firstLength = bytes[cursor++];
  let length = firstLength;
  if (firstLength & 0x80) {
    const lengthBytes = firstLength & 0x7f;
    if (!lengthBytes || lengthBytes > 4 || cursor + lengthBytes > bytes.length) throw new HttpError(503, 'Firebase signing certificate is malformed');
    length = 0;
    for (let index = 0; index < lengthBytes; index++) length = length * 256 + bytes[cursor++];
  }
  const end = cursor + length;
  if (end > bytes.length) throw new HttpError(503, 'Firebase signing certificate is malformed');
  return { tag, start: offset, contentStart: cursor, end };
}

function certificateSpki(pem) {
  const encoded = pem.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s/g, '');
  const der = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
  const certificate = readDer(der, 0);
  const tbs = readDer(der, certificate.contentStart);
  if (certificate.tag !== 0x30 || tbs.tag !== 0x30) throw new HttpError(503, 'Firebase signing certificate is malformed');
  let cursor = tbs.contentStart;
  let field = readDer(der, cursor);
  if (field.tag === 0xa0) {
    cursor = field.end;
    field = readDer(der, cursor);
  }
  for (let index = 0; index < 5; index++) {
    cursor = field.end;
    field = readDer(der, cursor);
  }
  if (field.tag !== 0x30) throw new HttpError(503, 'Firebase certificate has no RSA public key');
  return der.slice(field.start, field.end);
}

async function signingCertificate(kid, forceRefresh = false) {
  if (forceRefresh || !certificateCache || Date.now() >= certificateExpiry) {
    if (!certificateFetch) {
      certificateFetch = (async () => {
        const response = await fetch(FIREBASE_CERTS_URL, { redirect: 'error', signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new HttpError(503, 'Firebase signing certificates are unavailable');
        const certificates = await response.json();
        const maxAgeMatch = /max-age=(\d+)/i.exec(response.headers.get('Cache-Control') || '');
        const maxAge = maxAgeMatch ? Number(maxAgeMatch[1]) : 300;
        certificateCache = certificates;
        certificateExpiry = Date.now() + Math.max(60, Math.min(maxAge, 86400)) * 1000;
      })().finally(() => { certificateFetch = null; });
    }
    await certificateFetch;
  }
  const pem = certificateCache && certificateCache[kid];
  if (typeof pem !== 'string') return null;
  return crypto.subtle.importKey('spki', certificateSpki(pem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
}

export async function authenticate(request, env) {
  const authorization = request.headers.get('Authorization') || '';
  if (authorization.length > 16384) throw new HttpError(401, 'Invalid Firebase ID token');
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  if (!match) throw new HttpError(401, 'Firebase bearer token required');
  const projectId = env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new HttpError(503, 'Firebase project is not configured');
  const token = match[1];
  const header = readTokenPart(token, 0);
  const claims = readTokenPart(token, 1);
  const parts = token.split('.');
  if (parts.length !== 3 || header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid || header.kid.length > 128) throw new HttpError(401, 'Invalid Firebase ID token');
  const now = Math.floor(Date.now() / 1000);
  if (claims.aud !== projectId
    || claims.iss !== `https://securetoken.google.com/${projectId}`
    || typeof claims.sub !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(claims.sub)
    || !Number.isFinite(claims.exp) || claims.exp <= now
    || claims.exp <= claims.iat
    || !Number.isFinite(claims.iat) || claims.iat > now + 60
    || (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now))
    || !Number.isFinite(claims.auth_time) || claims.auth_time < 0 || claims.auth_time > claims.iat + 60 || claims.auth_time > now + 60) {
    throw new HttpError(401, 'Firebase ID token is not valid for this project');
  }
  let key = await signingCertificate(header.kid);
  if (!key) key = await signingCertificate(header.kid, true);
  if (!key) throw new HttpError(401, 'Firebase ID token signing key is unknown');
  let valid = false;
  try {
    valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decodeBase64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch (_) {}
  if (!valid) throw new HttpError(401, 'Firebase ID token signature is invalid');
  return { uid: claims.sub, token };
}

async function serviceToken(env) {
  const raw = env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new HttpError(503, 'Firebase server credentials are not configured');
  let account;
  try { account = JSON.parse(raw); }
  catch (_) { throw new HttpError(503, 'Firebase server credentials are malformed'); }
  const projectId = env.FIREBASE_PROJECT_ID || account.project_id;
  if (!account.client_email || !account.private_key || !projectId || (account.project_id && account.project_id !== projectId)) {
    throw new HttpError(503, 'Firebase server credentials do not match the configured project');
  }
  const cached = tokenCache.get(account.client_email);
  if (cached && cached.expiresAt > Date.now() + 60000) return { token: cached.token, projectId };

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claims = base64url(new TextEncoder().encode(JSON.stringify({
    iss: account.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600
  })));
  const signingInput = `${header}.${claims}`;
  const pem = account.private_key.replace(/\\n/g, '\n').replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '');
  const key = await crypto.subtle.importKey('pkcs8', decodeBase64url(pem.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput));
  const assertion = `${signingInput}.${base64url(new Uint8Array(signature))}`;
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    signal: AbortSignal.timeout(15000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new HttpError(503, 'Unable to obtain Firebase server access token');
  tokenCache.set(account.client_email, { token: data.access_token, expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000 });
  return { token: data.access_token, projectId };
}

function toFirestoreValue(value) {
  if (value === null) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (typeof value === 'string') return { stringValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toFirestoreValue) } };
  if (typeof value === 'object') return { mapValue: { fields: toFirestoreFields(value) } };
  throw new TypeError('Unsupported Firestore value');
}

function toFirestoreFields(data) {
  const fields = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) fields[key] = toFirestoreValue(value);
  }
  return fields;
}

function fromFirestoreValue(value) {
  if ('nullValue' in value) return null;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('stringValue' in value) return value.stringValue;
  if ('timestampValue' in value) return Date.parse(value.timestampValue);
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(fromFirestoreValue);
  if ('mapValue' in value) return fromFirestoreFields(value.mapValue.fields || {});
  return null;
}

function fromFirestoreFields(fields = {}) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, fromFirestoreValue(value)]));
}

function documentPath(projectId, path) {
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/${path.split('/').map(encodeURIComponent).join('/')}`;
}

async function firestoreRequest(env, path, init = {}) {
  const { token, projectId } = await serviceToken(env);
  const response = await fetch(documentPath(projectId, path), {
    ...init,
    redirect: 'error',
    signal: init.signal || AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) }
  });
  if (response.status === 404) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const status = response.status === 409 || response.status === 412 ? 409 : 502;
    throw new HttpError(status, body.error && body.error.message || 'Firestore server request failed');
  }
  return body;
}

export async function getDocument(env, path) {
  const doc = await firestoreRequest(env, path);
  return doc ? { name: doc.name, updateTime: doc.updateTime, data: fromFirestoreFields(doc.fields) } : null;
}

export async function listDocuments(env, collection) {
  const { token, projectId } = await serviceToken(env);
  const rows = [];
  let pageToken = '';
  do {
    const url = new URL(documentPath(projectId, collection));
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(15000) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new HttpError(502, body.error && body.error.message || 'Firestore query failed');
    for (const doc of body.documents || []) {
      const id = doc.name.split('/').pop();
      rows.push({ id, data: fromFirestoreFields(doc.fields) });
    }
    pageToken = body.nextPageToken || '';
  } while (pageToken);
  return rows;
}

export async function commitWrites(env, writes) {
  const { token, projectId } = await serviceToken(env);
  const response = await fetch(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents:commit`, {
    method: 'POST',
    redirect: 'error',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ writes: writes.map((write) => {
      const path = write.path.split('/').map(encodeURIComponent).join('/');
      const name = `projects/${projectId}/databases/(default)/documents/${path}`;
      if (write.delete) return {
        delete: name,
        ...(write.updateTime ? { currentDocument: { updateTime: write.updateTime } } : {})
      };
      const encoded = { name, fields: toFirestoreFields(write.data) };
      if (write.create) return { update: encoded, currentDocument: { exists: false } };
      if (write.merge) return {
        update: encoded,
        updateMask: { fieldPaths: Object.keys(write.data) },
        ...(write.updateTime ? { currentDocument: { updateTime: write.updateTime } } : {})
      };
      if (write.updateTime) return { update: encoded, currentDocument: { updateTime: write.updateTime } };
      return { update: encoded };
    }) }),
    signal: AbortSignal.timeout(20000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const status = response.status === 409 || response.status === 412 ? 409 : 502;
    throw new HttpError(status, body.error && body.error.message || 'Firestore commit failed');
  }
  return body;
}

export async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
