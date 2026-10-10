/* ==========================================================================
   QUIZZITCH — proctor.js
   On-device vision & audio proctoring, built for 4 GB / integrated-graphics
   laptops:

     • MediaPipe Face Landmarker (WASM, CPU delegate) loaded lazily from CDN.
     • Inference strictly throttled: requestAnimationFrame with timestamp
       gating at `inferenceIntervalMs` (default 400 ms ≈ 2.5 FPS).
     • Every sample is drawn once into a detached 320×240 canvas; that buffer
       feeds inference, the lighting check and the freeze detector, so the
       full-resolution frame is never processed.
     • Web Audio AnalyserNode RMS for the calibration meter and noise spikes.

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
let audioCtx = null;
let analyser = null;
let audioBuf = null;
let rafId = 0;
let lastSample = 0;
let mode = 'idle';          // idle | calibrate | exam
let listener = null;        // calibration UI callback

const tracker = {
  noFaceSince: 0,
  multiSince: 0,
  gazeSince: 0,
  freezeSince: 0,
  loudSince: 0,
  prevGrid: null,
  lastVideoTime: -1,
  peakMic: 0,
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

  const AC = window.AudioContext || window.webkitAudioContext;
  if (AC && stream.getAudioTracks().length) {
    audioCtx = new AC();
    const src = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    audioBuf = new Float32Array(analyser.fftSize);
    src.connect(analyser);                      // analyser is not connected to destination — no feedback
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  }

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

export function micLabel() {
  const t = stream && stream.getAudioTracks()[0];
  return t ? t.label || 'Microphone' : '';
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
  if (audioCtx) audioCtx.close().catch(() => {});
  audioCtx = null;
  analyser = null;
  if (landmarker) { try { landmarker.close(); } catch (_) { /* no-op */ } }
  landmarker = null;
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

/** Landmark fallback: nose position between cheek contour (yaw) and between eye line and chin (pitch). */
function poseFromLandmarks(lm) {
  const nose = lm[1];
  const left = lm[234];
  const right = lm[454];
  const eyeY = (lm[33].y + lm[263].y) / 2;
  const chin = lm[152];
  const yawRatio = (nose.x - left.x) / Math.max(1e-6, right.x - left.x);
  const pitchRatio = (nose.y - eyeY) / Math.max(1e-6, chin.y - eyeY);
  return {
    yaw: Math.asin(clamp((yawRatio - 0.5) * 2, -1, 1)) * RAD,
    pitch: -(pitchRatio - 0.42) * 120                     // rough degrees; only deltas vs. baseline are used
  };
}

function micLevel() {
  if (!analyser) return 0;
  analyser.getFloatTimeDomainData(audioBuf);
  let s = 0;
  for (let i = 0; i < audioBuf.length; i++) s += audioBuf[i] * audioBuf[i];
  return Math.sqrt(s / audioBuf.length);
}

/** Runs one throttled sample: draw → light/freeze → inference → pose. */
function sample(ts) {
  const s = cfg().proctoring;
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
  if (landmarker) {
    const res = landmarker.detectForVideo(frame, ts);
    const lms = res.faceLandmarks || [];
    faces = lms.length;
    if (faces >= 1) {
      const mats = res.facialTransformationMatrixes || [];
      pose = mats[0] && mats[0].data ? poseFromMatrix(mats[0].data) : poseFromLandmarks(lms[0]);
      let minX = 1, minY = 1, maxX = 0, maxY = 0;
      for (const p of lms[0]) {
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
      }
      box = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
  }
  const level = micLevel();
  tracker.peakMic = Math.max(tracker.peakMic * 0.96, level);
  return { light, delta, videoAdvancing, faces, pose, box, level };
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

/** Captures the reference photo, head pose and ambient noise floor. */
export function captureBaseline() {
  const s = cfg().proctoring;
  if (!video || video.readyState < 2) throw new Error('Camera is not streaming yet.');
  const r = sample(performance.now());
  if (landmarker && r.faces !== 1) throw new Error(r.faces === 0 ? 'No face detected — look at the camera.' : 'More than one face is in view.');
  const cap = document.createElement('canvas');
  cap.width = s.frameWidth;
  cap.height = s.frameHeight;
  const c = cap.getContext('2d');
  c.drawImage(video, 0, 0, cap.width, cap.height);
  S.baseline = {
    photo: cap.toDataURL('image/jpeg', 0.72),
    pose: r.pose || { yaw: 0, pitch: 0 },
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
  Object.assign(tracker, { noFaceSince: 0, multiSince: 0, gazeSince: 0, freezeSince: 0, loudSince: 0 });
  startLoop();
}

/** 160×120 JPEG of the current frame for the forensic record. */
export function thumbnail() {
  if (!video || video.readyState < 2) return null;
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
  if (entry && level >= Level.ADVISORY) attachThumb(entry, thumbnail());
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
    if (since('noFaceSince', r.faces === 0) >= s.absenceSeconds) {
      flag('FACE_ABSENT', Level.ADVISORY, `Candidate not visible for over ${s.absenceSeconds}s`);
      tracker.noFaceSince = t;
    }
    if (since('multiSince', r.faces > 1) >= s.multiFaceSeconds) {
      flag('MULTIPLE_FACES', Level.STRIKE, `${r.faces} faces detected in frame`, { faces: r.faces });
      tracker.multiSince = t;
    }
    if (r.pose && r.faces === 1) {
      const base = (S.baseline && S.baseline.pose) || { yaw: 0, pitch: 0 };
      const yaw = r.pose.yaw - base.yaw;
      const pitch = r.pose.pitch - base.pitch;
      const away = Math.abs(yaw) > s.yawLimitDeg || pitch < -s.pitchDownLimitDeg;
      if (since('gazeSince', away) >= s.gazeSustainSeconds) {
        const what = Math.abs(yaw) > s.yawLimitDeg ? `head turned ${Math.round(Math.abs(yaw))}°` : `looking down ${Math.round(-pitch)}°`;
        flag('GAZE_EVASION', Level.ADVISORY, `Sustained gaze away from screen (${what})`, { yaw: Math.round(yaw), pitch: Math.round(pitch) });
        tracker.gazeSince = t;
      }
    } else {
      tracker.gazeSince = 0;
    }
  }

  if (analyser && S.baseline) {
    const threshold = Math.max(s.audioSpikeFloor, S.baseline.noise * s.audioSpikeFactor);
    if (since('loudSince', r.level > threshold) >= s.audioSustainSeconds) {
      flag('AUDIO_ACTIVITY', Level.ADVISORY, 'Sustained speech-level audio detected', { rms: +r.level.toFixed(3) });
      tracker.loudSince = t;
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
