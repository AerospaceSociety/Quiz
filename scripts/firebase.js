/* ==========================================================================
   QUIZZITCH — firebase.js
   The only module that talks to Firestore / Firebase Auth. Used by both the
   candidate portal (anonymous auth, own documents only) and the admin deck
   (email/password auth + admins/{uid} allowlist, enforced in firestore.rules).

   Every exported call is safe to invoke when Firebase is disabled or failed to
   load: reads resolve to null/[] and writes resolve to false, so the portal can
   still run a local rehearsal without a network.
   ========================================================================== */

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';
import { sha256Hex } from './util.js';

let fs = null;        // firebase-firestore module namespace
let fa = null;        // firebase-auth module namespace
let db = null;
let auth = null;
let ready = false;
let cfg = null;
let candidateIdentityKey = '';

/* --- 00 · DEBUG OPERATION COUNTER (Quota Protection) ---------------------- */
const stats = {
  reads: {},
  writes: {},
  totalReads: 0,
  totalWrites: 0
};

export function trackOp(op, col, count = 1) {
  const c = count || 1;
  if (op === 'read') {
    stats.reads[col] = (stats.reads[col] || 0) + c;
    stats.totalReads += c;
  } else if (op === 'write') {
    stats.writes[col] = (stats.writes[col] || 0) + c;
    stats.totalWrites += c;
  }
}

export function getFirestoreStats() {
  return JSON.parse(JSON.stringify(stats));
}

export function resetFirestoreStats() {
  stats.reads = {};
  stats.writes = {};
  stats.totalReads = 0;
  stats.totalWrites = 0;
}

if (typeof window !== 'undefined') {
  window.__QUIZZITCH_STATS__ = getFirestoreStats;
  window.__QUIZZITCH_RESET_STATS__ = resetFirestoreStats;
}

export const isReady = () => ready;
export const currentUser = () => (auth ? auth.currentUser : null);
export const currentUid = () => (auth && auth.currentUser ? auth.currentUser.uid : null);
export const getIdToken = (force = false) => (auth && auth.currentUser ? auth.currentUser.getIdToken(force) : Promise.resolve(null));

/* --- 01 · INITIALISATION -------------------------------------------------- */
export async function initFirebase(config) {
  if (ready) return true;
  cfg = config || null;
  if (!cfg || cfg.enabled === false || !cfg.projectId || String(cfg.projectId).includes('PLACEHOLDER') || String(cfg.apiKey).includes('PLACEHOLDER')) return false;
  try {
    const [appMod, fsMod, faMod] = await Promise.all([
      import(`${SDK}/firebase-app.js`),
      import(`${SDK}/firebase-firestore.js`),
      import(`${SDK}/firebase-auth.js`)
    ]);
    const { enabled, questionsCollection, ...appConfig } = cfg;
    const app = appMod.getApps().length ? appMod.getApps()[0] : appMod.initializeApp(appConfig);
    fs = fsMod;
    fa = faMod;
    try {
      db = fs.initializeFirestore(app, { ignoreUndefinedProperties: true });
    } catch (_) {
      db = fs.getFirestore(app);            // already initialised by an earlier call
    }
    auth = fa.getAuth(app);
    await auth.authStateReady();
    ready = true;
  } catch (err) {
    console.warn('[firebase] unavailable — running without cloud sync:', err && err.message);
    ready = false;
  }
  return ready;
}

const ts = () => fs.serverTimestamp();
const d = (...path) => fs.doc(db, ...path);

/** Firestore Timestamp | number | null → epoch ms | null */
export function toMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v.toMillis === 'function') return v.toMillis();
  return null;
}

/* --- 02 · CANDIDATE AUTH -------------------------------------------------- */
/** Anonymous sign-in. The uid survives a reload (IndexedDB persistence), which is what makes resume work. */
export async function signInCandidate() {
  if (!ready) return null;
  if (auth.currentUser) return auth.currentUser.uid;
  const cred = await fa.signInAnonymously(auth);
  return cred.user.uid;
}

/* --- 03 · TIME SYNC ------------------------------------------------------- */
/**
 * One handshake sample: write serverTimestamp(), time the round trip on the
 * monotonic clock, then read the committed value back from the server.
 * @param {() => number} mono monotonic epoch-ms clock
 */
export async function serverTimeSample(mono) {
  if (!ready || !auth.currentUser) throw new Error('firebase not ready');
  const t0 = mono();
  const response = await candidateRequest('time', {});
  const t1 = mono();
  const server = Number(response.server);
  if (!Number.isFinite(server) || server <= 0) throw new Error('server timestamp missing');
  return { server, t0, t1 };
}

/* --- 04 · EXAM CONTROL ---------------------------------------------------- */
/** Live listener on exam_control/status. Returns an unsubscribe function. */
export function watchControl(cb) {
  if (!ready) return () => {};
  return fs.onSnapshot(d('exam_control', 'status'), (snap) => {
    trackOp('read', 'exam_control');
    const data = snap.exists() ? snap.data({ serverTimestamps: 'estimate' }) : {};
    cb({
      status: data.status || 'waiting',
      paperId: data.paperId || '',
      startedAtMs: toMs(data.startedAt),
      durationSeconds: Number(data.durationSeconds) || 0,
      extensionSeconds: Number(data.extensionSeconds) || 0,
      updatedAtMs: toMs(data.updatedAt),
    });
  }, (err) => console.warn('[firebase] control listener:', err.message));
}

export function watchStillsPurge(cb) {
  if (!ready) return () => {};
  return fs.onSnapshot(d('privacy_controls', 'stills'), (snap) => {
    trackOp('read', 'privacy_controls');
    cb(snap.exists() ? snap.data() : null);
  }, (err) => console.warn('[firebase] still purge listener:', err.message));
}

/* --- 05 · CANDIDATE READS ------------------------------------------------- */
/** Fetch only the signed-in candidate's server-generated paper. */
export async function fetchPaper() {
  if (!ready) return null;
  const result = await candidateRequest('paper', {});
  trackOp('read', cfg.questionsCollection || 'quizzitch_questions', result.paper.length);
  return result.paper;
}

async function candidateRequest(action, payload) {
  if (!ready || !auth.currentUser) throw new Error('Firebase authentication is not ready');
  const idToken = await auth.currentUser.getIdToken();
  const response = await fetch('/api/candidate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ action, ...payload })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `Candidate service failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return body;
}

/**
 * Claims the identity lock for (schoolUid, teamId, name). One live device per
 * candidate, and no second sitting after a sealed submission.
 * @returns {{ ok: boolean, reason?: 'ACTIVE_ELSEWHERE'|'ALREADY_SUBMITTED'|'NOT_ROSTERED' }}
 */
export async function claimIdentity(claimCode, profile) {
  if (!ready) {
    if (cfg && cfg.enabled === false) {
      const identityKey = (await sha256Hex(`local-rehearsal|${profile.schoolUid}|${profile.teamId}|${profile.name}`)).slice(0, 40);
      return { ok: true, identityKey, profile };
    }
    throw new Error('Firebase is unavailable; live candidate sign-in is disabled.');
  }
  try {
    const result = await candidateRequest('claim', { claimCode, ...profile });
    candidateIdentityKey = result.identityKey;
    trackOp('write', 'identities');
    return { ok: true, identityKey: result.identityKey, profile: result.profile };
  } catch (err) {
    if (err.status === 403) return { ok: false, reason: 'NOT_ROSTERED', message: err.message };
    if (err.status === 409) return { ok: false, reason: /already submitted/i.test(err.message) ? 'ALREADY_SUBMITTED' : 'ACTIVE_ELSEWHERE', message: err.message };
    throw err;
  }
}

/** The candidate's own live session doc — used to carry strikes across a reload or new tab. */
export async function getOwnSession() {
  if (!ready || !auth.currentUser) return null;
  try {
    trackOp('read', 'sessions');
    const snap = await fs.getDoc(d('sessions', auth.currentUser.uid));
    return snap.exists() ? snap.data() : null;
  } catch (_) {
    return null;
  }
}

/* --- 06 · CANDIDATE WRITES ------------------------------------------------ */
export async function writeSession(data) {
  if (!ready || !auth.currentUser) return false;
  try {
    trackOp('write', 'sessions');
    await candidateRequest('session', { identityKey: data.identityKey || candidateIdentityKey, data });
    return true;
  } catch (err) {
    console.warn('[firebase] session write:', err.message);
    return false;
  }
}

export async function writeEvent(id, data) {
  if (!ready || !auth.currentUser) return false;
  try {
    trackOp('write', 'events');
    await candidateRequest('event', { identityKey: data.identityKey || candidateIdentityKey, eventId: id, data });
    return true;
  } catch (err) {
    console.warn('[firebase] event write:', err.message);
    return false;
  }
}

export async function pushEvent(data) {
  if (!ready || !auth.currentUser) return false;
  const id = crypto.randomUUID().replace(/-/g, '');
  return writeEvent(id, data);
}

/** Baseline photo is uploaded once at paper start so invigilators can compare live. */
export async function writeForensicsBaseline(data) {
  if (!ready || !auth.currentUser) return false;
  try {
    trackOp('write', 'forensics');
    await candidateRequest('baseline', { identityKey: data.identityKey || candidateIdentityKey, data });
    return true;
  } catch (err) {
    console.warn('[firebase] forensics write:', err.message);
    return false;
  }
}

/**
 * Atomic seal: writes forensics best-effort, then commits the immutable
 * submission, the session's final state and the identity lock atomically.
 * Ensures the core submission doc write never fails due to forensics doc size.
 * Handles double-seal idempotently if submissions/{uid} already exists.
 */
export async function commitSubmission({ submission, forensics, session, identityKey }) {
  if (!ready || !auth.currentUser) throw new Error('firebase not ready');
  const result = await candidateRequest('seal', { identityKey, package: { submission, forensics }, session });
  trackOp('write', 'submissions');
  trackOp('write', 'sessions');
  trackOp('write', 'identities');
  if (forensics) trackOp('write', 'forensics');
  return result.recorded === true;
}

/* --- 07 · ADMIN AUTH ------------------------------------------------------ */
export async function signInAdmin(email, password) {
  if (!ready) throw new Error('Firebase is not configured.');
  const cred = await fa.signInWithEmailAndPassword(auth, email, password);
  return cred.user;
}

export async function signOutUser() {
  if (ready) await fa.signOut(auth);
}

export function onAuth(cb) {
  if (!ready) { cb(null); return () => {}; }
  return fa.onAuthStateChanged(auth, cb);
}

export async function isAdmin(uid) {
  if (!ready || !uid) return false;
  try {
    trackOp('read', 'admins');
    const snap = await fs.getDoc(d('admins', uid));
    return snap.exists();
  } catch (_) {
    return false;
  }
}

/* --- 08 · ADMIN LISTENERS ------------------------------------------------- */
function watchCollection(q, cb, label) {
  if (!ready) return () => {};
  return fs.onSnapshot(q, (snap) => {
    trackOp('read', label, snap.docChanges().length || snap.size);
    const rows = [];
    snap.forEach((doc) => rows.push({ id: doc.id, ...doc.data({ serverTimestamps: 'estimate' }) }));
    cb(rows, snap.docChanges().map((c) => ({ type: c.type, id: c.doc.id })));
  }, (err) => console.warn(`[firebase] ${label} listener:`, err.message));
}

export const watchSessions = (cb) => ready
  ? watchCollection(fs.collection(db, 'sessions'), cb, 'sessions') : () => {};

export const watchEvents = (limit, cb) => ready
  ? watchCollection(fs.query(fs.collection(db, 'events'), fs.orderBy('ts', 'desc'), fs.limit(limit)), cb, 'events')
  : () => {};

export const watchSubmissions = (cb) => ready
  ? watchCollection(fs.collection(db, 'submissions'), cb, 'submissions') : () => {};

/* --- 09 · ADMIN READS / WRITES ------------------------------------------- */
export async function getForensics(uid) {
  if (!ready) return null;
  trackOp('read', 'forensics');
  const snap = await fs.getDoc(d('forensics', uid));
  return snap.exists() ? snap.data() : null;
}

export async function getAllForensics() {
  if (!ready) return [];
  const snap = await fs.getDocs(fs.collection(db, 'forensics'));
  trackOp('read', 'forensics', snap.size);
  const rows = [];
  snap.forEach((doc) => rows.push({ id: doc.id, ...doc.data() }));
  return rows;
}

/**
 * Retention purge (DPDP Act 2023 compliance):
 * Permanently deletes candidate baseline photos and incident thumbnails from forensics docs.
 * Preserves candidate answers, scores, timestamps, event ledger, and checksums.
 * @returns {Promise<number>} count of purged records
 */
export async function purgeForensicStills() {
  if (!ready) throw new Error('Firebase is not configured.');
  const control = await fs.getDoc(d('exam_control', 'status'));
  trackOp('read', 'exam_control');
  const purgedStartedAt = control.exists() ? (toMs(control.get('startedAt')) || 0) : 0;
  const marker = { purgedStartedAt, updatedAt: ts() };
  const markerBatch = fs.writeBatch(db);
  markerBatch.set(d('privacy_controls', 'stills'), marker, { merge: true });
  markerBatch.set(d('privacy_controls', 'stills_guard'), marker, { merge: true });
  trackOp('write', 'privacy_controls', 2);
  await markerBatch.commit();
  const targets = [];
  for (const collectionName of ['forensics', 'events']) {
    trackOp('read', collectionName);
    const snap = await fs.getDocs(fs.collection(db, collectionName));
    trackOp('read', collectionName, snap.size);
    snap.forEach((docSnap) => {
      const data = docSnap.data();
      const hasPhoto = collectionName === 'forensics' && data.baseline && typeof data.baseline === 'object'
        && Object.prototype.hasOwnProperty.call(data.baseline, 'photo');
      const hasThumbs = collectionName === 'forensics'
        ? Object.prototype.hasOwnProperty.call(data, 'thumbs')
        : Object.prototype.hasOwnProperty.call(data, 'thumb');
      if (hasPhoto || hasThumbs) targets.push({ collectionName, ref: docSnap.ref, hasPhoto });
    });
  }
  let count = 0;
  for (let i = 0; i < targets.length; i += 400) {
    const chunk = targets.slice(i, i + 400);
    const batch = fs.writeBatch(db);
    for (const item of chunk) {
      trackOp('write', item.collectionName);
      const patch = { stillsPurgedAt: ts() };
      if (item.collectionName === 'forensics') patch.thumbs = [];
      else patch.thumb = fs.deleteField();
      if (item.hasPhoto) patch['baseline.photo'] = fs.deleteField();
      batch.update(item.ref, patch);
      count++;
    }
    await batch.commit();
  }
  return count;
}

export async function getAllEvents() {
  if (!ready) return [];
  const snap = await fs.getDocs(fs.query(fs.collection(db, 'events'), fs.orderBy('ts', 'asc')));
  trackOp('read', 'events', snap.size);
  const rows = [];
  snap.forEach((doc) => rows.push({ id: doc.id, ...doc.data() }));
  return rows;
}

/** status: 'waiting' | 'active' | 'ended'. Starting stamps the authoritative server start time. */
export async function setControl(patch) {
  if (!ready) throw new Error('Firebase is not configured.');
  const body = { ...patch, updatedAt: ts(), updatedBy: fs.deleteField() };
  if (patch.status === 'active' && patch.restart) {
    delete body.restart;
    body.startedAt = ts();
    body.extensionSeconds = 0;
    body.eventEndedAt = fs.deleteField();
    body.retentionPurgedAt = fs.deleteField();
  } else if (patch.status === 'ended') {
    body.eventEndedAt = ts();
  }
  trackOp('write', 'exam_control');
  await fs.setDoc(d('exam_control', 'status'), body, { merge: true });
}

export async function extendControl(seconds) {
  if (!ready) throw new Error('Firebase is not configured.');
  trackOp('write', 'exam_control');
  await fs.updateDoc(d('exam_control', 'status'), {
    extensionSeconds: fs.increment(seconds), updatedAt: ts(), updatedBy: fs.deleteField()
  });
}

export async function seedQuestions(questions) {
  if (!ready) throw new Error('Firebase is not configured.');
  if (!Array.isArray(questions) || !questions.length || questions.length > 1000) throw new Error('Question bank must contain 1–1,000 questions.');
  const safeQuestions = questions.map((question) => {
    const id = String(question?.id ?? '').trim();
    const catId = Number(question?.catId);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(id) || !Number.isSafeInteger(catId)
      || typeof question.question !== 'string' || !question.question.trim()
      || question.question.length > 5000 || /data:image\//i.test(question.question)
      || (question.supplement != null && (typeof question.supplement !== 'string' || question.supplement.length > 5000 || /data:image\//i.test(question.supplement)))
      || !Array.isArray(question.options) || question.options.length < 2 || question.options.length > 26
      || question.options.some((option) => typeof option !== 'string' || !option.trim() || option.length > 1000 || /data:image\//i.test(option))) {
      throw new Error(`Question ${id || '(missing ID)'} has an invalid shape.`);
    }
    if (question.divisions != null && (!Array.isArray(question.divisions) || question.divisions.some((division) => typeof division !== 'string'))) {
      throw new Error(`Question ${id} has invalid division restrictions.`);
    }
    return {
      id,
      catId,
      scheme: typeof question.scheme === 'string' && question.scheme ? question.scheme : 'standard',
      question: question.question,
      supplement: typeof question.supplement === 'string' ? question.supplement : '',
      options: question.options.slice(),
      ...(Array.isArray(question.divisions) ? { divisions: question.divisions.slice() } : {})
    };
  });
  const ids = safeQuestions.map((question) => question.id);
  if (new Set(ids).size !== ids.length) throw new Error('Question IDs must be unique.');
  const control = await fs.getDoc(d('exam_control', 'status'));
  if (control.exists() && control.get('status') === 'active') throw new Error('The question bank cannot be changed while a paper is active.');
  const submissions = await fs.getDocs(fs.collection(db, 'submissions'));
  if (!submissions.empty) throw new Error('Delete or archive prior submissions before replacing the question bank.');
  const assignedPapers = await fs.getDocs(fs.collection(db, 'candidate_papers'));
  if (!assignedPapers.empty) throw new Error('The question bank cannot change while candidates have assigned papers.');
  const col = cfg.questionsCollection || 'quizzitch_questions';
  const existing = await fs.getDocs(fs.collection(db, col));
  const keep = new Set(ids);
  const stale = [];
  existing.forEach((docSnap) => { if (!keep.has(docSnap.id)) stale.push(docSnap.ref); });
  let n = 0;
  for (let i = 0; i < questions.length; i += 400) {
    const batch = fs.writeBatch(db);
    const slice = safeQuestions.slice(i, i + 400);
    slice.forEach((question) => {
      batch.set(d(col, question.id), question);
      n++;
    });
    trackOp('write', col, slice.length);
    await batch.commit();
  }
  for (let i = 0; i < stale.length; i += 400) {
    const batch = fs.writeBatch(db);
    stale.slice(i, i + 400).forEach((ref) => batch.delete(ref));
    await batch.commit();
  }
  await fs.deleteDoc(d('answer_key', 'current'));
  return n;
}

async function assertAnswerKeyMatchesBank(key) {
  if (!key || typeof key !== 'object' || Array.isArray(key)) throw new Error('Answer key must be an object keyed by question ID.');
  const col = cfg.questionsCollection || 'quizzitch_questions';
  const bankSnapshot = await fs.getDocs(fs.collection(db, col));
  trackOp('read', col, bankSnapshot.size);
  const bank = new Map();
  bankSnapshot.forEach((docSnap) => bank.set(docSnap.id, docSnap.data()));
  const keyEntries = Object.entries(key);
  if (!bank.size || bank.size > 1000 || keyEntries.length !== bank.size) throw new Error('Answer key must cover every question exactly once.');
  for (const [id, answers] of keyEntries) {
    const question = bank.get(id);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(id) || !question || !Array.isArray(question.options) || !Array.isArray(answers) || !answers.length
      || answers.some((answer) => !Number.isSafeInteger(answer) || answer < 0 || answer >= question.options.length)
      || new Set(answers).size !== answers.length || ((question.scheme || 'standard') !== 'multi' && answers.length !== 1)) {
      throw new Error(`Answer key entry ${id} does not match the current question bank.`);
    }
  }
}

export async function saveAnswerKey(key) {
  if (!ready) throw new Error('Firebase is not configured.');
  const control = await fs.getDoc(d('exam_control', 'status'));
  if (control.exists() && control.get('status') === 'active') throw new Error('The answer key cannot be changed while a paper is active.');
  const submissions = await fs.getDocs(fs.collection(db, 'submissions'));
  if (!submissions.empty) throw new Error('The answer key is locked after submissions exist.');
  const assignedPapers = await fs.getDocs(fs.collection(db, 'candidate_papers'));
  if (!assignedPapers.empty) throw new Error('The answer key cannot change while candidates have assigned papers.');
  await assertAnswerKeyMatchesBank(key);
  trackOp('write', 'answer_key');
  await fs.setDoc(d('answer_key', 'current'), { key, updatedAt: ts() });
}

export async function loadAnswerKey() {
  if (!ready) return null;
  try {
    trackOp('read', 'answer_key');
    const snap = await fs.getDoc(d('answer_key', 'current'));
    if (!snap.exists()) return null;
    const key = snap.get('key');
    await assertAnswerKeyMatchesBank(key);
    return key;
  } catch (_) {
    return null;
  }
}

export async function releaseIdentity(key) {
  if (!ready) throw new Error('Firebase is not configured.');
  const identityRef = d('identities', key);
  const identitySnap = await fs.getDoc(identityRef);
  if (!identitySnap.exists()) return;
  const identity = identitySnap.data();
  if (identity.uid) {
    const submission = await fs.getDoc(d('submissions', identity.uid));
    if (submission.exists()) throw new Error('A sealed candidate identity cannot be released.');
  }
  const batch = fs.writeBatch(db);
  batch.delete(identityRef);
  if (identity.uid) {
    batch.delete(d('candidate_claims', identity.uid));
    batch.delete(d('candidate_papers', identity.uid));
    batch.delete(d('sessions', identity.uid));
  }
  trackOp('write', 'identities');
  await batch.commit();
}

/** Admin-only: replace the roster keyed by one-time access-code hashes. */
export async function uploadRoster(entries) {
  if (!ready) throw new Error('Firebase is not configured.');
  if (!Array.isArray(entries) || !entries.length || entries.some((entry) => !entry || typeof entry !== 'object'
    || !/^[a-f0-9]{40}$/.test(entry.rosterKey || '') || !/^[a-f0-9]{40}$/.test(entry.identityKey || ''))
    || new Set(entries.map((entry) => entry.rosterKey)).size !== entries.length
    || new Set(entries.map((entry) => entry.identityKey)).size !== entries.length) {
    throw new Error('A non-empty roster with unique valid access-code keys is required.');
  }
  const control = await fs.getDoc(d('exam_control', 'status'));
  if (control.exists() && control.get('status') === 'active') throw new Error('The candidate roster cannot be changed while a paper is active.');
  const existingRoster = await fs.getDocs(fs.collection(db, 'roster'));
  trackOp('read', 'roster', existingRoster.size);
  const retainedKeys = new Set(entries.map((entry) => entry.rosterKey));
  const staleRefs = [];
  existingRoster.forEach((docSnap) => { if (!retainedKeys.has(docSnap.id)) staleRefs.push(docSnap.ref); });
  for (let i = 0; i < staleRefs.length; i += 400) {
    const batch = fs.writeBatch(db);
    staleRefs.slice(i, i + 400).forEach((ref) => batch.delete(ref));
    trackOp('write', 'roster', Math.min(400, staleRefs.length - i));
    await batch.commit();
  }
  let n = 0;
  for (let i = 0; i < entries.length; i += 400) {
    const batch = fs.writeBatch(db);
    const slice = entries.slice(i, i + 400);
    slice.forEach((entry) => {
      batch.set(d('roster', entry.rosterKey), {
        identityKey: entry.identityKey,
        rosterKey: entry.rosterKey,
        schoolUid: entry.schoolUid,
        teamId: entry.cleanTeamId || String(entry.teamId || '').replace(/-M\d{1,2}$/i, ''),
        rawTeamId: entry.teamId || '',
        name: entry.name,
        members: Array.isArray(entry.members) && entry.members.length ? entry.members : [entry.name],
        memberId: entry.memberId || '',
        division: entry.division || '',
        createdAt: ts(),
        updatedAt: ts()
      });
      n++;
    });
    trackOp('write', 'roster', slice.length);
    await batch.commit();
  }
  return n;
}
