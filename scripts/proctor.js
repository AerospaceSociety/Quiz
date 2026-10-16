/* ==========================================================================
   QUIZZITCH — proctor.js
   On-device vision proctoring, built for 4 GB / integrated-graphics
   laptops:

     • MediaPipe Face Landmarker (WASM, CPU delegate) loaded lazily from CDN.
     • Inference strictly throttled: requestAnimationFrame with timestamp
       gating at `inferenceIntervalMs` (default 400 ms ≈ 2.5 FPS).
     • Every sample is drawn once into a detached 320×240 canvas; that buffer
       feeds inference, the lighting check and the freeze detector, so the
       full-resolution frame is never processed.

   Nothing leaves the device except the baseline photo and a small number of
   160×120 incident thumbnails attached to strikes.
   ========================================================================== */

import { S, cfg, Stage, Level, recordIncident, attachThumb, toast } from './session.js';
import { clamp } from './util.js';

const RAD = 180 / Math.PI;

let stream = null;
let video = null;
let frame = null;           // detached 320×240 canvas
let fctx = null;
let thumbCanvas = null;
let landmarker = null;
let loadingModel = null;
let rafId = 0;
let lastSample = 0;
let mode = 'idle';          // idle | calibrate | exam
let listener = null;        // calibration UI callback

let lastGoodPose = null;
let lastGoodPoseTime = 0;
let nullMatrixSince = 0;
const calibrationPoses = [];

const tracker = {
  noFaceSince: 0,
  missedFaceFrames: 0,
  multiSince: 0,
  gazeSince: 0,
  freezeSince: 0,
  prevGrid: null,
  lastVideoTime: -1,
  lastFlag: new Map()
};

export const hasStream = () => !!stream;
export const modelReady = () => !!landmarker;

/* --- 01 · MEDIA ACQUISITION ---------------------------------------------- */
/** Requests camera and attaches the preview. */
export async function acquireMedia(videoEl) {
  if (stream) return stream;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error(window.isSecureContext
      ? 'This browser does not support camera access.'
      : 'Camera access requires HTTPS (or localhost).');
  }
  stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user', frameRate: { ideal: 15, max: 24 } },
    audio: false
  });
  video = videoEl;
  video.srcObject = stream;
  video.muted = true;
  await video.play().catch(() => {});

  const s = cfg().proctoring;
  frame = document.createElement('canvas');
  frame.width = s.frameWidth;
  frame.height = s.frameHeight;
  fctx = frame.getContext('2d', { willReadFrequently: true });
  thumbCanvas = document.createElement('canvas');
  thumbCanvas.width = 160;
  thumbCanvas.height = 120;

  stream.getTracks().forEach((track) => {
    track.addEventListener('ended', () => {
      if (S.stage === Stage.EXAM) {
        recordIncident({ type: 'MEDIA_ENDED', level: Level.STRIKE, message: `${track.kind} track ended (device unplugged or permission revoked)` });
      }
    });
  });
  return stream;
}

export function cameraLabel() {
  const t = stream && stream.getVideoTracks()[0];
  return t ? t.label || 'Camera' : '';
}

export function isVirtualCamera() {
  const re = new RegExp(cfg().proctoring.virtualCameraPattern, 'i');
  return re.test(cameraLabel());
}

/** Moves the live <video> into a different host element (calibration → exam sidebar). */
export function moveVideo(host) {
  if (video && host && video.parentNode !== host) host.prepend(video);
}

export function releaseMedia() {
  stopLoop();
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  if (landmarker) { try { landmarker.close(); } catch (_) { /* no-op */ } }
  landmarker = null;
  lastGoodPose = null;
  lastGoodPoseTime = 0;
  nullMatrixSince = 0;
  calibrationPoses.length = 0;
}

export function clearStillData() {
  if (thumbCanvas) {
    const context = thumbCanvas.getContext('2d');
    context && context.clearRect(0, 0, thumbCanvas.width, thumbCanvas.height);
  }
}

/* --- 02 · MEDIAPIPE ------------------------------------------------------ */
export function loadModel() {
  if (landmarker) return Promise.resolve(true);
  if (loadingModel) return loadingModel;
  const s = cfg().proctoring;
  loadingModel = (async () => {
    const vision = await import(/* @vite-ignore */ s.visionBundleUrl);
    const fileset = await vision.FilesetResolver.forVisionTasks(s.wasmBaseUrl);
    landmarker = await vision.FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: s.modelUrl, delegate: s.delegate === 'GPU' ? 'GPU' : 'CPU' },
      runningMode: 'VIDEO',
      numFaces: 2,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: true
    });
    return true;
  })().catch((err) => {
    loadingModel = null;
    throw err;
  });
  return loadingModel;
}

/* --- 03 · FRAME ANALYSIS ------------------------------------------------- */
/** Mean luma and standard deviation over a sparse grid of the 320×240 buffer. */
function lighting(data, w, h) {
  let sum = 0;
  let sq = 0;
  let n = 0;
  for (let y = 4; y < h; y += 8) {
    for (let x = 4; x < w; x += 8) {
      const i = (y * w + x) * 4;
      const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      sum += l; sq += l * l; n++;
    }
  }
  const mean = sum / n;
  return { luma: mean, contrast: Math.sqrt(Math.max(0, sq / n - mean * mean)) };
}

/** 32×24 luma grid; the mean absolute delta between consecutive grids is ~0 only for a frozen feed. */
function lumaGrid(data, w, h) {
  const gw = 32;
  const gh = 24;
  const g = new Float32Array(gw * gh);
  const sx = w / gw;
  const sy = h / gh;
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const i = ((Math.floor(y * sy + sy / 2)) * w + Math.floor(x * sx + sx / 2)) * 4;
      g[y * gw + x] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
  }
  return g;
}

function gridDelta(a, b) {
  if (!a || !b) return Infinity;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

/**
 * Head pose from the facial transformation matrix (column-major 4×4). The
 * face's forward axis is the third column; with +Y up in MediaPipe's metric
 * space, a negative pitch means the head is tilted down.
 */
function poseFromMatrix(m) {
  const fx = m[8];
  const fy = m[9];
  const fz = m[10];
  return { yaw: Math.atan2(fx, fz) * RAD, pitch: Math.asin(clamp(fy, -1, 1)) * RAD };
}

let lastLandmarkerTimestamp = 0;
let isRecoveringLandmarker = false;

function nextLandmarkerTimestamp(providedTs) {
  const now = typeof providedTs === 'number' && !isNaN(providedTs) && providedTs > 0
    ? providedTs
    : performance.now();
  const safeTs = Math.max(Math.round(now), Math.round(lastLandmarkerTimestamp + 1));
  lastLandmarkerTimestamp = safeTs;
  return safeTs;
}

async function recoverLandmarker() {
  if (isRecoveringLandmarker) return;
  isRecoveringLandmarker = true;
  try {
    if (landmarker && typeof landmarker.close === 'function') {
      try { landmarker.close(); } catch (_) {}
    }
  } catch (_) {}
  landmarker = null;
  loadingModel = null;
  try {
    await loadModel();
    console.info('[proctor] FaceLandmarker recovered successfully');
  } catch (err) {
    console.warn('[proctor] landmarker recovery failed:', err.message);
  } finally {
    isRecoveringLandmarker = false;
  }
}

/** Runs one throttled sample: draw → light/freeze → inference → pose. */
function sample(ts) {
  const s = cfg().proctoring;
  if (!fctx || !frame) {
    frame = document.createElement('canvas');
    frame.width = s.frameWidth;
    frame.height = s.frameHeight;
    fctx = frame.getContext('2d', { willReadFrequently: true });
  }
  fctx.drawImage(video, 0, 0, s.frameWidth, s.frameHeight);
  const img = fctx.getImageData(0, 0, s.frameWidth, s.frameHeight);
  const light = lighting(img.data, s.frameWidth, s.frameHeight);
  const grid = lumaGrid(img.data, s.frameWidth, s.frameHeight);
  const delta = gridDelta(grid, tracker.prevGrid);
  tracker.prevGrid = grid;
  const videoAdvancing = video.currentTime !== tracker.lastVideoTime;
  tracker.lastVideoTime = video.currentTime;

  let faces = null;
  let pose = null;
  let box = null;
  let metrics = null;
  if (landmarker) {
    try {
      const safeTs = nextLandmarkerTimestamp(ts);
      const res = landmarker.detectForVideo(frame, safeTs);
      const lms = res.faceLandmarks || [];
      faces = lms.length;
      if (faces >= 1) {
        const mats = res.facialTransformationMatrixes || [];
        if (mats[0] && mats[0].data) {
          pose = poseFromMatrix(mats[0].data);
          lastGoodPose = pose;
          lastGoodPoseTime = safeTs;
          nullMatrixSince = 0;
        } else {
          // Facial transform matrix missing: hold last good pose up to 3s
          if (!nullMatrixSince) nullMatrixSince = safeTs;
          if (lastGoodPose && (safeTs - lastGoodPoseTime <= 3000)) {
            pose = lastGoodPose;
          } else {
            pose = null;
          }
        }
        if (lms[0] && lms[0].length >= 153) {
          const p10 = lms[0][10];   // forehead
          const p152 = lms[0][152]; // chin
          const p1 = lms[0][1];     // nose tip
          const dy = p152.y - p10.y;
          const dz = p152.z - p10.z;
          const landmarkPitch = Math.atan2(dz, Math.max(0.01, dy)) * RAD;
          const noseDropRatio = (p1.y - p10.y) / Math.max(0.01, dy);
          metrics = { landmarkPitch, noseDropRatio };
        }
        if (!pose && metrics) {
          pose = { yaw: 0, pitch: metrics.landmarkPitch };
        }

        let minX = 1, minY = 1, maxX = 0, maxY = 0;
        for (const p of lms[0]) {
          if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
          if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
        }
        box = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
      } else {
        nullMatrixSince = 0;
      }
    } catch (err) {
      console.warn('[proctor] landmarker inference failed:', err.message);
      const match = String(err && err.message).match(/Current minimum expected timestamp is (\d+)/i);
      if (match && match[1]) {
        lastLandmarkerTimestamp = Math.max(lastLandmarkerTimestamp, parseInt(match[1], 10) + 10);
      }
      recoverLandmarker();
    }
  }

  if (mode === 'calibrate' && pose) {
    calibrationPoses.push(pose);
    if (calibrationPoses.length > 20) calibrationPoses.shift();
  }

  return { light, delta, videoAdvancing, faces, pose, box, metrics };
}

/* --- 04 · CALIBRATION ---------------------------------------------------- */
/**
 * Stage 2 loop. `onReading` receives each sample plus derived pass/fail flags.
 */
export function startCalibration(onReading) {
  listener = onReading;
  mode = 'calibrate';
  startLoop();
}

function calibrationReading(r) {
  const s = cfg().proctoring;
  const lightOk = r.light.luma >= s.lumaMin && r.light.luma <= s.lumaMax && r.light.contrast >= s.contrastMin;
  const centred = !!r.box && Math.abs(r.box.x + r.box.w / 2 - 0.5) < 0.18 && Math.abs(r.box.y + r.box.h / 2 - 0.5) < 0.22 && r.box.w > 0.18;
  return {
    ...r,
    camera: !!stream && stream.getVideoTracks().some((t) => t.readyState === 'live'),
    lightOk,
    model: !!landmarker,
    oneFace: r.faces === 1,
    centred
  };
}

/**
 * Captures or averages the neutral head pose during calibration.
 */
export function calibrateNeutralPose() {
  if (calibrationPoses.length > 0) {
    const sumYaw = calibrationPoses.reduce((acc, p) => acc + p.yaw, 0);
    const sumPitch = calibrationPoses.reduce((acc, p) => acc + p.pitch, 0);
    return {
      yaw: sumYaw / calibrationPoses.length,
      pitch: sumPitch / calibrationPoses.length
    };
  }
  const r = sample(nextLandmarkerTimestamp());
  return (r && r.pose) ? { yaw: r.pose.yaw, pitch: r.pose.pitch } : { yaw: 0, pitch: 0 };
}

/** Captures the reference photo, head pose and ambient noise floor. */
export function captureBaseline() {
  if (S.stillsPurged) throw new Error('Reference stills were purged for privacy.');
  const s = cfg().proctoring;
  if (!video || video.readyState < 2) throw new Error('Camera is not streaming yet.');
  const r = sample(nextLandmarkerTimestamp());
  if (landmarker && r.faces !== 1) {
    if (r.faces === 0) throw new Error('No face detected — please look directly at the camera.');
    if (r.faces > 1) throw new Error('More than one face is in view.');
    throw new Error('Face calibration in progress — please look steadily at the camera and try again.');
  }
  const cap = document.createElement('canvas');
  cap.width = s.frameWidth;
  cap.height = s.frameHeight;
  const c = cap.getContext('2d');
  c.drawImage(video, 0, 0, cap.width, cap.height);
  const neutralPose = r.pose || calibrateNeutralPose();
  S.baseline = {
    photo: cap.toDataURL('image/jpeg', 0.72),
    pose: neutralPose,
    noise: 0,
    light: { luma: Math.round(r.light.luma), contrast: Math.round(r.light.contrast) },
    camera: cameraLabel(),
    capturedAt: Date.now()
  };
  return S.baseline;
}

/* --- 05 · EXAM SURVEILLANCE ---------------------------------------------- */
export function startSurveillance() {
  mode = 'exam';
  listener = null;
  lastGoodPose = null;
  lastGoodPoseTime = 0;
  nullMatrixSince = 0;
  Object.assign(tracker, { noFaceSince: 0, missedFaceFrames: 0, multiSince: 0, gazeSince: 0, freezeSince: 0 });
  startLoop();
}

/** 160×120 JPEG of the current frame for the forensic record. */
export function thumbnail() {
  if (S.stillsPurged || !video || video.readyState < 2) return null;
  const c = thumbCanvas.getContext('2d');
  c.drawImage(video, 0, 0, 160, 120);
  return thumbCanvas.toDataURL('image/jpeg', 0.6);
}

function flag(type, level, message, data) {
  const s = cfg().proctoring;
  const t = performance.now();
  if (t - (tracker.lastFlag.get(type) || 0) < s.flagCooldownSeconds * 1000) return;
  tracker.lastFlag.set(type, t);
  const entry = recordIncident({ type, level, message, data });
  if (!S.stillsPurged && entry && level >= Level.ADVISORY) attachThumb(entry, thumbnail());
  if (level === Level.ADVISORY) toast('Proctoring advisory', message, 'warn', 4000);
}

function evaluate(r, t) {
  const s = cfg().proctoring;
  const since = (key, cond) => {
    if (!cond) { tracker[key] = 0; return 0; }
    if (!tracker[key]) tracker[key] = t;
    return (t - tracker[key]) / 1000;
  };

  // Frozen / virtual feed: identical frames, or the <video> clock stopped.
  const frozen = r.delta < s.freezeDiffEpsilon || !r.videoAdvancing;
  if (since('freezeSince', frozen) >= s.freezeSeconds) {
    flag('FEED_FROZEN', Level.STRIKE, `Camera feed static for ${s.freezeSeconds}s+ (frozen or virtual camera)`, { delta: +r.delta.toFixed(3) });
    tracker.freezeSince = t;
  }

  if (r.faces != null) {
    const reqMissed = s.consecutiveMissedFramesForAbsence || 3;
    if (r.faces === 0) {
      tracker.missedFaceFrames = (tracker.missedFaceFrames || 0) + 1;
    } else {
      tracker.missedFaceFrames = 0;
    }

    const absenceQualifies = r.faces === 0 && tracker.missedFaceFrames >= reqMissed;
    if (since('noFaceSince', absenceQualifies) >= s.absenceSeconds) {
      flag('FACE_ABSENT', Level.ADVISORY, `Candidate not visible for over ${s.absenceSeconds}s`);
      tracker.noFaceSince = t;
    }
    if (since('multiSince', r.faces > 1) >= s.multiFaceSeconds) {
      flag('MULTIPLE_FACES', Level.STRIKE, `${r.faces} faces detected in frame`, { faces: r.faces });
      tracker.multiSince = t;
    }
    if (r.faces === 1) {
      if (!r.pose && !r.metrics) {
        flag('POSE_UNKNOWN', Level.ADVISORY, 'Head pose indeterminate (facial transform unavailable for 3s+)');
        tracker.gazeSince = 0;
      } else {
        const base = (S.baseline && S.baseline.pose) || { yaw: 0, pitch: 0 };
        const rawPitch = r.pose ? (r.pose.pitch - base.pitch) : 0;
        const yaw = r.pose ? (r.pose.yaw - base.yaw) : 0;

        // Strict downward gaze and head rotation detection
        const matrixDown = Math.abs(rawPitch) > s.pitchDownLimitDeg;
        const landmarkDown = r.metrics && Math.abs(r.metrics.landmarkPitch) > s.pitchDownLimitDeg;
        const noseDrop = r.metrics && r.metrics.noseDropRatio > 0.72;

        const lookingDown = matrixDown || landmarkDown || noseDrop;
        const turnedAway = Math.abs(yaw) > s.yawLimitDeg;
        const away = turnedAway || lookingDown;

        if (since('gazeSince', away) >= s.gazeSustainSeconds) {
          const deg = Math.round(Math.max(Math.abs(rawPitch), r.metrics ? Math.abs(r.metrics.landmarkPitch) : 0));
          const what = turnedAway ? `head turned ${Math.round(Math.abs(yaw))}°` : `looking down (${deg > 0 ? `${deg}°` : 'downward gaze'})`;
          flag('GAZE_EVASION', Level.ADVISORY, `Sustained gaze away from screen (${what})`, { yaw: Math.round(yaw), pitch: Math.round(rawPitch) });
          tracker.gazeSince = t;
        }
      }
    } else {
      tracker.gazeSince = 0;
    }
  }
}

/* --- 06 · THROTTLED LOOP ------------------------------------------------- */
function loop(ts) {
  rafId = requestAnimationFrame(loop);
  const interval = cfg().proctoring.inferenceIntervalMs;
  if (ts - lastSample < interval || !video || video.readyState < 2) return;
  lastSample = ts;
  try {
    const r = sample(ts);
    if (mode === 'calibrate' && listener) listener(calibrationReading(r));
    else if (mode === 'exam' && S.stage === Stage.EXAM && !S.locked) evaluate(r, ts);
  } catch (err) {
    console.warn('[proctor] sample failed:', err.message);
  }
}

function startLoop() {
  if (!rafId) rafId = requestAnimationFrame(loop);
}

export function stopLoop() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  mode = 'idle';
}
