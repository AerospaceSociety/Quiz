/* ==========================================================================
   QUIZZITCH — core/app.js
   Application bootstrapper, Jotform/C26 Team ID access logic,
   fullscreen management, review drawer, final summary, and Firebase question fetching.
   ========================================================================== */

import {
  CFG, S, bus, EV, Vault,
  buildQuestionSession, newSessionId, setStage,
  logEvent, toast, answeredCount
} from './state.js';

import * as view from '../quiz/render.js';
import * as engine from '../quiz/engine.js';
import { installSandbox } from '../security/sandbox.js';
import {
  installMonitor, armMonitor,
  requestFullscreen, toggleFullscreen,
  fullscreenElement, attachForcedFullscreenAutoTrigger
} from '../security/monitor.js';
import {
  installProctor, engageCamera, captureBaseline, mountLiveFeed
} from '../security/proctor.js';
import { printDossier } from '../utils/export.js';
import { lookupRegistration, extractQuizzitchTeam, normalizeUid } from '../utils/registration.js';
import { initFirebase, fetchQuestionsFromFirestore, updateStudentPresence, listenExamControl } from '../utils/firebase.js';

let currentLoadedTeam = null;
let presenceTimerHandle = null;
let examControlUnsub = null;

/* --- 01 · CONFIG LOADING & VALIDATION -------------------------------------- */
async function loadJSON(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status} ${res.statusText}`);
  return await res.json();
}

function validateConfig(settings, questions) {
  const problems = [];
  if (!settings || typeof settings !== 'object') problems.push('settings.json did not parse to an object.');
  if (!Array.isArray(questions) || !questions.length) problems.push('questions.json must be a non-empty array.');

  ['exam', 'security', 'proctoring', 'schemes', 'modules', 'registry', 'meta', 'briefing']
    .forEach((key) => {
      if (!(key in settings)) problems.push(`settings.json is missing the "${key}" block.`);
    });

  questions.forEach((q, i) => {
    const at = `questions.json item ${i + 1} (id ${q && q.id})`;
    if (!q || typeof q !== 'object') { problems.push(`${at}: not an object.`); return; }
    if (typeof q.question !== 'string' || !q.question.trim()) problems.push(`${at}: "question" is missing.`);
    if (!Array.isArray(q.options) || q.options.length < 2) problems.push(`${at}: needs at least two options.`);
  });

  return problems;
}

/* --- 02 · JOTFORM & C26 TEAM ID ACCESS LOGIC -------------------------------- */
export async function verifyAndLoadTeam(queryOverride = null) {
  const inputEl = view.el('in-team-id') || view.el('in-id') || view.el('in-code');
  const rawQuery = queryOverride != null ? queryOverride : (inputEl?.value || '');
  const query = rawQuery.trim();

  if (!query) {
    view.setText('hint-team-id', 'Please enter your Team ID or Registration UID (e.g. CLT-2026-SCH-00042-QUIZ-T1).');
    return null;
  }

  view.setText('hint-team-id', 'Searching official registration records…');
  const reg = await lookupRegistration(query);

  if (!reg) {
    view.setText('hint-team-id', `No registration found for "${query}". Please check your official Team ID and try again.`);
    toast('Team Not Found', `No registered Quizzitch team found for ${query}.`, 'warn', 4500);
    return null;
  }

  const teamInfo = extractQuizzitchTeam(reg, query);
  currentLoadedTeam = teamInfo;

  // Autofill School
  const schoolEl = view.el('in-school');
  if (schoolEl && teamInfo.schoolName) schoolEl.value = teamInfo.schoolName;

  // Autofill Team ID
  const idEl = view.el('in-id');
  if (idEl) idEl.value = teamInfo.teamId;

  const teamIdInput = view.el('in-team-id');
  if (teamIdInput && teamIdInput.value !== teamInfo.teamId) {
    teamIdInput.value = query;
  }

  // Populate Candidate Name dropdown from team roster
  const nameSelect = view.el('in-name-select');
  if (nameSelect) {
    nameSelect.innerHTML = '<option value="">— Select Your Registered Name —</option>';
    teamInfo.members.forEach((m, idx) => {
      const opt = document.createElement('option');
      opt.value = m.name;
      opt.dataset.class = m.class || '11';
      opt.dataset.email = m.email || '';
      opt.dataset.memberId = m.memberId || `${teamInfo.teamId}-M${idx + 1}`;
      opt.textContent = `${m.name} (Class ${m.class || '—'})`;
      nameSelect.appendChild(opt);
    });

    // If query was a specific member ID or name, preselect that member
    const normQ = normalizeUid(query);
    const matchingMemberIdx = teamInfo.members.findIndex((m) => {
      return (m.memberId && normalizeUid(m.memberId) === normQ) || normalizeUid(m.name) === normQ;
    });

    if (matchingMemberIdx > -1) {
      nameSelect.selectedIndex = matchingMemberIdx + 1;
      applySelectedMember(nameSelect.options[matchingMemberIdx + 1]);
    } else if (teamInfo.members.length === 1) {
      nameSelect.selectedIndex = 1;
      applySelectedMember(nameSelect.options[1]);
    }
  }

  // Show verified team status card
  const teamCard = view.el('team-verified-card');
  if (teamCard) {
    teamCard.hidden = false;
    view.setText('tv-school', teamInfo.schoolName);
    view.setText('tv-team', `${teamInfo.teamName} · ${teamInfo.teamId}`);
    view.setText('tv-members', `${teamInfo.members.length} registered participant(s)`);
  }

  view.setText('hint-team-id', `✓ Verified: ${teamInfo.teamName} (${teamInfo.schoolName})`);
  toast('Team Roster Loaded', `Loaded ${teamInfo.members.length} candidate(s) for ${teamInfo.teamName}`, 'ok', 3500);

  evaluateGates();
  return teamInfo;
}

function applySelectedMember(option) {
  if (!option || !option.value) return;
  const name = option.value;
  const cls = option.dataset.class;
  const email = option.dataset.email;
  const memberId = option.dataset.memberId;

  const nameInput = view.el('in-name');
  if (nameInput) nameInput.value = name;

  const gradeSelect = view.el('in-grade');
  if (gradeSelect && cls) gradeSelect.value = cls;

  S.candidate.name = name;
  S.candidate.grade = cls || '';
  S.candidate.email = email || '';
  S.candidate.memberId = memberId || '';

  if (currentLoadedTeam) {
    S.candidate.school = currentLoadedTeam.schoolName;
    S.candidate.id = currentLoadedTeam.teamId;
    S.candidate.teamId = currentLoadedTeam.teamId;
    S.candidate.teamName = currentLoadedTeam.teamName;
  }

  view.setText('hint-name-select', `Identified: ${name} (ID: ${memberId || 'Active'})`);
  evaluateGates();
}

function readRegistry() {
  const teamInput = view.el('in-team-id');
  S.candidate.code = teamInput?.value.trim().toUpperCase() || view.el('in-code')?.value.trim().toUpperCase() || '';

  const nameSelect = view.el('in-name-select');
  if (nameSelect && nameSelect.value) {
    S.candidate.name = nameSelect.value.trim();
  } else {
    S.candidate.name = view.el('in-name')?.value.trim() || '';
  }

  S.candidate.id = view.el('in-id')?.value.trim().toUpperCase() || S.candidate.teamId || S.candidate.code;
  S.candidate.grade = view.el('in-grade')?.value || '';
  S.candidate.school = view.el('in-school')?.value.trim() || '';
}

function evaluateGates() {
  readRegistry();
  const reg = CFG.settings?.registry || {};
  const idPattern = new RegExp(reg.idPattern || '.*', 'i');
  const idOk = idPattern.test(S.candidate.id) || S.candidate.id.length >= 4;
  const codeOk = S.candidate.code.length >= 3;

  const hasName = S.candidate.name.length >= (reg.minNameLength || 2);
  const hasSchool = S.candidate.school.length >= 2;
  const hasGrade = !!S.candidate.grade;

  const gates = {
    code: codeOk,
    registry: hasName && idOk && hasGrade && hasSchool,
    optic: !!S.baseline || S.degraded || !CFG.settings.proctoring.requireBaselineSnapshot,
    ack: view.el('ack')?.checked || false
  };

  view.markFieldValidity(
    'in-team-id',
    codeOk || S.candidate.code.length === 0,
    'hint-team-id',
    null
  );

  let note = '';
  if (!codeOk && S.candidate.code.length > 0) {
    note = 'Valid Team ID or Registration UID required.';
  } else if (!hasName) {
    note = 'Select your name from the registered team roster.';
  } else if (!gates.registry) {
    note = 'Complete candidate information to proceed.';
  } else if (!gates.optic) {
    note = 'Camera baseline verification required.';
  } else if (!gates.ack) {
    note = 'Please acknowledge the examination honor code.';
  }

  view.paintGates(gates, note);
  bus.emit(EV.GATES, gates);
  return Object.values(gates).every(Boolean);
}

/* --- 03 · STAGE TRANSITIONS & PRESENCE ----------------------------------- */
export function sendPresence(stageOverride = null) {
  if (!S.sessionId || !S.candidate.name) return;
  updateStudentPresence({
    sessionId: S.sessionId,
    name: S.candidate.name,
    id: S.candidate.id || S.candidate.teamId,
    teamId: S.candidate.teamId || S.candidate.id,
    school: S.candidate.school,
    grade: S.candidate.grade,
    stage: stageOverride || S.stage,
    strikes: S.strikes || 0,
    blurCount: S.blurCount || 0,
    currentQuestion: S.idx,
    answeredCount: answeredCount()
  });
}

function enterWaitingRoom() {
  if (!evaluateGates()) return;

  logEvent('ok', 'STAGE', `Candidate authenticated: ${S.candidate.name} (${S.candidate.id})`);
  toast('Access Granted', `Welcome ${S.candidate.name}. Entering waiting lounge.`, 'ok', 4000);

  // Transition to Waiting Room Stage
  setStage('lounge');
  sendPresence();

  // Start periodic presence heartbeat
  if (presenceTimerHandle) clearInterval(presenceTimerHandle);
  presenceTimerHandle = setInterval(() => sendPresence(), 8000);

  // Listen to invigilator exam control broadcast
  if (!examControlUnsub) {
    listenExamControl((ctrl) => {
      if (!ctrl || !ctrl.status) return;
      if (ctrl.status === 'active' && S.stage === 'lounge') {
        const loungeClock = view.el('lounge-clock');
        if (loungeClock) loungeClock.textContent = '00:00 · LIVE';
        const loungeBtn = view.el('btn-lounge-start');
        if (loungeBtn) {
          loungeBtn.textContent = '🚀 START ASSESSMENT NOW (FULLSCREEN)';
          loungeBtn.classList.add('pulse');
        }
        toast('Assessment Live', 'Invigilator has released the assessment. Click Start Assessment to begin.', 'ok', 6000);
      }
    }).then((unsub) => {
      examControlUnsub = unsub;
    }).catch(() => {});
  }

  // Start synchronized lounge countdown
  engine.startLoungeTimer(() => {
    toast('Synchronized Start', 'The assessment window has opened! Please click Start to enter.', 'accent', 4000);
    const loungeBtn = view.el('btn-lounge-start');
    if (loungeBtn) {
      loungeBtn.textContent = '🚀 START ASSESSMENT NOW (FULLSCREEN)';
      loungeBtn.classList.add('pulse');
    }
  });
}

async function launchExam() {
  engine.cancelLoungeTimer();

  const btn = view.el('btn-lounge-start');
  if (btn) btn.disabled = true;

  // Request fullscreen inside direct user click
  if (CFG.settings.security.requireFullscreen) {
    try {
      await requestFullscreen();
    } catch (err) {
      console.warn('[Fullscreen] Request deferred, modal will catch:', err.message);
    }
  }

  beginExam();
}

function beginExam() {
  setStage('live');
  mountLiveFeed();
  armMonitor();
  engine.startClock();
  engine.go(0);
  logEvent('ok', 'STAGE', 'Candidate entered live assessment workspace');
  toast('Assessment Started', 'Good luck! Attempt questions and use the review drawer anytime.', 'ok', 5000);

  // If fullscreen is mandatory and not engaged yet, display forced containment modal
  if (CFG.settings.security.requireFullscreen && !fullscreenElement()) {
    view.showForcedFullscreenModal(0, S.maxFsExitTries || 3);
    attachForcedFullscreenAutoTrigger();
  }

  sendPresence();
}

/* --- 04 · CONTROLS & EVENT WIRING ----------------------------------------- */
function wireControls() {
  // Team ID lookup
  const teamInput = view.el('in-team-id');
  if (teamInput) {
    teamInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        verifyAndLoadTeam();
      }
    });
  }

  const verifyBtn = view.el('btn-verify-team');
  if (verifyBtn) verifyBtn.addEventListener('click', () => verifyAndLoadTeam());

  // Candidate Name Dropdown
  const nameSelect = view.el('in-name-select');
  if (nameSelect) {
    nameSelect.addEventListener('change', () => {
      applySelectedMember(nameSelect.selectedOptions[0]);
    });
  }

  // Registry inputs
  ['in-name', 'in-id', 'in-grade', 'in-school'].forEach((id) => {
    const n = view.el(id);
    if (n) {
      n.addEventListener('input', evaluateGates);
      n.addEventListener('change', evaluateGates);
    }
  });

  const ack = view.el('ack');
  if (ack) ack.addEventListener('change', evaluateGates);

  const camBtn = view.el('btn-cam');
  if (camBtn) camBtn.addEventListener('click', engageCamera);

  const snapBtn = view.el('btn-snap');
  if (snapBtn) snapBtn.addEventListener('click', captureBaseline);

  // Pre-flight action: Proceed to Waiting Room
  const launchBtn = view.el('btn-launch');
  if (launchBtn) launchBtn.addEventListener('click', enterWaitingRoom);

  // Lounge Action: Start Assessment
  const loungeStartBtn = view.el('btn-lounge-start');
  if (loungeStartBtn) loungeStartBtn.addEventListener('click', launchExam);

  // Fullscreen toggle in HUD (safe handler that avoids accidental exit strikes)
  const fsToggleBtn = view.el('btn-fs-toggle');
  if (fsToggleBtn) {
    fsToggleBtn.addEventListener('click', () => {
      if (fullscreenElement()) {
        toast('Continuous Fullscreen Active', 'Continuous fullscreen is mandatory for assessment integrity.', 'info', 3000);
      } else {
        requestFullscreen().catch(() => {});
      }
    });
  }

  // Fullscreen re-entry prompt in banner
  const reenterFsBtn = view.el('btn-reenter-fs');
  if (reenterFsBtn) reenterFsBtn.addEventListener('click', requestFullscreen);

  // Forced Fullscreen modal action
  const forceFsBtn = view.el('btn-force-fullscreen');
  if (forceFsBtn) forceFsBtn.addEventListener('click', requestFullscreen);

  const forcedModal = view.el('modal-fs-forced');
  if (forcedModal) forcedModal.addEventListener('click', requestFullscreen);

  // Question Navigator Actions
  const prevBtn = view.el('btn-prev');
  if (prevBtn) {
    prevBtn.addEventListener('click', () => {
      engine.prev();
      sendPresence();
    });
  }

  const nextBtn = view.el('btn-next');
  if (nextBtn) {
    nextBtn.addEventListener('click', () => {
      if (S.idx === CFG.questions.length - 1) {
        engine.openFinalReview();
      } else {
        engine.next();
      }
      sendPresence();
    });
  }

  const clearBtn = view.el('btn-clear');
  if (clearBtn) clearBtn.addEventListener('click', engine.clearResponse);

  const flagBtn = view.el('btn-flag');
  if (flagBtn) flagBtn.addEventListener('click', engine.toggleFlag);

  // Review Drawer triggers
  const openReviewBtn = view.el('btn-open-review');
  if (openReviewBtn) openReviewBtn.addEventListener('click', engine.openReviewDrawer);

  const closeReviewBtn = view.el('btn-close-review');
  if (closeReviewBtn) closeReviewBtn.addEventListener('click', engine.closeReviewDrawer);

  // Review drawer filter chips
  document.querySelectorAll('.review-filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      view.setReviewFilter(chip.dataset.filter || 'all');
    });
  });

  // Submit trigger -> opens Final Review summary modal
  const submitBtn = view.el('btn-submit');
  if (submitBtn) {
    submitBtn.addEventListener('click', engine.openFinalReview);
  }

  // Final Review Modal buttons
  const finReturnBtn = view.el('btn-fin-return');
  if (finReturnBtn) finReturnBtn.addEventListener('click', engine.closeFinalReview);

  const finSubmitBtn = view.el('btn-fin-submit');
  if (finSubmitBtn) {
    finSubmitBtn.addEventListener('click', () => {
      engine.closeFinalReview();
      engine.sealExam('CANDIDATE_SUBMIT');
    });
  }

  // Dossier print action
  const printBtn = view.el('btn-print');
  if (printBtn) printBtn.addEventListener('click', printDossier);

  // Intent subscriptions
  bus.on(EV.INTENT_NAV, (i) => {
    engine.go(i);
    sendPresence();
  });
  bus.on(EV.INTENT_PICK, (optIdx) => {
    engine.pick(optIdx);
    sendPresence();
  });
  bus.on(EV.INTENT_MODULE, (catId) => engine.setModule(catId));

  // Update presence on exam sealing
  bus.on(EV.SEALED, () => {
    if (presenceTimerHandle) clearInterval(presenceTimerHandle);
    sendPresence('sealed');
  });

  // Telemetry on disconnect
  window.addEventListener('beforeunload', () => {
    sendPresence('offline');
  });
}

/* --- 05 · BOOTSTRAPPER ---------------------------------------------------- */
async function boot() {
  S.bootedAt = Date.now();
  S.sessionId = newSessionId();
  view.paintSession(S.sessionId);

  try {
    const [settings, rawQuestions] = await Promise.all([
      loadJSON('config/settings.json'),
      loadJSON('config/questions.json')
    ]);

    const problems = validateConfig(settings, rawQuestions);
    if (problems.length) {
      console.error('[Quizzitch] Config validation faults:', problems);
    }

    CFG.settings = settings;
    CFG.rawQuestions = rawQuestions;
    CFG.modules = settings.modules || [];
    CFG.schemes = settings.schemes || {};

    // 1. Initialize Firebase & Attempt Live Questions Fetch from Firestore
    await initFirebase(settings.firebase);
    const firestoreQuestions = await fetchQuestionsFromFirestore();

    // 2. Pool questions (using Firestore questions if available, else local questions.json)
    buildQuestionSession(firestoreQuestions);

    view.bindRenderer();
    view.buildStaticUI();

    installSandbox({
      onLaunch: enterWaitingRoom,
      onNext: () => {
        if (S.idx === CFG.questions.length - 1) engine.openFinalReview();
        else engine.next();
      },
      onPrev: engine.prev,
      onPick: engine.pick,
      onFlag: engine.toggleFlag,
      onClear: engine.clearResponse
    });
    installMonitor();
    installProctor({ onCalibrationChange: evaluateGates });

    wireControls();

    // Check URL parameters for prefilled Team ID or UID
    const urlParams = new URLSearchParams(window.location.search);
    const paramUid = urlParams.get('uid') || urlParams.get('team') || urlParams.get('id');
    if (paramUid) {
      const teamInput = view.el('in-team-id');
      if (teamInput) teamInput.value = paramUid;
      verifyAndLoadTeam(paramUid);
    } else {
      evaluateGates();
    }

    console.log(`[Quizzitch] Portal booted successfully. Questions pooled: ${CFG.questions.length}/${CFG.rawQuestions.length}`);
  } catch (err) {
    console.error('[Quizzitch] Boot failed:', err);
    toast('Boot Error', `Failed to load portal configuration: ${err.message}`, 'danger', 10000);
  }
}

document.addEventListener('DOMContentLoaded', boot);
