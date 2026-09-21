/* ==========================================================================
   QUIZZITCH — admin/admin.js
   Standalone Admin & Invigilation Control Deck.
   Secured with Firebase Authentication.
   Features:
   - Real-time exam status controller (Start / Pause / End / Reset)
   - Real-time active students presence monitor
   - Real-time live submissions stream & dossier inspector
   - Submissions CSV/JSON export
   - 1-click cloud question bank seeder
   ========================================================================== */

import {
  FIREBASE_CONFIG,
  initFirebase,
  getFirestoreDb,
  getFirebaseAuth,
  setExamControlStatus,
  listenExamControl,
  listenActiveStudents,
  listenSubmissions,
  seedQuestionsToFirestore
} from '../utils/firebase.js';

let auth = null;
let db = null;
let currentUser = null;

let allStudents = [];
let allSubmissions = [];
let currentExamState = { status: 'waiting' };

let studentFilter = 'all';
let submissionFilter = 'all';

/* --- 01 · UTILITIES ------------------------------------------------------- */
function el(id) {
  return document.getElementById(id);
}

function showToast(title, msg, type = 'info', duration = 4000) {
  const container = el('toast-container');
  if (!container) return;

  const item = document.createElement('div');
  item.className = `admin-toast admin-toast--${type}`;
  item.innerHTML = `
    <div class="toast-title">${title}</div>
    <div class="toast-msg">${msg}</div>
  `;
  container.appendChild(item);

  setTimeout(() => {
    item.classList.add('fade-out');
    setTimeout(() => item.remove(), 400);
  }, duration);
}

function formatTimeAgo(ts) {
  if (!ts) return 'Never';
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 10) return 'Just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}

function formatDuration(sec) {
  const s = Math.round(Number(sec) || 0);
  const m = Math.floor(s / 60);
  const remSec = s % 60;
  return `${m}m ${remSec < 10 ? '0' : ''}${remSec}s`;
}

function formatDate(isoOrTs) {
  if (!isoOrTs) return '—';
  try {
    const d = new Date(isoOrTs);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch (_) {
    return String(isoOrTs);
  }
}

/* --- 02 · AUTHENTICATION -------------------------------------------------- */
async function initAuth() {
  await initFirebase();
  auth = getFirebaseAuth();
  db = getFirestoreDb();

  const { onAuthStateChanged } = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js');
  onAuthStateChanged(auth, (user) => {
    currentUser = user;
    if (user) {
      handleAuthSuccess(user);
    } else {
      handleSignOutUI();
    }
  });
}

function handleAuthSuccess(user) {
  el('auth-view').hidden = true;
  el('dashboard-view').hidden = false;

  const userEmailEl = el('admin-user-email');
  if (userEmailEl) {
    userEmailEl.textContent = user.isAnonymous ? 'Invigilator (Quick Access)' : (user.email || 'Admin');
  }

  showToast('Authenticated', `Welcome to Quizzitch Invigilation Deck.`, 'success');
  startRealtimeSubscriptions();
}

function handleSignOutUI() {
  el('auth-view').hidden = false;
  el('dashboard-view').hidden = true;
}

async function loginWithEmail(email, password) {
  const errBox = el('auth-error');
  if (errBox) errBox.hidden = true;

  try {
    const { signInWithEmailAndPassword } = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js');
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    console.error('[Admin Auth] Sign in error:', err);
    if (errBox) {
      errBox.hidden = false;
      errBox.textContent = `Sign in error: ${err.message}. If Email provider is not enabled in Firebase Console, use Quick Invigilator Access below.`;
    }
    showToast('Login Failed', err.message, 'danger');
  }
}

async function loginAnonymously() {
  const errBox = el('auth-error');
  if (errBox) errBox.hidden = true;

  try {
    const { signInAnonymously } = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js');
    await signInAnonymously(auth);
  } catch (err) {
    console.error('[Admin Auth] Anonymous error:', err);
    if (errBox) {
      errBox.hidden = false;
      errBox.textContent = `Quick access error: ${err.message}. Please enable Anonymous or Email Auth in Firebase Console.`;
    }
    showToast('Quick Access Error', err.message, 'danger');
  }
}

async function handleSignOut() {
  try {
    const { signOut } = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js');
    await signOut(auth);
    showToast('Signed Out', 'You have been disconnected from the Invigilation Deck.', 'info');
  } catch (err) {
    console.warn('Sign out error:', err);
  }
}

/* --- 03 · REALTIME SUBSCRIPTIONS ----------------------------------------- */
function startRealtimeSubscriptions() {
  // 1. Exam Control Status
  listenExamControl((ctrl) => {
    if (!ctrl) return;
    currentExamState = ctrl;
    renderExamControlState(ctrl);
  });

  // 2. Active Students
  listenActiveStudents((students) => {
    allStudents = students;
    renderStudentsMonitor();
    updateStudentCounter();
  });

  // 3. Submissions
  listenSubmissions((subs) => {
    allSubmissions = subs;
    renderSubmissionsMonitor();
    updateSubmissionCounter();
  });
}

/* --- 04 · EXAM CONTROL DECK ----------------------------------------------- */
function renderExamControlState(ctrl) {
  const status = (ctrl && ctrl.status) ? ctrl.status.toUpperCase() : 'WAITING';
  const badge = el('exam-status-badge');
  const desc = el('exam-status-desc');
  const startBtn = el('btn-exam-start');
  const pauseBtn = el('btn-exam-pause');
  const endBtn = el('btn-exam-end');

  if (badge) {
    badge.textContent = status;
    badge.className = `status-pill status-pill--${status.toLowerCase()}`;
  }

  if (desc) {
    if (status === 'ACTIVE') {
      const timeStr = ctrl.startedAt ? new Date(ctrl.startedAt).toLocaleTimeString() : 'Now';
      desc.innerHTML = `🟢 <b>EXAM IS LIVE</b> · Started at ${timeStr}. Candidates in lounge can now enter live workspace.`;
    } else if (status === 'PAUSED') {
      desc.innerHTML = `🟡 <b>EXAM PAUSED</b> · Students have received pause advisory banner.`;
    } else if (status === 'ENDED') {
      desc.innerHTML = `🔴 <b>EXAM CONCLUDED</b> · No further submissions permitted.`;
    } else {
      desc.innerHTML = `⚪ <b>WAITING LOUNGE ACTIVE</b> · Students are in pre-flight or waiting lounge.`;
    }
  }

  if (startBtn) startBtn.disabled = status === 'ACTIVE';
  if (pauseBtn) pauseBtn.disabled = status !== 'ACTIVE';
  if (endBtn) endBtn.disabled = status === 'ENDED';
}

async function triggerExamStart() {
  if (!confirm('Are you sure you want to START / RELEASE the assessment globally for all students?')) return;
  try {
    await setExamControlStatus({
      status: 'active',
      startedAt: Date.now(),
      startedBy: currentUser?.email || 'Invigilator'
    });
    showToast('Exam Released', 'The assessment is now LIVE across all student portals.', 'success');
  } catch (err) {
    showToast('Command Failed', err.message, 'danger');
  }
}

async function triggerExamPause() {
  if (!confirm('Pause the assessment for all candidates?')) return;
  try {
    await setExamControlStatus({
      status: 'paused',
      pausedAt: Date.now(),
      pausedBy: currentUser?.email || 'Invigilator'
    });
    showToast('Exam Paused', 'Assessment paused globally.', 'warning');
  } catch (err) {
    showToast('Command Failed', err.message, 'danger');
  }
}

async function triggerExamEnd() {
  if (!confirm('CONCLUDE AND SEAL THE ASSESSMENT? This indicates the testing window is closed.')) return;
  try {
    await setExamControlStatus({
      status: 'ended',
      endedAt: Date.now(),
      endedBy: currentUser?.email || 'Invigilator'
    });
    showToast('Exam Ended', 'Assessment marked as concluded.', 'danger');
  } catch (err) {
    showToast('Command Failed', err.message, 'danger');
  }
}

async function triggerExamReset() {
  if (!confirm('Reset exam state back to WAITING LOUNGE?')) return;
  try {
    await setExamControlStatus({
      status: 'waiting',
      resetAt: Date.now(),
      resetBy: currentUser?.email || 'Invigilator'
    });
    showToast('Exam Reset', 'Exam state reset to WAITING.', 'info');
  } catch (err) {
    showToast('Command Failed', err.message, 'danger');
  }
}

/* --- 05 · ACTIVE STUDENTS MONITOR ----------------------------------------- */
function updateStudentCounter() {
  const now = Date.now();
  // Count as online if lastPing was within last 60 seconds and stage is not offline
  const onlineCount = allStudents.filter((s) => {
    return s.stage !== 'offline' && (now - (s.lastPing || 0) < 60000);
  }).length;

  const countEl = el('metric-students-online');
  if (countEl) countEl.textContent = String(onlineCount);

  const totalEl = el('metric-students-total');
  if (totalEl) totalEl.textContent = `${allStudents.length} registered sessions`;
}

function renderStudentsMonitor() {
  const tbody = el('tbody-students');
  if (!tbody) return;

  const searchVal = (el('student-search')?.value || '').toLowerCase().trim();
  const now = Date.now();

  const filtered = allStudents.filter((s) => {
    const isRecent = now - (s.lastPing || 0) < 60000;
    const isOnline = s.stage !== 'offline' && isRecent;

    if (studentFilter === 'online' && !isOnline) return false;
    if (studentFilter === 'lounge' && s.stage !== 'lounge') return false;
    if (studentFilter === 'live' && s.stage !== 'live') return false;
    if (studentFilter === 'sealed' && s.stage !== 'sealed') return false;

    if (searchVal) {
      const matchName = (s.name || '').toLowerCase().includes(searchVal);
      const matchTeam = (s.teamId || '').toLowerCase().includes(searchVal);
      const matchSchool = (s.school || '').toLowerCase().includes(searchVal);
      return matchName || matchTeam || matchSchool;
    }
    return true;
  });

  if (!filtered.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="table-empty">No active candidate sessions matching filter.</td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = filtered.map((s) => {
    const isRecent = now - (s.lastPing || 0) < 60000;
    const isOnline = s.stage !== 'offline' && isRecent;
    const statusClass = isOnline ? 'online' : 'offline';
    const stageBadgeClass = s.stage === 'live' ? 'accent' : (s.stage === 'sealed' ? 'success' : 'sub');

    return `
      <tr>
        <td>
          <div class="cand-cell">
            <span class="status-dot status-dot--${statusClass}" title="${isOnline ? 'Online' : 'Offline'}"></span>
            <div>
              <div class="cand-name">${escapeHTML(s.name || 'Candidate')}</div>
              <div class="cand-sub">${escapeHTML(s.grade ? 'Class ' + s.grade : '')} · ID: ${escapeHTML(s.sessionId?.slice(0, 12) || '—')}</div>
            </div>
          </div>
        </td>
        <td>
          <div class="cand-team-code">${escapeHTML(s.teamId || '—')}</div>
        </td>
        <td class="school-cell">${escapeHTML(s.school || '—')}</td>
        <td>
          <span class="badge badge--${stageBadgeClass}">
            ${s.stage === 'live' ? '📝 IN EXAM' : (s.stage === 'sealed' ? '✓ SUBMITTED' : (s.stage === 'lounge' ? '⏳ LOUNGE' : s.stage))}
          </span>
        </td>
        <td>
          ${s.stage === 'live' ? `<b>Q${s.currentQuestion || 1}</b> (${s.answeredCount || 0} answered)` : (s.stage === 'sealed' ? 'Finished' : '—')}
        </td>
        <td>
          <span class="strike-badge ${s.strikes > 0 ? 'is-warn' : ''}">
            ${s.strikes || 0} strikes / ${s.blurCount || 0} blurs
          </span>
        </td>
        <td class="time-cell">${formatTimeAgo(s.lastPing)}</td>
      </tr>
    `;
  }).join('');
}

/* --- 06 · SUBMISSIONS MONITOR --------------------------------------------- */
function updateSubmissionCounter() {
  const countEl = el('metric-submissions-total');
  if (countEl) countEl.textContent = String(allSubmissions.length);

  const flagged = allSubmissions.filter((s) => s.verdict !== 'ACCEPTED').length;
  const flagEl = el('metric-flagged-total');
  if (flagEl) flagEl.textContent = `${flagged} flagged`;
}

function renderSubmissionsMonitor() {
  const tbody = el('tbody-submissions');
  if (!tbody) return;

  const searchVal = (el('submission-search')?.value || '').toLowerCase().trim();

  const filtered = allSubmissions.filter((s) => {
    if (submissionFilter === 'accepted' && s.verdict !== 'ACCEPTED') return false;
    if (submissionFilter === 'flagged' && s.verdict === 'ACCEPTED') return false;

    if (searchVal) {
      const matchName = (s.candidateName || '').toLowerCase().includes(searchVal);
      const matchTeam = (s.teamId || '').toLowerCase().includes(searchVal);
      const matchSchool = (s.schoolName || '').toLowerCase().includes(searchVal);
      return matchName || matchTeam || matchSchool;
    }
    return true;
  });

  if (!filtered.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="table-empty">No submissions recorded yet. Submissions stream in real-time when candidates submit.</td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = filtered.map((s, idx) => {
    const isAccepted = s.verdict === 'ACCEPTED';
    return `
      <tr>
        <td class="time-cell">${formatDate(s.submittedTimestamp || s.submittedAt)}</td>
        <td>
          <div class="cand-name">${escapeHTML(s.candidateName || 'Candidate')}</div>
          <div class="cand-sub">${escapeHTML(s.teamId || '—')}</div>
        </td>
        <td class="school-cell">${escapeHTML(s.schoolName || '—')}</td>
        <td>
          <b>${s.answeredCount || 0}</b> / ${s.totalItems || 20}
          <div class="cand-sub">${formatDuration(s.timeConsumedSec)}</div>
        </td>
        <td>
          <span class="badge ${isAccepted ? 'badge--success' : 'badge--danger'}">
            ${isAccepted ? '✓ ACCEPTED' : '⚠️ ' + escapeHTML(s.verdict || 'FLAGGED')}
          </span>
        </td>
        <td>
          <span class="cand-sub">${escapeHTML(s.submitReason || 'CANDIDATE_SUBMIT')}</span>
        </td>
        <td>
          <button class="btn btn--sub btn--xs btn-inspect" data-idx="${idx}" type="button">
            Inspect
          </button>
        </td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('.btn-inspect').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx, 10);
      openDossierModal(filtered[idx]);
    });
  });
}

function openDossierModal(submission) {
  const modal = el('modal-inspect-dossier');
  if (!modal || !submission) return;

  el('dossier-cand-name').textContent = submission.candidateName || 'Anonymous';
  el('dossier-cand-team').textContent = `${submission.teamId || '—'} · ${submission.schoolName || '—'}`;
  el('dossier-time').textContent = formatDate(submission.submittedTimestamp || submission.submittedAt);
  el('dossier-verdict').innerHTML = submission.verdict === 'ACCEPTED'
    ? '<span class="badge badge--success">✓ ACCEPTED</span>'
    : `<span class="badge badge--danger">⚠️ ${submission.verdict}</span>`;
  el('dossier-reason').textContent = submission.submitReason || 'CANDIDATE_SUBMIT';
  el('dossier-answered').textContent = `${submission.answeredCount || 0} / ${submission.totalItems || 20} (Skipped: ${submission.skippedCount || 0})`;
  el('dossier-duration').textContent = formatDuration(submission.timeConsumedSec);
  el('dossier-hash').textContent = submission.integrityHash || '—';

  // Items table
  const itemsTbody = el('dossier-items-body');
  if (itemsTbody) {
    const items = submission.items || [];
    if (!items.length) {
      itemsTbody.innerHTML = '<tr><td colspan="4" class="table-empty">No detailed items available.</td></tr>';
    } else {
      itemsTbody.innerHTML = items.map((it) => `
        <tr>
          <td>Q${it.n || '—'}</td>
          <td>${escapeHTML(it.moduleShort || '—')}</td>
          <td>${escapeHTML((it.selectedText && it.selectedText.join(', ')) || 'Unanswered / Skipped')}</td>
          <td>${it.seconds ? `${Math.round(it.seconds)}s` : '0s'}</td>
        </tr>
      `).join('');
    }
  }

  modal.hidden = false;
}

function closeDossierModal() {
  const modal = el('modal-inspect-dossier');
  if (modal) modal.hidden = true;
}

/* --- 07 · EXPORTS (CSV & JSON) -------------------------------------------- */
function exportSubmissionsCSV() {
  if (!allSubmissions.length) {
    showToast('Export Notice', 'No submissions to export yet.', 'warning');
    return;
  }

  const headers = [
    'Submission ID',
    'Candidate Name',
    'Team ID',
    'School',
    'Grade',
    'Total Items',
    'Answered',
    'Skipped',
    'Time Consumed (s)',
    'Verdict',
    'Submit Reason',
    'Submitted Timestamp',
    'Integrity Hash'
  ];

  const rows = allSubmissions.map((s) => [
    `"${s.submissionId || ''}"`,
    `"${(s.candidateName || '').replace(/"/g, '""')}"`,
    `"${(s.teamId || '').replace(/"/g, '""')}"`,
    `"${(s.schoolName || '').replace(/"/g, '""')}"`,
    `"${s.grade || ''}"`,
    s.totalItems || 20,
    s.answeredCount || 0,
    s.skippedCount || 0,
    Math.round(s.timeConsumedSec || 0),
    `"${s.verdict || 'ACCEPTED'}"`,
    `"${s.submitReason || 'CANDIDATE_SUBMIT'}"`,
    `"${s.submittedAt || new Date(s.submittedTimestamp).toISOString()}"`,
    `"${s.integrityHash || ''}"`
  ]);

  const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  triggerDownload(blob, `QUIZZITCH_SUBMISSIONS_${Date.now()}.csv`);
  showToast('CSV Exported', `Exported ${allSubmissions.length} submissions to CSV.`, 'success');
}

function exportSubmissionsJSON() {
  if (!allSubmissions.length) {
    showToast('Export Notice', 'No submissions to export yet.', 'warning');
    return;
  }

  const blob = new Blob([JSON.stringify(allSubmissions, null, 2)], { type: 'application/json' });
  triggerDownload(blob, `QUIZZITCH_SUBMISSIONS_ALL_${Date.now()}.json`);
  showToast('JSON Exported', `Exported ${allSubmissions.length} submissions to JSON.`, 'success');
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* --- 08 · QUESTION BANK SEEDER -------------------------------------------- */
async function seedDefaultQuestions() {
  if (!confirm('Upload/Seed the 20 official questions from config/questions.json into Firestore?')) return;

  try {
    showToast('Seeding Questions', 'Fetching config/questions.json…', 'info');
    const res = await fetch('config/questions.json');
    if (!res.ok) throw new Error(`Could not load config/questions.json: ${res.status}`);
    const questions = await res.json();

    showToast('Uploading to Firestore', `Seeding ${questions.length} questions to quizzitch_questions collection…`, 'info');
    const count = await seedQuestionsToFirestore(questions);
    showToast('Questions Seeded', `Successfully uploaded ${count} questions to Firestore.`, 'success', 6000);
  } catch (err) {
    console.error('Seeding error:', err);
    showToast('Seeding Failed', err.message, 'danger', 6000);
  }
}

/* --- 09 · HTML ESCAPE HELPER --------------------------------------------- */
function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/* --- 10 · WIRE EVENT HANDLERS -------------------------------------------- */
function wireEvents() {
  // Login Form
  const authForm = el('form-admin-login');
  if (authForm) {
    authForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const email = el('input-admin-email')?.value.trim();
      const pass = el('input-admin-password')?.value;
      if (email && pass) {
        loginWithEmail(email, pass);
      }
    });
  }

  // Quick Invigilator Access button
  const quickAuthBtn = el('btn-quick-admin');
  if (quickAuthBtn) {
    quickAuthBtn.addEventListener('click', loginAnonymously);
  }

  // Sign Out
  const signOutBtn = el('btn-admin-signout');
  if (signOutBtn) {
    signOutBtn.addEventListener('click', handleSignOut);
  }

  // Exam Controls
  const startBtn = el('btn-exam-start');
  if (startBtn) startBtn.addEventListener('click', triggerExamStart);

  const pauseBtn = el('btn-exam-pause');
  if (pauseBtn) pauseBtn.addEventListener('click', triggerExamPause);

  const endBtn = el('btn-exam-end');
  if (endBtn) endBtn.addEventListener('click', triggerExamEnd);

  const resetBtn = el('btn-exam-reset');
  if (resetBtn) resetBtn.addEventListener('click', triggerExamReset);

  // Student Filters
  const studentSearch = el('student-search');
  if (studentSearch) studentSearch.addEventListener('input', renderStudentsMonitor);

  document.querySelectorAll('.btn-filter-student').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.btn-filter-student').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      studentFilter = btn.dataset.filter || 'all';
      renderStudentsMonitor();
    });
  });

  // Submission Filters
  const subSearch = el('submission-search');
  if (subSearch) subSearch.addEventListener('input', renderSubmissionsMonitor);

  document.querySelectorAll('.btn-filter-sub').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.btn-filter-sub').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      submissionFilter = btn.dataset.filter || 'all';
      renderSubmissionsMonitor();
    });
  });

  // Export buttons
  const exportCsvBtn = el('btn-export-csv');
  if (exportCsvBtn) exportCsvBtn.addEventListener('click', exportSubmissionsCSV);

  const exportJsonBtn = el('btn-export-submissions-json');
  if (exportJsonBtn) exportJsonBtn.addEventListener('click', exportSubmissionsJSON);

  // Question bank seeder
  const seedBtn = el('btn-seed-questions');
  if (seedBtn) seedBtn.addEventListener('click', seedDefaultQuestions);

  // Dossier modal close
  const closeDossierBtn = el('btn-close-dossier');
  if (closeDossierBtn) closeDossierBtn.addEventListener('click', closeDossierModal);

  const dossierBackdrop = el('modal-inspect-dossier');
  if (dossierBackdrop) {
    dossierBackdrop.addEventListener('click', (e) => {
      if (e.target === dossierBackdrop) closeDossierModal();
    });
  }

  // Auto-refresh active student pings every 5 seconds
  setInterval(() => {
    updateStudentCounter();
    renderStudentsMonitor();
  }, 5000);
}

document.addEventListener('DOMContentLoaded', () => {
  wireEvents();
  initAuth();
});
