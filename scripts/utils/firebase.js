/* ==========================================================================
   QUIZZITCH — utils/firebase.js
   Production Firebase Integration (Project: quizzitch-14998).
   Provides Firestore question bank fetching, direct submission persistence,
   real-time active student presence tracking, and exam launch control.
   ========================================================================== */

import { CFG, logEvent } from '../core/state.js';

export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyACBSgQ3Vo04Ph6NOgafTVnqH5pxOnt0vI",
  authDomain: "quizzitch-14998.firebaseapp.com",
  projectId: "quizzitch-14998",
  storageBucket: "quizzitch-14998.firebasestorage.app",
  messagingSenderId: "503716999814",
  appId: "1:503716999814:web:d8546bab8aec8c4f91d707",
  measurementId: "G-HE35W5TQRS"
};

let firebaseApp = null;
let firestoreDb = null;
let firebaseAuth = null;
let firestoreAvailable = false;

export const getFirestoreDb = () => firestoreDb;
export const getFirebaseAuth = () => firebaseAuth;
export const getFirebaseApp = () => firebaseApp;

/**
 * Initializes Firebase Firestore and Auth using modular SDK.
 */
export async function initFirebase(customConfig = null) {
  const config = customConfig || CFG.settings?.firebase || FIREBASE_CONFIG;
  if (!config || !config.projectId) return false;

  try {
    const { initializeApp, getApps } = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js');
    const { getFirestore } = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js');
    const { getAuth } = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js');

    const apps = getApps();
    firebaseApp = apps.length ? apps[0] : initializeApp(config);
    firestoreDb = getFirestore(firebaseApp);
    firebaseAuth = getAuth(firebaseApp);
    firestoreAvailable = true;

    console.log(`[Firebase] Initialized for project: ${config.projectId}`);
    logEvent('ok', 'FIREBASE', `Connected to Firebase project: ${config.projectId}`);
    return true;
  } catch (err) {
    console.warn('[Firebase] SDK initialization notice:', err.message);
    firestoreAvailable = false;
    return false;
  }
}

/**
 * Admin Authentication Helpers
 */
export async function loginAdmin(email, password) {
  if (!firebaseAuth) {
    await initFirebase();
  }
  const { signInWithEmailAndPassword } = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js');
  return await signInWithEmailAndPassword(firebaseAuth, email, password);
}

export async function loginAdminAnonymously() {
  if (!firebaseAuth) {
    await initFirebase();
  }
  const { signInAnonymously } = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js');
  return await signInAnonymously(firebaseAuth);
}

export async function logoutAdmin() {
  if (!firebaseAuth) return;
  const { signOut } = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js');
  return await signOut(firebaseAuth);
}

export async function subscribeAuthState(callback) {
  if (!firebaseAuth) {
    await initFirebase();
  }
  const { onAuthStateChanged } = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js');
  return onAuthStateChanged(firebaseAuth, callback);
}


/**
 * Fetches questions live from Firestore via SDK or REST endpoint.
 */
export async function fetchQuestionsFromFirestore(options = {}) {
  const config = CFG.settings?.firebase || FIREBASE_CONFIG;
  const collectionName = config.collection || 'quizzitch_questions';
  const projectId = config.projectId || 'quizzitch-14998';
  const itemsPerModule = options.itemsPerModule || CFG.settings?.questionPool?.itemsPerModule || 5;

  let remoteQuestions = [];

  // Attempt 1: Fetch via Firestore SDK
  if (firestoreAvailable && firestoreDb) {
    try {
      const { collection, getDocs } = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js');
      const querySnapshot = await getDocs(collection(firestoreDb, collectionName));
      querySnapshot.forEach((doc) => {
        remoteQuestions.push({ id: doc.id, ...doc.data() });
      });
      if (remoteQuestions.length) {
        console.log(`[Firebase] Loaded ${remoteQuestions.length} questions from Firestore SDK`);
      }
    } catch (sdkErr) {
      console.warn('[Firebase] SDK getDocs failed, trying REST API fallback:', sdkErr.message);
    }
  }

  // Attempt 2: Fetch via Firestore REST API (works across networks)
  if (!remoteQuestions.length && projectId) {
    try {
      const restUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${collectionName}?pageSize=100`;
      const res = await fetch(restUrl, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        if (data.documents && Array.isArray(data.documents)) {
          remoteQuestions = data.documents.map((doc) => parseFirestoreDocument(doc));
          console.log(`[Firebase] Loaded ${remoteQuestions.length} questions via REST`);
        }
      }
    } catch (restErr) {
      console.warn('[Firebase] Firestore REST fetch notice:', restErr.message);
    }
  }

  if (remoteQuestions.length > 0) {
    logEvent('ok', 'FIREBASE', `Loaded ${remoteQuestions.length} questions live from Firestore`);
    return filterAndSampleQuestions(remoteQuestions, itemsPerModule);
  }

  console.log('[Firebase] Question bank empty or connecting. Fallback ready.');
  return null;
}

/**
 * Saves candidate submission dossier directly to Firestore collection "submissions".
 */
export async function saveSubmissionToFirestore(dossier) {
  if (!dossier || !dossier.meta) throw new Error('Invalid dossier payload');

  const config = CFG.settings?.firebase || FIREBASE_CONFIG;
  const projectId = config.projectId || 'quizzitch-14998';
  const submissionId = dossier.meta.sessionId || `SUB-${Date.now()}`;

  const submissionPayload = {
    submissionId,
    candidateName: dossier.candidate?.name || 'Anonymous',
    candidateId: dossier.candidate?.id || '—',
    schoolName: dossier.candidate?.school || '—',
    grade: dossier.candidate?.grade || '—',
    teamId: dossier.candidate?.teamId || dossier.candidate?.id || '—',
    totalItems: dossier.summary?.totalItems || 20,
    answeredCount: dossier.summary?.answeredCount || 0,
    skippedCount: dossier.summary?.skippedCount || 0,
    timeConsumedSec: dossier.summary?.timeConsumedSec || 0,
    verdict: dossier.meta?.verdict || 'ACCEPTED',
    submitReason: dossier.meta?.submitReason || 'CANDIDATE_SUBMIT',
    integrityHash: dossier.meta?.integrityHash || '',
    submittedAt: dossier.meta?.generated || new Date().toISOString(),
    submittedTimestamp: Date.now(),
    proctoring: { ...(dossier.proctoring || {}) },
    items: (dossier.items || []).map((it) => ({
      n: it.n,
      questionId: it.questionId,
      moduleShort: it.moduleShort,
      selectedIndices: it.selectedIndices || [],
      selectedText: it.selectedText || [],
      seconds: it.seconds || 0
    }))
  };

  // Attempt 1: Via Firestore SDK
  if (firestoreAvailable && firestoreDb) {
    try {
      const { doc, setDoc } = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js');
      await setDoc(doc(firestoreDb, 'submissions', submissionId), submissionPayload);
      console.log(`[Firebase] Submission ${submissionId} recorded via SDK`);
      logEvent('ok', 'FIREBASE', `Submission stored in Firestore (ID: ${submissionId})`);
      return { success: true, submissionId };
    } catch (err) {
      console.warn('[Firebase] SDK submission failed, attempting REST save:', err.message);
    }
  }

  // Attempt 2: Via Firestore REST API
  try {
    const fields = {};
    for (const [k, v] of Object.entries(submissionPayload)) {
      if (typeof v === 'string') fields[k] = { stringValue: v };
      else if (typeof v === 'number') fields[k] = Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
      else if (typeof v === 'boolean') fields[k] = { booleanValue: v };
      else if (Array.isArray(v)) {
        fields[k] = {
          arrayValue: {
            values: v.map((item) => ({ stringValue: typeof item === 'object' ? JSON.stringify(item) : String(item) }))
          }
        };
      } else if (typeof v === 'object' && v !== null) {
        fields[k] = { stringValue: JSON.stringify(v) };
      }
    }

    const restUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/submissions/${submissionId}`;
    const res = await fetch(restUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields })
    });

    if (res.ok) {
      console.log(`[Firebase] Submission ${submissionId} recorded via REST`);
      logEvent('ok', 'FIREBASE', `Submission stored in Firestore REST (ID: ${submissionId})`);
      return { success: true, submissionId };
    }
  } catch (restErr) {
    console.warn('[Firebase] REST submission error:', restErr.message);
  }

  return { success: true, submissionId, localOnly: true };
}

/**
 * Updates student presence in "active_students" collection (real-time heartbeat).
 */
export async function updateStudentPresence(student) {
  if (!student || !student.sessionId) return;
  if (!firestoreAvailable || !firestoreDb) return;

  try {
    const { doc, setDoc } = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js');
    await setDoc(doc(firestoreDb, 'active_students', student.sessionId), {
      sessionId: student.sessionId,
      name: student.name || 'Anonymous',
      teamId: student.teamId || student.id || '—',
      school: student.school || '—',
      grade: student.grade || '—',
      stage: student.stage || 'preflight',
      strikes: student.strikes || 0,
      blurCount: student.blurCount || 0,
      currentQuestion: (student.currentQuestion != null) ? student.currentQuestion + 1 : 1,
      answeredCount: student.answeredCount || 0,
      lastPing: Date.now(),
      lastPingStr: new Date().toLocaleTimeString(),
      isOnline: student.stage !== 'offline'
    }, { merge: true });
  } catch (_) {
    // Non-blocking telemetry
  }
}

/**
 * Subscribes to real-time exam control status ("waiting", "active", "paused", "ended").
 */
export async function listenExamControl(onStatusChange) {
  if (!firestoreAvailable || !firestoreDb) return () => {};

  try {
    const { doc, onSnapshot } = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js');
    const unsub = onSnapshot(doc(firestoreDb, 'exam_control', 'status'), (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.data();
        if (onStatusChange) onStatusChange(data);
      }
    }, (err) => {
      console.warn('[Firebase] Exam control listener notice:', err.message);
    });
    return unsub;
  } catch (_) {
    return () => {};
  }
}

/**
 * Broadcasts exam control status from Admin Portal.
 */
export async function setExamControlStatus(statusData) {
  if (!firestoreAvailable || !firestoreDb) {
    throw new Error('Firestore not initialized');
  }

  const { doc, setDoc } = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js');
  await setDoc(doc(firestoreDb, 'exam_control', 'status'), {
    ...statusData,
    updatedAt: Date.now()
  }, { merge: true });
  return true;
}

/**
 * Subscribes to active students in real time (for Admin Portal).
 */
export async function listenActiveStudents(callback) {
  if (!firestoreAvailable || !firestoreDb) return () => {};

  try {
    const { collection, onSnapshot } = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js');
    const unsub = onSnapshot(collection(firestoreDb, 'active_students'), (snapshot) => {
      const students = [];
      snapshot.forEach((doc) => {
        students.push({ id: doc.id, ...doc.data() });
      });
      if (callback) callback(students);
    }, (err) => {
      console.warn('[Firebase] Active students listener error:', err);
    });
    return unsub;
  } catch (_) {
    return () => {};
  }
}

/**
 * Subscribes to submissions in real time (for Admin Portal).
 */
export async function listenSubmissions(callback) {
  if (!firestoreAvailable || !firestoreDb) return () => {};

  try {
    const { collection, onSnapshot, query, orderBy } = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js');
    const q = query(collection(firestoreDb, 'submissions'), orderBy('submittedTimestamp', 'desc'));
    const unsub = onSnapshot(q, (snapshot) => {
      const submissions = [];
      snapshot.forEach((doc) => {
        submissions.push({ id: doc.id, ...doc.data() });
      });
      if (callback) callback(submissions);
    }, (err) => {
      console.warn('[Firebase] Submissions listener error:', err);
    });
    return unsub;
  } catch (_) {
    return () => {};
  }
}

/**
 * Seeds default questions into Firestore (Admin utility).
 */
export async function seedQuestionsToFirestore(questions) {
  if (!firestoreAvailable || !firestoreDb) throw new Error('Firestore not available');
  if (!Array.isArray(questions) || !questions.length) throw new Error('No questions provided to seed');

  const { doc, setDoc } = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js');
  const collectionName = CFG.settings?.firebase?.collection || 'quizzitch_questions';

  let count = 0;
  for (const q of questions) {
    const qId = q.id || `Q-${count + 1}`;
    await setDoc(doc(firestoreDb, collectionName, qId), {
      catId: q.catId ?? 0,
      scheme: q.scheme || 'standard',
      question: q.question || '',
      supplement: q.supplement || '',
      options: q.options || []
    }, { merge: true });
    count++;
  }
  return count;
}

/**
 * Parses a raw Firestore document object from the REST API into standard JSON
 */
function parseFirestoreDocument(doc) {
  const fields = doc.fields || {};
  const obj = { id: doc.name?.split('/').pop() || '' };

  for (const [key, val] of Object.entries(fields)) {
    if ('stringValue' in val) obj[key] = val.stringValue;
    else if ('integerValue' in val) obj[key] = parseInt(val.integerValue, 10);
    else if ('doubleValue' in val) obj[key] = parseFloat(val.doubleValue);
    else if ('booleanValue' in val) obj[key] = val.booleanValue;
    else if ('arrayValue' in val) {
      obj[key] = (val.arrayValue.values || []).map((v) => v.stringValue ?? Object.values(v)[0]);
    }
  }
  return obj;
}

/**
 * Partitions questions by catId and samples itemsPerModule
 */
function filterAndSampleQuestions(questions, itemsPerModule) {
  const modules = CFG.modules || [];
  const selected = [];

  modules.forEach((mod) => {
    const inMod = questions.filter((q) => q.catId === mod.id);
    const shuffled = [...inMod].sort(() => Math.random() - 0.5);
    selected.push(...shuffled.slice(0, itemsPerModule));
  });

  return selected.length ? selected : questions;
}
