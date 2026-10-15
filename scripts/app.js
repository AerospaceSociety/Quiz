/* ==========================================================================
   QUIZZITCH — app.js
   Boot sequence and the five-stage candidate state machine:

     1 SIGN-IN    → format validation, roster check, identity lock
     2 CALIBRATE  → camera, lighting, MediaPipe, baseline reference
     3 PROTOCOL   → rules, integrity acknowledgement, invigilator release
     4 EXAM       → server-synced clock, workspace, proctoring, sandbox
     5 SEALED     → checksum, dispatch, printable receipt

   ES-module scope keeps every binding here private; nothing is exported to
   `window`.
   ========================================================================== */

import {
  S, Stage, Level, EV, bus, bindSettings, setStage, setClockSource, markExamStart,
  recordIncident, refreshStatus, toast, persist, loadSnapshot, clearSnapshot, freezeState, now
} from './session.js';
import * as engine from './engine.js';
import * as view from './render.js';
import * as proctor from './proctor.js';
import * as fb from './firebase.js';
import { installSandbox, armSandbox, disarmSandbox, enterFullscreen, exitFullscreen, isFullscreen, unloadPromptWithin } from './sandbox.js';
import { monoNow, syncClock, httpDateSampler, createExamClock } from './timer.js';
import {
  startTelemetry, stopTelemetry, wireEventStream, buildPackage, dispatch, flushOutbox, hasOutbox, printReceipt
} from './submission.js';
import { $, setText, show, deepFreeze, randomHex, withTimeout } from './util.js';

let settings = null;
let control = { status: 'waiting' };
let controlUnsub = null;
let privacyUnsub = null;
let privacyPurgeMarker = null;
let clock = null;
let lastEnd = null;
let resumeSnap = null;
let modelDegraded = false;
let virtualCam = false;
let sealing = false;
let resyncHandle = null;

/* --- 01 · CONFIGURATION --------------------------------------------------- */
function deepMerge(target, source) {
  const out = { ...target };
  for (const [k, v] of Object.entries(source || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = deepMerge(out[k] || {}, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

async function loadSettings() {
  const res = await fetch('config/settings.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`config/settings.json → HTTP ${res.status}`);
  let s = await res.json();
  try {
    const localRes = await fetch('config/settings.local.json', { cache: 'no-store' });
    if (localRes.ok) {
      const local = await localRes.json();
      if (local && typeof local === 'object') s = deepMerge(s, local);
    }
  } catch (_) {}
  const missing = ['meta', 'exam', 'timer', 'security', 'proctoring', 'telemetry', 'schemes', 'modules', 'divisions', 'registry', 'firebase', 'jotform']
    .filter((k) => !(k in s));
  if (missing.length) throw new Error(`settings.json is missing: ${missing.join(', ')}`);
  return deepFreeze(s);
}

const newSessionId = () => `QZ-${Date.now().toString(36).toUpperCase()}-${randomHex(3).toUpperCase()}`;

function purgeLocalStills() {
  if (S.stillsPurged) return;
  S.stillsPurged = true;
  S.baseline = null;
  S.thumbs = [];
  if (S.sealed?.forensics) {
    if (S.sealed.forensics.baseline) delete S.sealed.forensics.baseline.photo;
    S.sealed.forensics.thumbs = [];
  }
  proctor.clearStillData();
  const image = $('baseline-img');
  if (image) {
    image.removeAttribute('src');
    image.hidden = true;
  }
  const empty = $('baseline-empty');
  if (empty) {
    empty.textContent = 'Reference photo purged for privacy';
    empty.hidden = false;
  }
}

function applyStillsPurgeMarker() {
  if (!control.startedAtMs) return;
  if (Number(privacyPurgeMarker?.purgedStartedAt) === Number(control.startedAtMs)) purgeLocalStills();
  else S.stillsPurged = false;
}

function subscribePrivacyPurge() {
  if (privacyUnsub || !fb.isReady()) return;
  privacyUnsub = fb.watchStillsPurge((marker) => {
    privacyPurgeMarker = marker;
    applyStillsPurgeMarker();
  });
}

/* --- 02 · STAGE 1 · SIGN-IN ------------------------------------------------ */
function validateField(id, hint, pattern, example) {
  const input = $(id);
  let value = input.value.trim().toUpperCase();
  if (!value) { view.fieldState(id, hint, false, `Required — e.g. ${example}`); return null; }

  // Auto-prefix School UID or Individual UID if student omitted "CLT-2026-"
  if (id === 'in-school-uid' && /^(SCH|IND)-\d{4,8}$/i.test(value)) {
    value = `CLT-2026-${value}`;
  }
  input.value = value;

  if (!new RegExp(pattern, 'i').test(value)) {
    view.fieldState(id, hint, false, `Format must match ${example}`);
    return null;
  }
  view.fieldState(id, hint, true, 'Format verified');
  return value;
}

function resolveDivision(teamId) {
  if (!teamId) return settings.divisions[0] || null;
  const upper = teamId.toUpperCase();
  for (const div of settings.divisions) {
    const tokens = [div.code, ...(div.aliases || [])];
    for (const token of tokens) {
      const regex = new RegExp(`(?:^|-)${token}(?:-|$)`, 'i');
      if (regex.test(upper)) return div;
    }
  }
  if (/DISP|DEBATE|QUIZ|IPD/i.test(upper)) {
    return settings.divisions.find((d) => d.code === 'IPD') || settings.divisions[0];
  }
  if (/THEATRE|THT/i.test(upper)) {
    return settings.divisions.find((d) => d.code === 'THT') || settings.divisions[1];
  }
  return settings.divisions[0] || null;
}

function validateName() {
  const input = $('in-name');
  const value = input.value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  input.value = value;
  const min = settings.registry.minNameLength;
  if (value.length < min || !/^[\p{L}][\p{L}\p{M} .',&/()+-]*$/u.test(value)) {
    view.fieldState('in-name', 'hint-name', false, 'Enter your name (letters only).');
    return null;
  }
  view.fieldState('in-name', 'hint-name', true, 'Name accepted');
  return value;
}

async function onSignin(e) {
  e.preventDefault();
  view.signinError('');
  const r = settings.registry;
  const rawSchoolUid = validateField('in-school-uid', 'hint-school-uid', r.schoolUidPattern, r.schoolUidExample);
  const rawTeamId = validateField('in-team-id', 'hint-team-id', r.teamIdPattern, r.teamIdExample);
  const name = validateName();
  const claimCode = $('in-claim-code').value.trim().toLowerCase();
  if (!rawSchoolUid || !rawTeamId || !name) return;
  if (settings.firebase.enabled && !/^[0-9a-f]{32}$/.test(claimCode)) {
    view.fieldState('in-claim-code', 'hint-claim-code', false, 'Enter the 32-character roster access code provided by your school.');
    return;
  }
  view.fieldState('in-claim-code', 'hint-claim-code', true, 'Access code accepted');

  const consentBox = $('in-consent');
  if (!consentBox || !consentBox.checked) {
    view.signinError('You must review and accept the proctoring consent to authenticate.');
    return;
  }

  const consentVersion = (settings.security && settings.security.consentVersion) || '2026.1-DPDP-DRAFT';
  const schoolUid = rawSchoolUid;
  const isIndividual = schoolUid.includes('-IND-');

  // Strip Member ID suffix (-M1) from Team ID to get base team, while preserving memberId
  const memberMatch = rawTeamId.match(/-M(\d{1,2})$/i);
  const hasMemberSuffix = !!memberMatch;
  const cleanTeamId = hasMemberSuffix ? rawTeamId.replace(/-M\d{1,2}$/i, '') : rawTeamId;
  let memberId = hasMemberSuffix ? rawTeamId : null;

  const division = resolveDivision(cleanTeamId);
  if (!division) {
    view.fieldState('in-team-id', 'hint-team-id', false, 'Unknown event or division code in Team ID.');
    return;
  }

  view.setBusy('btn-signin', true, 'Authenticating…');
  try {
    const claim = await withTimeout(fb.claimIdentity(claimCode, {
      schoolUid,
      teamId: rawTeamId,
      name,
      consentVersion,
      consentAccepted: consentBox.checked
    }), 10000, 'Identity check');

    if (!claim.ok) {
      if (claim.reason === 'NOT_ROSTERED') {
        view.signinError('Candidate identity is not on the authorised event roster. Check details or contact invigilator.');
        return;
      }
      view.signinError(claim.reason === 'ALREADY_SUBMITTED'
        ? 'A sealed submission already exists for this candidate. Contact the invigilator if this is an error.'
        : 'This candidate is already signed in on another device. Ask the invigilator to release the lock.');
      return;
    }
    $('in-claim-code').value = '';
    subscribePrivacyPurge();

    const identityKey = claim.identityKey;
    const roster = {
      name: claim.profile.name,
      memberId: claim.profile.memberId || memberId,
      schoolName: isIndividual ? 'Independent Candidate' : '',
      consentVersion: claim.profile.consentVersion,
      consentAt: claim.profile.consentAt,
      verified: true
    };
    memberId = roster.memberId || memberId || (isIndividual ? `${cleanTeamId}-M1` : null);

    const own = await fb.getOwnSession();
    if (own && own.status === 'submitted' && own.identityKey === identityKey) {
      view.signinError('This device has already submitted a paper for this candidate.');
      return;
    }

    const snap = resumeSnap && resumeSnap.identityKey === identityKey ? resumeSnap : null;
    if (snap) {
      applySnapshot(snap);
    } else {
      resumeSnap = null;
      S.salt = randomHex(16);
      S.identityKey = identityKey;
      S.candidate = {
        schoolUid,
        teamId: cleanTeamId,
        memberId: memberId || '',
        name: roster.name,
        attemptedBy: (claim.profile && claim.profile.attemptedBy) || name,
        division: division.code,
        schoolName: roster.schoolName,
        rosterVerified: true,
        isIndividual,
        consentVersion: roster.consentVersion,
        consentAt: roster.consentAt
      };
    }
    if (own && own.identityKey === identityKey) S.strikes = Math.max(S.strikes, Number(own.strikes) || 0);

    if (!(await startTelemetry())) throw new Error('Secure session setup failed. Check your connection and ask an invigilator for help.');
    const attemptedNote = S.candidate.attemptedBy && S.candidate.attemptedBy !== S.candidate.name ? ` (attempted by ${S.candidate.attemptedBy})` : '';
    recordIncident({
      type: 'SIGNED_IN',
      level: Level.INFO,
      message: `Authenticated ${S.candidate.name}${attemptedNote} · ${cleanTeamId}${memberId ? ` (${memberId})` : ''} · ${schoolUid}${roster.verified ? ' (roster verified)' : ' (roster unverified)'}`
    });
    goCalibrate();
  } catch (err) {
    console.error('[signin]', err);
    view.signinError(`Sign-in failed: ${err.message}. Check your connection and try again.`);
  } finally {
    view.setBusy('btn-signin', false);
  }
}

function applySnapshot(snap) {
  S.sessionId = snap.sessionId;
  S.salt = snap.salt;
  S.identityKey = snap.identityKey;
  S.candidate = { ...snap.candidate };
  if (!S.candidate.consentVersion) S.candidate.consentVersion = (settings.security && settings.security.consentVersion) || '2026.1-DPDP-DRAFT';
  if (!S.candidate.consentAt) S.candidate.consentAt = snap.savedAt || Date.now();
  S.strikes = snap.strikes || 0;
  S.advisories = { ...(snap.advisories || {}) };
  S.ledger = Array.isArray(snap.ledger) ? snap.ledger.slice() : [];
  S.resumes = (snap.resumes || 0) + 1;
  if (snap.examStartedAt) markExamStart(snap.examStartedAt);
  setText('session-ref', S.sessionId);
}

function showResumeCard(snap) {
  setText('resume-name', snap.candidate.name);
  const teamLabel = snap.candidate.memberId ? `${snap.candidate.teamId} (${snap.candidate.memberId})` : snap.candidate.teamId;
  setText('resume-team', `${teamLabel} · ${snap.candidate.schoolUid}`);
  setText('resume-when', new Date(snap.savedAt).toLocaleTimeString());
  show('resume-card', true);
  show('form-signin', false);
  $('btn-resume').onclick = () => {
    $('in-school-uid').value = snap.candidate.schoolUid;
    $('in-team-id').value = snap.candidate.memberId || snap.candidate.teamId;
    $('in-name').value = snap.candidate.name;
    if ($('in-consent')) $('in-consent').checked = true;
    show('resume-card', false);
    show('form-signin', true);
    view.signinError('Enter your private roster access code to resume this session.');
    $('in-claim-code').focus();
  };
  $('btn-not-me').onclick = () => {
    show('resume-card', false);
    show('form-signin', true);
    $('in-school-uid').focus();
  };
}

/* --- 03 · STAGE 2 · CALIBRATION ------------------------------------------- */
function goCalibrate() {
  setStage(Stage.CALIBRATE);
  persist();
  view.paintCheck('camera', 'pending', 'Awaiting permission');
  view.paintCheck('light', 'pending', '—');
  loadVisionModel();
  $('btn-media').focus();
}

function loadVisionModel() {
  if (proctor.modelReady()) { view.paintCheck('model', 'pass', 'Face Landmarker ready'); return; }
  if (!settings.proctoring.enabled) {
    modelDegraded = true;
    view.paintCheck('model', 'pass', 'Proctoring disabled by configuration');
    return;
  }
  view.paintCheck('model', 'busy', 'Downloading vision engine (~10 MB, once)…');
  proctor.loadModel().then(() => {
    view.paintCheck('model', 'pass', 'Face Landmarker ready');
  }).catch((err) => {
    console.error('[proctor] model load failed', err);
    if (settings.proctoring.allowDegradedMode) {
      modelDegraded = true;
      view.paintCheck('model', 'pass', 'Unavailable — degraded mode (logged)');
      recordIncident({ type: 'PROCTOR_DEGRADED', level: Level.INFO, message: `Vision engine failed to load: ${err.message}` });
    } else {
      view.paintCheck('model', 'fail', 'Failed to load — check network, then retry');
      view.calibError('The vision engine could not be downloaded. Your network may block cdn.jsdelivr.net or storage.googleapis.com. Press “Retry vision engine” or contact the invigilator.');
      show('btn-retry-model', true);
    }
  });
}

async function onGrantMedia() {
  view.calibError('');
  view.setBusy('btn-media', true, 'Requesting access…');
  try {
    await proctor.acquireMedia($('cam'));
    show('calib-placeholder', false);
    setText('btn-media', 'Camera connected');
    $('btn-media').dataset.label = 'Camera connected';
    virtualCam = proctor.isVirtualCamera();
    if (virtualCam) {
      view.calibError(`“${proctor.cameraLabel()}” looks like virtual-camera software. Select your physical webcam in the browser's site settings and reload.`);
      recordIncident({ type: 'VIRTUAL_CAMERA', level: Level.INFO, message: `Virtual camera rejected: ${proctor.cameraLabel()}` });
    }
    recordIncident({ type: 'MEDIA_GRANTED', level: Level.INFO, message: `Camera: ${proctor.cameraLabel()}` });
    proctor.startCalibration((reading) => {
      let r = reading;
      if (virtualCam) r = { ...r, camera: false };
      if (modelDegraded) r = { ...r, model: true, oneFace: true, centred: true, degraded: true };
      view.paintCalibration(r, !!S.baseline);
      if (virtualCam) view.paintCheck('camera', 'fail', 'Virtual camera blocked');
    });
    $('btn-media').disabled = true;
  } catch (err) {
    const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
    view.calibError(denied
      ? 'Camera permission was denied. Click the camera icon in the address bar, allow camera access, then press the button again.'
      : `Could not start camera: ${err.message}`);
    view.paintCheck('camera', 'fail', denied ? 'Permission denied' : 'Unavailable');
    view.setBusy('btn-media', false);
  }
}

function onCaptureBaseline() {
  try {
    const b = proctor.captureBaseline();
    view.paintBaseline(b.photo);
    view.calibError('');
    recordIncident({
      type: 'BASELINE_CAPTURED',
      level: Level.INFO,
      message: `Baseline captured (yaw ${Math.round(b.pose.yaw)}°, pitch ${Math.round(b.pose.pitch)}°, luma ${b.light.luma})`
    });
    toast('Baseline recorded', 'Reference photo captured for this session.', 'ok', 3000);
    $('btn-to-protocol').disabled = false;
  } catch (err) {
    view.calibError(err.message);
  }
}

/* --- 04 · STAGE 3 · PROTOCOL ---------------------------------------------- */
function goProtocol() {
  if (!S.baseline) return;
  setStage(Stage.PROTOCOL);
  persist();
  view.buildProtocol();
  subscribeControl();
  view.paintRelease(control.status, $('ack').checked);
  $('ack').focus();
}

function subscribeControl() {
  if (controlUnsub) return;
  if (!fb.isReady() || !settings.exam.requireRelease) {
    control = { status: 'local' };
    return;
  }
  controlUnsub = fb.watchControl((c) => {
    const prev = control.status;
    control = c;
    applyStillsPurgeMarker();
    bus.emit(EV.CONTROL, c);
    if (S.stage === Stage.PROTOCOL) {
      view.paintRelease(c.status, $('ack').checked);
      if (c.status === 'active' && prev !== 'active') toast('Paper released', 'The invigilator has released the paper.', 'ok', 5000);
    }
    if (S.stage === Stage.EXAM) {
      if (c.status === 'ended') seal('EXAM_ENDED');
      else if (c.extensionSeconds && prev === 'active') toast('Time updated', 'The invigilator adjusted the examination window.', 'info', 5000);
    }
  });
}

/* --- 05 · STAGE 4 · EXAMINATION ------------------------------------------- */
function computeEnd() {
  const dur = settings.exam.durationSeconds;
  if (control.status !== 'local' && control.startedAtMs) {
    lastEnd = control.startedAtMs + ((control.durationSeconds || dur) + (control.extensionSeconds || 0)) * 1000;
  } else if (!lastEnd && S.examStartedAt) {
    lastEnd = S.examStartedAt + dur * 1000;
  }
  return lastEnd;
}

async function loadBank() {
  const res = await fetch('config/questions.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`Question bank HTTP ${res.status}`);
  const raw = await res.json();
  const { questions, problems } = engine.validateBank(raw);
  if (problems.length) {
    console.warn('[bank] skipped items:', problems);
    recordIncident({ type: 'BANK_WARNINGS', level: Level.INFO, message: `${problems.length} malformed bank item(s) skipped`, data: { problems: problems.slice(0, 20) } });
  }
  if (!questions.length) throw new Error('The question bank is empty or unreadable.');
  return questions;
}

/** Full handshake at paper start; periodic re-syncs use a single sample to save writes. */
async function syncServerClock(samples = settings.timer.syncSamples) {
  const samplers = [];
  if (fb.isReady()) samplers.push(['firestore', fb.serverTimeSample]);
  samplers.push(['http-date', httpDateSampler]);
  return syncClock(samplers, samples);
}

async function onEnterExam() {
  // Fullscreen must be requested synchronously inside the click gesture.
  let fsPromise = Promise.resolve();
  if (settings.security.requireFullscreen) fsPromise = withTimeout(enterFullscreen(), 4000, 'Fullscreen').catch(() => {});
  view.setBusy('btn-enter-exam', true, 'Synchronising clock & loading paper…');
  try {
    await fsPromise;
    const sync = await syncServerClock();
    let offset = sync.offset;
    S.clockSource = sync.source;
    setClockSource(() => monoNow() + offset);

    if (settings.exam.questionSource === 'firestore') {
      if (!fb.isReady()) throw new Error('The secure server paper service is unavailable.');
      const paper = await withTimeout(fb.fetchPaper(), 15000, 'Paper download');
      engine.installPaper(paper);
    } else {
      const bank = await loadBank();
      engine.buildPaper(bank, `${S.identityKey}|${settings.meta.paperId}`, S.candidate.division);
    }
    if (!S.paper.length) throw new Error('No questions are available for your division.');

    const resumed = !!(resumeSnap && resumeSnap.identityKey === S.identityKey && resumeSnap.stage === Stage.EXAM);
    if (resumed) engine.restoreAnswers(resumeSnap.answers, resumeSnap.idx);
    if (!S.examStartedAt) markExamStart(now());
    const end = computeEnd();
    if (end && end - now() <= 0) throw new Error('The examination window has already closed.');

    // Workspace
    setStage(Stage.EXAM);
    view.paintCandidate();
    view.buildModuleTabs((catId) => engine.goModule(catId));
    view.setPaletteNav((i) => engine.go(i));
    view.paintStrikes();
    view.paintProctor(S.status);
    view.paintFullscreen(isFullscreen());
    engine.go(S.idx);

    proctor.moveVideo($('selfview'));
    if (!modelDegraded) proctor.startSurveillance();
    armSandbox();

    clock = createExamClock({
      offset: 0,
      getEndMs: computeEnd,
      warnAt: settings.exam.warnAtSeconds,
      critAt: settings.exam.criticalAtSeconds,
      freezeThresholdMs: settings.timer.freezeThresholdMs || 8000,
      skewThresholdMs: settings.timer.skewThresholdMs || 3000,
      onTick: (left) => { view.paintClock(left); refreshStatus(); },
      onThreshold: (lvl) => (lvl === 'crit'
        ? toast('Five minutes remaining', 'The paper submits automatically at 00:00.', 'danger', 8000)
        : toast('Ten minutes remaining', 'Use the palette to revisit marked questions.', 'warn', 6000)),
      onExpire: () => seal('TIME_EXPIRY'),
      onAnomaly: (a) => onClockAnomaly(a, (v) => { offset = v; })
    });
    setClockSource(() => monoNow() + offset);
    clock.setOffset(offset);
    view.paintClock(clock.remaining(), sync.source === 'firestore' ? 'SERVER SYNC' : sync.source === 'http-date' ? 'HTTP SYNC' : 'LOCAL CLOCK');
    clock.start();

    resyncHandle = setInterval(async () => {
      if (!fb.isReady() || S.stage !== Stage.EXAM) return;
      try {
        const r = await syncServerClock(1);
        if (r.source !== 'local-wallclock') { offset = r.offset; clock.setOffset(offset); }
      } catch (_) { /* keep the last good offset */ }
    }, settings.timer.resyncSeconds * 1000);

    if (S.baseline) fb.writeForensicsBaseline({ sessionId: S.sessionId, baseline: S.baseline });

    recordIncident(resumed
      ? { type: 'SESSION_RESUMED', level: Level.ADVISORY, message: `Session resumed after reload/crash (resume #${S.resumes})` }
      : { type: 'EXAM_STARTED', level: Level.INFO, message: `Paper opened · ${S.paper.length} questions · clock ${sync.source} (rtt ${Math.round(sync.rtt)} ms)` });
    resumeSnap = null;
    persist();
  } catch (err) {
    console.error('[exam] start failed', err);
    if (S.stage === Stage.EXAM) setStage(Stage.PROTOCOL);
    exitFullscreen();
    toast('Could not open the paper', err.message, 'danger', 9000);
    view.paintRelease(control.status, $('ack').checked);
  } finally {
    view.setBusy('btn-enter-exam', false);
    view.paintRelease(control.status, $('ack').checked);
  }
}

async function onClockAnomaly({ kind, ms }, setOffset) {
  if (S.stage !== Stage.EXAM || sealing) return;
  if (kind === 'FREEZE') {
    if (unloadPromptWithin(ms + 1500)) {
      recordIncident({ type: 'UNLOAD_ATTEMPT', level: Level.ADVISORY, message: `Attempted to close or reload the paper (dialog held ${Math.round(ms / 1000)} s)` });
      return;
    }
    // Freeze: threshold 8000ms, advisory only, NEVER auto-submit
    recordIncident({
      type: 'DEVICE_FREEZE',
      level: Level.ADVISORY,
      message: `Execution froze for ${(ms / 1000).toFixed(1)} s (browser throttle, backgrounding or system stall)`
    });
    toast('Execution paused', 'Device freeze detected. Note that countdown continues on the server clock.', 'warn', 5000);
    return;
  }

  // Skew beyond tolerance after resync (start with 3s drift): strike. Never auto-submit.
  let resynced = false;
  try {
    const r = await syncServerClock(settings.timer.syncSamples || 3);
    if (r.source !== 'local-wallclock') {
      setOffset(r.offset);
      clock.setOffset(r.offset);
      resynced = true;
    }
  } catch (_) { /* resync best-effort */ }

  const skewSec = (Math.abs(ms) / 1000).toFixed(1);
  recordIncident({
    type: 'CLOCK_SKEW',
    level: Level.STRIKE,
    message: `System clock manipulated or drift exceeded tolerance (${skewSec} s${resynced ? ' — resynchronised with server' : ''})`
  });
  toast('Clock anomaly strike', 'System clock drift exceeded allowed tolerance.', 'danger', 6000);
}

/* --- 06 · STAGE 5 · SEAL -------------------------------------------------- */
async function seal(reason) {
  if (sealing || S.stage !== Stage.EXAM) return;
  sealing = true;
  engine.commitDwell();
  view.closeReview();
  if (reason.startsWith('MAX_STRIKES')) view.showLockout('Maximum proctoring strikes reached. Your paper is being sealed and submitted.');
  if (clock) clock.stop();
  clearInterval(resyncHandle);
  disarmSandbox();
  proctor.stopLoop();

  if (S.verdict !== 'DISQUALIFIED') {
    S.verdict = S.strikes > 0 ? 'FLAGGED' : Object.keys(S.advisories).length ? 'REVIEW' : 'CLEAN';
  }
  S.submitReason = reason;
  recordIncident({ type: 'SUBMITTED', level: Level.INFO, message: `Paper sealed · ${reason} · verdict ${S.verdict}` });

  stopTelemetry();
  const pkg = await buildPackage(reason);
  S.sealed = pkg;
  setStage(Stage.SEALED);
  freezeState();
  clearSnapshot();
  view.hideLockout();
  view.renderSealed(pkg, {
    firebase: fb.isReady() ? 'sending' : 'offline-mode',
    jotform: settings.jotform.enabled ? 'sending' : 'disabled'
  });
  exitFullscreen();
  proctor.releaseMedia();
  if (controlUnsub) controlUnsub();

  const release = () => fb.signOutUser().catch(() => {});   // frees this terminal for the next candidate
  let status;
  try {
    status = await dispatch(pkg, () => { view.paintDispatch({ ...status, firebase: 'recorded' }); release(); });
  } finally {
    S.baseline = null;
    S.thumbs = [];
    proctor.clearStillData();
    if (privacyUnsub) privacyUnsub();
    privacyUnsub = null;
    const baselineImage = $('baseline-img');
    if (baselineImage) baselineImage.removeAttribute('src');
  }
  view.paintDispatch(status);
  if (status.firebase === 'recorded') release();
}

/* --- 07 · WIRING ---------------------------------------------------------- */
function wire() {
  bus.on(EV.TOAST, view.showToast);
  bus.on(EV.STAGE, view.paintStage);
  bus.on(EV.STATUS, view.paintProctor);
  bus.on(EV.FULLSCREEN, view.paintFullscreen);
  bus.on(EV.QUESTION, () => view.renderQuestion((i) => engine.pick(i)));
  bus.on(EV.ANSWERS, () => view.renderQuestion((i) => engine.pick(i)));
  bus.on(EV.INCIDENT, (entry) => {
    if (entry.level === Level.STRIKE && S.stage === Stage.EXAM) {
      view.paintStrikes();
      toast(`Strike ${S.strikes} of ${settings.security.maxStrikes}`, entry.message, 'danger', 7000);
    }
  });
  bus.on(EV.LOCKOUT, ({ reason }) => seal(reason));

  $('form-signin').addEventListener('submit', onSignin);
  ['in-school-uid', 'in-team-id'].forEach((id) => $(id).addEventListener('input', (e) => {
    const pos = e.target.selectionStart;
    e.target.value = e.target.value.toUpperCase();
    e.target.setSelectionRange(pos, pos);
  }));

  $('btn-media').addEventListener('click', onGrantMedia);
  $('btn-baseline').addEventListener('click', onCaptureBaseline);
  $('btn-retry-model').addEventListener('click', () => { show('btn-retry-model', false); view.calibError(''); loadVisionModel(); });
  $('btn-to-protocol').addEventListener('click', goProtocol);

  $('ack').addEventListener('change', () => view.paintRelease(control.status, $('ack').checked));
  $('btn-enter-exam').addEventListener('click', onEnterExam);

  $('btn-prev').addEventListener('click', engine.prev);
  $('btn-next').addEventListener('click', engine.next);
  $('btn-clear').addEventListener('click', engine.clearSelection);
  $('btn-mark').addEventListener('click', engine.toggleMark);
  $('btn-review-submit').addEventListener('click', () => {
    engine.commitDwell();
    view.openReview((i) => { view.closeReview(); engine.go(i); });
  });
  $('btn-review-return').addEventListener('click', view.closeReview);
  $('rv-confirm').addEventListener('change', (e) => { $('btn-submit-final').disabled = !e.target.checked; });
  $('btn-submit-final').addEventListener('click', () => seal('CANDIDATE_SUBMIT'));
  $('btn-fs-return').addEventListener('click', () => enterFullscreen().catch(() => toast('Fullscreen blocked', 'Press the button again.', 'warn')));

  $('btn-print').addEventListener('click', () => {
    const c = S.candidate;
    printReceipt(`CelesteCon2026_Receipt_${c.schoolUid}_${c.teamId}_${S.sessionId}`.replace(/[^A-Za-z0-9_-]/g, ''));
  });

  const net = () => view.paintNet(navigator.onLine);
  window.addEventListener('online', net);
  window.addEventListener('offline', net);
  net();
}

/* --- 08 · BOOT ------------------------------------------------------------ */
async function boot() {
  try {
    settings = await loadSettings();
  } catch (err) {
    view.bootError(
      location.protocol === 'file:' ? 'Serve the portal over HTTP' : 'Configuration unavailable',
      location.protocol === 'file:'
        ? 'Quizzitch cannot run from file://. Start a local server (npm run dev) or deploy to static hosting.'
        : `${err.message}. Reload the page; if this persists, contact the invigilator.`
    );
    return;
  }
  bindSettings(settings);
  document.title = `Quizzitch · ${settings.meta.event}`;
  S.sessionId = newSessionId();
  setText('session-ref', S.sessionId);
  setText('build-ref', settings.meta.build);
  $('in-school-uid').placeholder = settings.registry.schoolUidExample;
  $('in-team-id').placeholder = settings.registry.teamIdExample;

  wire();
  // Shortcuts are inert while a modal or the privacy shield is covering the paper.
  installSandbox({
    onExamKey: (e) => $('modal-review').hidden && $('modal-fslock').hidden
      && !document.body.classList.contains('is-shielded') && engine.handleExamKey(e)
  });
  wireEventStream(() => S.stillsPurged ? null : proctor.thumbnail());

  const online = await withTimeout(fb.initFirebase(settings.firebase), 12000, 'Firebase init').catch(() => false);
  if (online) {
    try {
      S.uid = await withTimeout(fb.signInCandidate(), 12000, 'Anonymous sign-in');
      await flushOutbox();
      // Shared lab machines: a terminal identity that has already sealed a paper is rotated for the next candidate.
      const own = await fb.getOwnSession();
      if (own && own.status === 'submitted' && !hasOutbox()) {
        await fb.signOutUser();
        S.uid = await withTimeout(fb.signInCandidate(), 12000, 'Anonymous sign-in');
      }
    } catch (err) {
      console.error('[boot] anonymous auth failed', err);
      const isRestricted = err && (err.code === 'auth/admin-restricted-operation' || (err.message && err.message.includes('admin-restricted-operation')));
      const msg = isRestricted
        ? 'Firebase Anonymous Sign-In is blocked. Enable Anonymous provider in Firebase Console (Authentication > Sign-in method) and ensure "Enable create (sign-up)" is active under Authentication > Settings > User actions.'
        : `Could not authenticate this terminal with the examination server (${err.message}). Check the network and reload.`;
      view.bootError('Secure link unavailable', msg);
      return;
    }
  } else if (settings.firebase.enabled) {
    toast('Offline rehearsal mode', 'The examination server is unreachable. Results will not be transmitted.', 'warn', 8000);
  }
  if (!S.uid) S.uid = `local-${randomHex(6)}`;

  setStage(Stage.SIGNIN);
  resumeSnap = loadSnapshot();
  if (resumeSnap && resumeSnap.uid !== S.uid && online) resumeSnap = null;   // a different terminal identity cannot resume
  if (resumeSnap && [Stage.CALIBRATE, Stage.PROTOCOL, Stage.EXAM].includes(resumeSnap.stage)) showResumeCard(resumeSnap);
  else { resumeSnap = null; $('in-school-uid').focus(); }

  // Warm the vision engine while the candidate types.
  if (settings.proctoring.enabled) {
    const warm = () => proctor.loadModel().catch(() => {});
    if ('requestIdleCallback' in window) requestIdleCallback(warm, { timeout: 3000 }); else setTimeout(warm, 1500);
  }
}

boot().catch((err) => {
  console.error('[boot]', err);
  view.bootError('The portal failed to start', err.message);
});
