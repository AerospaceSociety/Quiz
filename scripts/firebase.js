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

let fs = null;        // firebase-firestore module namespace
let fa = null;        // firebase-auth module namespace
let db = null;
let auth = null;
let ready = false;
let cfg = null;

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
  if (!cfg || cfg.enabled === false || !cfg.projectId) return false;
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
  const ref = d('time_sync', auth.currentUser.uid);
  const t0 = mono();
  trackOp('write', 'time_sync');
  await fs.setDoc(ref, { t: ts() });
  const t1 = mono();
  trackOp('read', 'time_sync');
  const snap = await fs.getDocFromServer(ref);
  const server = toMs(snap.get('t'));
  if (!server) throw new Error('server timestamp missing');
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
      updatedBy: data.updatedBy || ''
    });
  }, (err) => console.warn('[firebase] control listener:', err.message));
}

/* --- 05 · CANDIDATE READS ------------------------------------------------- */
/** Question bank. firestore.rules only permit this read while the paper is released. */
export async function fetchQuestions() {
  if (!ready) return null;
  const colName = cfg.questionsCollection || 'quizzitch_questions';
  const snap = await fs.getDocs(fs.collection(db, colName));
  trackOp('read', colName, snap.size);
  const list = [];
  snap.forEach((doc) => list.push({ id: doc.id, ...doc.data() }));
  return list;
}

/** registrations/{schoolUid} → { schoolName, teams: { [teamId]: { name, members: [..] } } } */
export async function fetchRoster(schoolUid) {
  if (!ready) return null;
  try {
    trackOp('read', 'registrations');
    const snap = await fs.getDoc(d('registrations', schoolUid));
    return snap.exists() ? snap.data() : null;
  } catch (err) {
    console.warn('[firebase] roster lookup:', err.message);
    return null;
  }
}

/** Fetch a single candidate roster entry from roster/{identityKey} */
export async function fetchRosterEntry(identityKey) {
  if (!ready || !identityKey) return null;
  try {
    trackOp('read', 'roster');
    const snap = await fs.getDoc(d('roster', identityKey));
    return snap.exists() ? snap.data() : null;
  } catch (err) {
    console.warn('[firebase] roster entry lookup:', err.message);
    return null;
  }
}

/**
 * Claims the identity lock for (schoolUid, teamId, name). One live device per
 * candidate, and no second sitting after a sealed submission.
 * @returns {{ ok: boolean, reason?: 'ACTIVE_ELSEWHERE'|'ALREADY_SUBMITTED'|'NOT_ROSTERED' }}
 */
export async function claimIdentity(key, profile) {
  if (!ready) return { ok: true };
  const uid = auth.currentUser.uid;
  const ref = d('identities', key);
  try {
    return await fs.runTransaction(db, async (tx) => {
      trackOp('read', 'identities');
      const snap = await tx.get(ref);
      if (snap.exists()) {
        const cur = snap.data();
        if (cur.state === 'sealed') return { ok: false, reason: 'ALREADY_SUBMITTED' };
        if (cur.uid !== uid) return { ok: false, reason: 'ACTIVE_ELSEWHERE' };
        trackOp('write', 'identities');
        tx.update(ref, { updatedAt: ts() });
      } else {
        trackOp('write', 'identities');
        tx.set(ref, { uid, state: 'active', ...profile, createdAt: ts(), updatedAt: ts() });
      }
      return { ok: true };
    });
  } catch (err) {
    if (err.code === 'permission-denied' || (err.message && err.message.toLowerCase().includes('permission'))) {
      return { ok: false, reason: 'NOT_ROSTERED' };
    }
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
    const uid = auth.currentUser.uid;
    trackOp('write', 'sessions');
    await fs.setDoc(d('sessions', uid), { ...data, uid, heartbeatAt: ts() }, { merge: true });
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
    await fs.setDoc(d('events', id), { ...data, uid: auth.currentUser.uid, ts: ts() });
    return true;
  } catch (err) {
    console.warn('[firebase] event write:', err.message);
    return false;
  }
}

let localEventSeq = 0;
export async function pushEvent(data) {
  if (!ready || !auth.currentUser) return false;
  if (localEventSeq >= 80) return false;
  const id = `${auth.currentUser.uid}_${localEventSeq++}`;
  return writeEvent(id, data);
}

/** Baseline photo is uploaded once at paper start so invigilators can compare live. */
export async function writeForensicsBaseline(data) {
  if (!ready || !auth.currentUser) return false;
  try {
    trackOp('write', 'forensics');
    await fs.setDoc(d('forensics', auth.currentUser.uid), { ...data, uid: auth.currentUser.uid, updatedAt: ts() }, { merge: true });
    return true;
  } catch (err) {
    console.warn('[firebase] forensics write:', err.message);
    return false;
  }
}

/**
 * Atomic seal: forensics ledger, the immutable submission, the session's final
 * state and the identity lock flip in a single batch — all or nothing.
 */
export async function commitSubmission({ submission, forensics, session, identityKey }) {
  if (!ready || !auth.currentUser) throw new Error('firebase not ready');
  const uid = auth.currentUser.uid;
  const batch = fs.writeBatch(db);
  batch.set(d('forensics', uid), { ...forensics, uid, updatedAt: ts() }, { merge: true });
  trackOp('write', 'forensics');
  batch.set(d('submissions', uid), { ...submission, uid, receivedAt: ts() });
  trackOp('write', 'submissions');
  batch.set(d('sessions', uid), { ...session, uid, heartbeatAt: ts() }, { merge: true });
  trackOp('write', 'sessions');
  if (identityKey) {
    batch.set(d('identities', identityKey), { uid, state: 'sealed', updatedAt: ts() }, { merge: true });
    trackOp('write', 'identities');
  }
  await batch.commit();
  return true;
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

export async function getAllEvents() {
  if (!ready) return [];
  const snap = await fs.getDocs(fs.query(fs.collection(db, 'events'), fs.orderBy('ts', 'asc')));
  trackOp('read', 'events', snap.size);
  const rows = [];
  snap.forEach((doc) => rows.push({ id: doc.id, ...doc.data() }));
  return rows;
}

/** status: 'waiting' | 'active' | 'ended'. Starting stamps the authoritative server start time. */
export async function setControl(patch, byEmail) {
  if (!ready) throw new Error('Firebase is not configured.');
  const body = { ...patch, updatedAt: ts(), updatedBy: byEmail || '' };
  if (patch.status === 'active' && patch.restart) {
    delete body.restart;
    body.startedAt = ts();
    body.extensionSeconds = 0;
  }
  trackOp('write', 'exam_control');
  await fs.setDoc(d('exam_control', 'status'), body, { merge: true });
}

export async function extendControl(seconds, byEmail) {
  if (!ready) throw new Error('Firebase is not configured.');
  trackOp('write', 'exam_control');
  await fs.updateDoc(d('exam_control', 'status'), {
    extensionSeconds: fs.increment(seconds), updatedAt: ts(), updatedBy: byEmail || ''
  });
}

export async function seedQuestions(questions) {
  if (!ready) throw new Error('Firebase is not configured.');
  const col = cfg.questionsCollection || 'quizzitch_questions';
  let n = 0;
  for (let i = 0; i < questions.length; i += 400) {
    const batch = fs.writeBatch(db);
    const slice = questions.slice(i, i + 400);
    slice.forEach((q) => {
      const { correct, ...safe } = q;          // an answer key must never land in a candidate-readable doc
      batch.set(d(col, String(q.id)), safe);
      n++;
    });
    trackOp('write', col, slice.length);
    await batch.commit();
  }
  return n;
}

export async function saveAnswerKey(key) {
  if (!ready) throw new Error('Firebase is not configured.');
  trackOp('write', 'answer_key');
  await fs.setDoc(d('answer_key', 'current'), { key, updatedAt: ts() });
}

export async function loadAnswerKey() {
  if (!ready) return null;
  try {
    trackOp('read', 'answer_key');
    const snap = await fs.getDoc(d('answer_key', 'current'));
    return snap.exists() ? snap.get('key') : null;
  } catch (_) {
    return null;
  }
}

export async function releaseIdentity(key) {
  if (!ready) throw new Error('Firebase is not configured.');
  trackOp('write', 'identities');
  await fs.deleteDoc(d('identities', key));
}

/** Admin-only: batch write candidate roster entries to roster/{identityKey} */
export async function uploadRoster(entries) {
  if (!ready) throw new Error('Firebase is not configured.');
  let n = 0;
  for (let i = 0; i < entries.length; i += 400) {
    const batch = fs.writeBatch(db);
    const slice = entries.slice(i, i + 400);
    slice.forEach((entry) => {
      batch.set(d('roster', entry.identityKey), {
        identityKey: entry.identityKey,
        schoolUid: entry.schoolUid,
        teamId: entry.cleanTeamId || entry.teamId,
        rawTeamId: entry.teamId || '',
        name: entry.name,
        normName: entry.normName || '',
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
