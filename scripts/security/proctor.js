/* ==========================================================================
   QUIZZITCH — security/proctor.js
   On-device optical proctoring with TensorFlow.js COCO-SSD Object Recognition.
   ========================================================================== */

import {
  CFG, S, bus, EV, Vault,
  clamp, logEvent, toast, registerStrike
} from '../core/state.js';

import { stampUTC } from '../utils/timer.js';
import * as view from '../quiz/render.js';

let analyserHandle = null;
let analysing = false;
let cocoModel = null;
let modelLoading = false;
let lastDetectionTime = 0;
let consecutiveViolations = 0;
let hooks = {};

/* --- 01 · INSTALL & MODEL LOADING ----------------------------------------- */
export function installProctor(h = {}) {
  hooks = h;
  loadCocoModel();
}

export async function loadCocoModel() {
  if (cocoModel || modelLoading) return;
  modelLoading = true;

  try {
    if (window.cocoSsd) {
      console.log('[Proctor] Initializing on-device COCO-SSD Object Recognition model...');
      cocoModel = await window.cocoSsd.load();
      S.aiModelLoaded = true;
      view.setText('cal-ai', 'COCO-SSD Active');
      console.log('[Proctor] COCO-SSD Object Recognition model ready.');
    } else {
      console.warn('[Proctor] COCO-SSD library not loaded from CDN, running heuristic mode.');
      view.setText('cal-ai', 'Heuristic Engine');
    }
  } catch (err) {
    console.warn('[Proctor] Failed to load COCO-SSD model, fallback active:', err);
    view.setText('cal-ai', 'Heuristic Fallback');
  } finally {
    modelLoading = false;
  }
}

export const hasStream = () => !!S.stream;

/* --- 02 · CAMERA ENGAGEMENT ----------------------------------------------- */
export async function engageCamera() {
  const btn = view.el('btn-cam');
  const cfg = CFG.settings.proctoring.video || { idealWidth: 640, idealHeight: 480, facingMode: 'user' };

  if (btn) btn.disabled = true;
  view.paintOpticState('negotiating', 'Connecting sensor…');

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: cfg.idealWidth },
        height: { ideal: cfg.idealHeight },
        facingMode: cfg.facingMode
      },
      audio: false
    });

    S.stream = stream;
    const track = stream.getVideoTracks()[0];
    S.camLabel = (track && track.label) || 'Webcam Sensor';

    const cam = view.el('cam');
    cam.srcObject = stream;
    view.mountCameraInto('optic-preflight');

    const host = view.el('optic-preflight');
    if (host) {
      host.classList.remove('optic--idle', 'optic--offline');
    }
    view.show('optic-placeholder', false);
    view.show('preflight-rec', true);

    view.paintOpticState('online', 'Camera Active');
    const snapBtn = view.el('btn-snap');
    if (snapBtn) snapBtn.disabled = false;
    view.setText('cal-device', S.camLabel.slice(0, 36));

    try { await cam.play(); } catch (_) { /* policy handled */ }

    setTimeout(() => {
      const settings = track && track.getSettings ? track.getSettings() : {};
      const w = settings.width || cam.videoWidth || '?';
      const h = settings.height || cam.videoHeight || '?';
      view.setText('cal-res', `${w}×${h}`);
    }, 350);

    startAnalyser();
    logEvent('ok', 'PROCTOR', `Optical link established: ${S.camLabel.slice(0, 40)}`);
    toast('Optical Sensor Active', `Sensor connected: ${S.camLabel.slice(0, 36)}`, 'accent');

    // Trigger COCO-SSD load if pending
    if (!cocoModel) loadCocoModel();
  } catch (err) {
    view.paintOpticState('refused', 'Access Refused');
    const placeholder = view.el('optic-placeholder');
    if (placeholder) {
      placeholder.innerHTML =
        `Camera permission was refused.<br><span>Allow camera permissions in your browser URL bar and refresh.</span>`;
    }
    if (btn) btn.disabled = false;
    logEvent('crit', 'PROCTOR', `Camera engagement refused: ${err.message}`);
    toast('Camera Access Refused', 'Camera permission is required for proctoring verification.', 'danger', 8000);
  }

  if (hooks.onCalibrationChange) hooks.onCalibrationChange();
}

/* --- 03 · BASELINE SNAPSHOT ----------------------------------------------- */
export function captureBaseline() {
  if (!S.stream) return null;
  const cam = view.el('cam');
  if (cam.readyState < 2 || !cam.videoWidth) return null;

  const w = cam.videoWidth || 640;
  const h = cam.videoHeight || 480;

  const snap = view.el('snap-canvas');
  snap.width = w;
  snap.height = h;
  const ctx = snap.getContext('2d');
  ctx.drawImage(cam, 0, 0, w, h);

  // Subtle institutional watermark
  ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
  ctx.fillRect(0, h - 28, w, 28);
  ctx.fillStyle = '#94A3B8';
  ctx.font = '500 11px Inter, sans-serif';
  ctx.fillText(`CELESTECON 2026 BASELINE · ${stampUTC()}`, 12, h - 10);

  const dataUrl = snap.toDataURL('image/jpeg', 0.85);
  S.baseline = dataUrl;
  Vault.set('qz.baseline', dataUrl);

  view.paintBaseline(dataUrl);
  view.setText('cal-face', 'Baseline Verified');
  logEvent('ok', 'PROCTOR', 'Candidate optical baseline snapshot captured');
  toast('Baseline Verified', 'Profile snapshot recorded.', 'accent');

  if (hooks.onCalibrationChange) hooks.onCalibrationChange();
  return dataUrl;
}

export function mountLiveFeed() {
  view.mountCameraInto('optic-live');
  const placeholder = view.el('live-placeholder');
  if (placeholder) placeholder.hidden = true;
}

/* --- 04 · ANALYSER LOOP (OBJECT RECOGNITION + FACE PRESENCE) -------------- */
export function startAnalyser() {
  if (analyserHandle || !CFG.settings.proctoring.enabled) return;
  analyserHandle = setInterval(analyseFrame, CFG.settings.proctoring.sampleIntervalMs || 300);
}

export function stopAnalyser() {
  if (analyserHandle) {
    clearInterval(analyserHandle);
    analyserHandle = null;
  }
}

export function releaseStream() {
  stopAnalyser();
  if (S.stream) {
    S.stream.getTracks().forEach((t) => t.stop());
    S.stream = null;
  }
}

async function analyseFrame() {
  if (analysing || !S.stream) return;
  const cam = view.el('cam');
  if (cam.readyState < 2 || !cam.videoWidth) return;

  analysing = true;
  try {
    const now = Date.now();
    const objCfg = (CFG.settings.proctoring && CFG.settings.proctoring.objectRecognition) || {};
    const interval = objCfg.sampleIntervalMs || 1200;

    /* Execute AI Object Recognition when interval elapses */
    if (cocoModel && (now - lastDetectionTime >= interval)) {
      lastDetectionTime = now;
      const predictions = await cocoModel.detect(cam);

      let prohibited = null;
      let persons = 0;
      const prohibitedClasses = objCfg.prohibitedClasses || ['cell phone', 'book', 'laptop', 'tv'];

      predictions.forEach((p) => {
        const cName = p.class.toLowerCase();
        if (cName === 'person') persons++;
        if (prohibitedClasses.includes(cName) && p.score >= (objCfg.minConfidence || 0.52)) {
          prohibited = p;
        }
      });

      const videoW = cam.videoWidth;
      const videoH = cam.videoHeight;

      if (prohibited) {
        consecutiveViolations++;
        S.prohibitedDetections++;

        const [bx, by, bw, bh] = prohibited.bbox;
        bus.emit(EV.OBJECT_DETECTED, {
          found: true,
          isProhibited: true,
          className: prohibited.class,
          score: prohibited.score,
          personCount: persons,
          x: bx / videoW,
          y: by / videoH,
          w: bw / videoW,
          h: bh / videoH
        });

        if (S.stage === 'live') {
          logEvent('warn', 'AI_PROCTOR', `Prohibited object detected: ${prohibited.class} (${(prohibited.score * 100).toFixed(0)}%)`);
          toast('Proctoring Warning', `Unauthorized item detected: ${prohibited.class}. Keep desk clear!`, 'danger', 4000);

          if (consecutiveViolations >= 3) {
            consecutiveViolations = 0;
            registerStrike(`Prohibited device detected in camera feed (${prohibited.class})`);
          }
        }
      } else if (persons > 1) {
        bus.emit(EV.OBJECT_DETECTED, {
          found: false,
          personCount: persons
        });
        if (S.stage === 'live') {
          logEvent('warn', 'AI_PROCTOR', `Multiple individuals in frame (${persons} persons)`);
          toast('Proctoring Warning', 'Multiple individuals detected in proctoring feed.', 'warn', 4000);
        }
      } else if (persons === 0) {
        bus.emit(EV.OBJECT_DETECTED, {
          found: false,
          personCount: 0
        });
        if (S.stage === 'live') {
          logEvent('warn', 'AI_PROCTOR', 'Candidate face out of proctoring frame');
        }
      } else {
        consecutiveViolations = Math.max(0, consecutiveViolations - 1);
        bus.emit(EV.OBJECT_DETECTED, {
          found: false,
          personCount: 1
        });
      }
    }
  } catch (err) {
    console.warn('[Proctor] Frame analysis error:', err);
  } finally {
    analysing = false;
  }
}
