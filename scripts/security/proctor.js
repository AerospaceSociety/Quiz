/* ==========================================================================
   QUIZZITCH — security/proctor.js
   WebRTC optical link, baseline snapshot and the on-device canvas analyser.

   Every frame is decoded, sampled and discarded locally. Nothing is uploaded:
   the only artefacts that leave this module are the baseline still (held in
   sessionStorage) and the derived telemetry printed into the dossier.

   The analyser is a heuristic, not face recognition. It measures
   skin-chromaticity mass, horizontal blob separation, frame-to-frame motion
   energy and bright-region geometry. Treat its output as an invigilation aid.
   ========================================================================== */

import {
  CFG, S, bus, EV, Vault,
  clamp, logEvent, toast, registerStrike
} from '../core/state.js';

import { stampUTC } from '../utils/timer.js';
import * as view from '../quiz/render.js';

let analyserHandle = null;
let analysing = false;
let prevLuma = null;
let anCtx = null;
let snapCtx = null;
let hooks = {};

/* --- 01 · INSTALL --------------------------------------------------------- */
/**
 * @param {object} h
 * @param {Function} [h.onCalibrationChange] fired when the baseline or the
 *        degraded-mode waiver changes, so the launch gates can be re-evaluated.
 */
export function installProctor(h = {}) {
  hooks = h;
  const an = view.el('an-canvas');
  const snap = view.el('snap-canvas');

  an.width = CFG.settings.proctoring.sampleWidth;
  an.height = CFG.settings.proctoring.sampleHeight;

  anCtx = an.getContext('2d', { willReadFrequently: true });
  snapCtx = snap.getContext('2d');
}

export const hasStream = () => !!S.stream;

/* --- 02 · OPTICAL LINK ---------------------------------------------------- */
export async function engageCamera() {
  const btn = view.el('btn-cam');
  const cfg = CFG.settings.proctoring.video;

  btn.disabled = true;
  view.paintOpticState('negotiating', 'Link negotiating…');

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
    S.camLabel = (track && track.label) || 'Generic optical sensor';

    const cam = view.el('cam');
    cam.srcObject = stream;
    view.mountCameraInto('optic-preflight');

    const host = view.el('optic-preflight');
    host.classList.remove('optic--idle', 'optic--offline');
    view.show('optic-placeholder', false);
    view.show('preflight-rec', true);

    view.paintOpticState('online', 'Link established');
    view.el('btn-snap').disabled = false;
    view.setText('cal-device', S.camLabel.slice(0, 40));

    try { await cam.play(); } catch (_) { /* autoplay policies */ }

    setTimeout(() => {
      const settings = track && track.getSettings ? track.getSettings() : {};
      const w = settings.width || cam.videoWidth || '?';
      const hgt = settings.height || cam.videoHeight || '?';
      view.setText('cal-res', `${w}×${hgt}`);
    }, 350);

    startAnalyser();
    logEvent('ok', 'OPTICAL', `Optical link established · sensor=${S.camLabel.slice(0, 44)}`);
    toast('Optical link established', `Sensor bound: ${S.camLabel.slice(0, 40)}`, 'accent');
  } catch (err) {
    const name = err && err.name ? err.name : 'ERROR';
    view.paintOpticState('refused', 'Link refused');

    const placeholder = view.el('optic-placeholder');
    if (placeholder) {
      placeholder.innerHTML = `Optical sensor unavailable<span>${name}</span>`;
    }
    view.el('optic-preflight').classList.add('optic--offline');
    btn.disabled = false;

    logEvent('crit', 'OPTICAL', `Optical link refused — ${name}`);
    toast('Optical link refused', (err && err.message) || 'Camera permission denied.', 'danger', 9000);

    if (CFG.settings.proctoring.allowDegradedMode) offerDegradedMode();
  }
}

/** Adds the "proceed unproctored" escape hatch beside the capture button. */
function offerDegradedMode() {
  if (document.getElementById('btn-degraded')) return;

  const btn = document.createElement('button');
  btn.id = 'btn-degraded';
  btn.type = 'button';
  btn.className = 'btn btn--ghost btn--sm';
  btn.textContent = 'Proceed without optical link';
  btn.title = 'The session will be permanently flagged as unproctored in the audit dossier.';

  btn.addEventListener('click', () => {
    S.degraded = true;
    btn.disabled = true;
    view.setText('cal-face', 'Degraded');
    view.paintOpticState('degraded', 'Link waived · degraded');
    logEvent('crit', 'OPTICAL', 'Candidate waived the optical link — session marked UNPROCTORED');
    toast('Degraded mode armed', 'This paper will be marked unproctored in the audit dossier.', 'warn', 9000);
    if (hooks.onCalibrationChange) hooks.onCalibrationChange();
  });

  view.el('btn-snap').parentNode.appendChild(btn);
}

/** Re-homes the live feed into the workspace rail when the paper arms. */
export function mountLiveFeed() {
  if (!S.stream) {
    view.paintDegradedViewport();
    return;
  }
  view.mountCameraInto('optic-live');
  view.show('live-placeholder', false);
  const cam = view.el('cam');
  const played = cam.play();
  if (played && played.catch) played.catch(() => {});
  startAnalyser();
}

export function releaseStream() {
  if (!S.stream) return;
  S.stream.getTracks().forEach((t) => t.stop());
  S.stream = null;
}

/* --- 03 · BASELINE CAPTURE ------------------------------------------------ */
export function captureBaseline() {
  if (!S.stream) return;

  const cam = view.el('cam');
  const canvas = view.el('snap-canvas');
  const w = cam.videoWidth || 640;
  const h = cam.videoHeight || 480;

  canvas.width = w;
  canvas.height = h;
  snapCtx.drawImage(cam, 0, 0, w, h);

  drawBaselineHud(w, h);

  const url = canvas.toDataURL('image/jpeg', 0.82);
  S.baseline = url;
  Vault.set('qz.baseline', url);
  Vault.set('qz.baseline.ts', new Date().toISOString());

  view.paintBaseline(url);
  logEvent('ok', 'OPTICAL', `Baseline frame captured · ${w}×${h}`);
  toast('Baseline acquired', 'Reference frame committed to the session vault.', 'accent');

  if (hooks.onCalibrationChange) hooks.onCalibrationChange();
}

/** Burns the tracking brackets and an identification bar into the still. */
function drawBaselineHud(w, h) {
  const box = S.optic.box || { x: 0.26, y: 0.16, w: 0.48, h: 0.62 };
  const bx = box.x * w;
  const by = box.y * h;
  const bw = box.w * w;
  const bh = box.h * h;
  const arm = Math.min(bw, bh) * 0.22;

  snapCtx.lineWidth = Math.max(2, w / 240);
  snapCtx.strokeStyle = '#00E5FF';
  [[bx, by, 1, 1], [bx + bw, by, -1, 1], [bx, by + bh, 1, -1], [bx + bw, by + bh, -1, -1]]
    .forEach(([cx, cy, sx, sy]) => {
      snapCtx.beginPath();
      snapCtx.moveTo(cx + sx * arm, cy);
      snapCtx.lineTo(cx, cy);
      snapCtx.lineTo(cx, cy + sy * arm);
      snapCtx.stroke();
    });

  snapCtx.strokeStyle = 'rgba(0,229,255,.32)';
  snapCtx.lineWidth = 1;
  snapCtx.beginPath();
  snapCtx.moveTo(bx + bw / 2, by);
  snapCtx.lineTo(bx + bw / 2, by + bh);
  snapCtx.moveTo(bx, by + bh / 2);
  snapCtx.lineTo(bx + bw, by + bh / 2);
  snapCtx.stroke();

  const barH = Math.max(26, Math.round(h * 0.062));
  const fontSize = Math.max(10, Math.round(barH * 0.44));

  snapCtx.fillStyle = 'rgba(9,12,16,.82)';
  snapCtx.fillRect(0, h - barH, w, barH);
  snapCtx.font = `600 ${fontSize}px "JetBrains Mono", ui-monospace, monospace`;
  snapCtx.textBaseline = 'middle';

  const mark = CFG.settings.meta.portal;
  const markW = snapCtx.measureText(mark).width;
  snapCtx.fillStyle = '#00E5FF';
  snapCtx.fillText(mark, w - markW - 10, h - barH / 2);

  let stamp = `BASELINE · ${stampUTC()}`;
  const room = w - markW - 30;
  while (stamp.length > 8 && snapCtx.measureText(stamp).width > room) stamp = stamp.slice(0, -1);
  snapCtx.fillStyle = '#F8FAFC';
  snapCtx.fillText(stamp, 10, h - barH / 2);
}

/* --- 04 · ANALYSER LOOP --------------------------------------------------- */
export function startAnalyser() {
  if (analyserHandle || !CFG.settings.proctoring.enabled) return;
  analyserHandle = setInterval(analyseFrame, CFG.settings.proctoring.sampleIntervalMs);
}

export function stopAnalyser() {
  if (analyserHandle) {
    clearInterval(analyserHandle);
    analyserHandle = null;
  }
}

function analyseFrame() {
  if (analysing || !S.stream) return;

  const cam = view.el('cam');
  if (cam.readyState < 2 || !cam.videoWidth) return;

  analysing = true;
  try {
    const p = CFG.settings.proctoring;
    const W = p.sampleWidth;
    const H = p.sampleHeight;
    const N = W * H;

    anCtx.drawImage(cam, 0, 0, W, H);
    const data = anCtx.getImageData(0, 0, W, H).data;

    const luma = new Float32Array(N);
    const skinColumns = new Float32Array(W);

    let lumaSum = 0;
    let skin = 0;
    let bright = 0;
    let sMinX = W, sMaxX = 0, sMinY = H, sMaxY = 0;
    let bMinX = W, bMaxX = 0, bMinY = H, bMaxY = 0;

    for (let i = 0, ptr = 0; i < N; i++, ptr += 4) {
      const r = data[ptr];
      const g = data[ptr + 1];
      const b = data[ptr + 2];
      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      luma[i] = y;
      lumaSum += y;

      const x = i % W;
      const yy = (i / W) | 0;

      if (y > 236) {
        bright++;
        if (x < bMinX) bMinX = x;
        if (x > bMaxX) bMaxX = x;
        if (yy < bMinY) bMinY = yy;
        if (yy > bMaxY) bMaxY = yy;
      }

      const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      if (r > 95 && g > 40 && b > 20 && (mx - mn) > 15 && Math.abs(r - g) > 15 && r > g && r > b) {
        skin++;
        skinColumns[x]++;
        if (x < sMinX) sMinX = x;
        if (x > sMaxX) sMaxX = x;
        if (yy < sMinY) sMinY = yy;
        if (yy > sMaxY) sMaxY = yy;
      }
    }

    const meanLuma = lumaSum / N;

    /* frame-to-frame motion energy */
    let motion = 0;
    if (prevLuma) {
      let acc = 0;
      for (let i = 0; i < N; i++) acc += Math.abs(luma[i] - prevLuma[i]);
      motion = acc / N;
    }
    prevLuma = luma;

    /* contour density (central-difference gradient) */
    let edgeHits = 0;
    let edgeTotal = 0;
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        const gx = luma[i + 1] - luma[i - 1];
        const gy = luma[i + W] - luma[i - W];
        if (gx * gx + gy * gy > 900) edgeHits++;
        edgeTotal++;
      }
    }
    const edgeDensity = edgeTotal ? edgeHits / edgeTotal : 0;

    /* presence: skin mass, blob-segmented across the horizontal axis */
    const skinRatio = skin / N;
    const smooth = new Float32Array(W);
    for (let x = 0; x < W; x++) {
      let acc = 0;
      let count = 0;
      for (let k = -3; k <= 3; k++) {
        const j = x + k;
        if (j >= 0 && j < W) { acc += skinColumns[j]; count++; }
      }
      smooth[x] = acc / count;
    }

    let peak = 0;
    for (let x = 0; x < W; x++) if (smooth[x] > peak) peak = smooth[x];

    const threshold = Math.max(peak * 0.30, 0.9);
    let blobs = 0;
    let run = 0;
    let gap = 0;
    let open = false;
    for (let x = 0; x < W; x++) {
      if (smooth[x] >= threshold) {
        run++; gap = 0;
        if (!open && run >= 6) { open = true; blobs++; }
      } else {
        gap++; run = 0;
        if (open && gap >= 7) open = false;
      }
    }

    const present = skinRatio > 0.010 && peak >= 1.2;
    const faces = present ? clamp(blobs || 1, 1, 3) : 0;

    /* handheld-device glare: a compact, rectangular, very bright region that is
       neither the whole scene nor a diffuse wash — i.e. a lit screen in frame */
    const brightRatio = bright / N;
    let gadget = false;
    let fill = 0;
    let aspect = 0;
    let area = 0;

    if (bright > 40 && brightRatio < 0.16 && meanLuma < 205) {
      const bw = bMaxX - bMinX + 1;
      const bh = bMaxY - bMinY + 1;
      fill = bright / (bw * bh);
      aspect = bw / bh;
      area = (bw * bh) / N;
      if (fill > 0.34 && area > 0.004 && area < 0.40 && aspect > 0.28 && aspect < 3.4
          && (edgeDensity > 0.045 || fill > 0.55)) {
        gadget = true;
      }
    }

    /* rolling telemetry */
    const o = S.optic;
    const stabilityRaw = clamp(100 - motion * 4.2, 45, 99.9);

    o.stability = o.frames ? o.stability * 0.85 + stabilityRaw * 0.15 : stabilityRaw;
    o.luma = o.frames ? o.luma * 0.8 + meanLuma * 0.2 : meanLuma;
    o.motion = o.frames ? o.motion * 0.7 + motion * 0.3 : motion;
    o.edges = edgeDensity;
    o.faces = faces;
    o.gadget = gadget;
    o.metrics = { fill, aspect, area, brightRatio };
    o.frames += 1;
    o.stabilitySum += o.stability;
    o.presenceSum += present ? 1 : 0;
    o.presencePct = (o.presenceSum / o.frames) * 100;

    if (present) {
      o.box = {
        x: clamp(sMinX / W - 0.04, 0, 0.94),
        y: clamp(sMinY / H - 0.07, 0, 0.94),
        w: clamp((sMaxX - sMinX) / W + 0.08, 0.06, 1),
        h: clamp((sMaxY - sMinY) / H + 0.12, 0.06, 1)
      };
    }

    const sample = { present, faces, gadget, meanLuma, motion, edgeDensity };
    bus.emit(EV.OPTIC, sample);

    if (S.stage === 'live' && !S.locked) evaluateThreats(sample);
  } catch (_) {
    /* A transient decode failure must never break the exam loop. */
  } finally {
    analysing = false;
  }
}

/* --- 05 · THREAT EVALUATION ---------------------------------------------- */
function evaluateThreats({ present, faces, gadget }) {
  const p = CFG.settings.proctoring;
  const o = S.optic;
  const now = Date.now();

  o.absenceRun = present ? 0 : o.absenceRun + 1;
  o.multiRun = (present && faces > 1) ? o.multiRun + 1 : 0;
  o.gadgetRun = gadget ? o.gadgetRun + 1 : 0;

  function fire(kind, message) {
    if (now - o.cooldown[kind] < p.flagCooldownMs) return;
    o.cooldown[kind] = now;
    o.counts[kind] += 1;
    S.opticalFlags += 1;

    logEvent('crit', 'OPTICAL', message);
    toast('Optical anomaly', message, 'warn', 7000);

    if (o.counts[kind] >= p.flagsPerStrike) {
      o.counts[kind] = 0;
      registerStrike('OPTICAL', `Repeated optical anomaly (${kind}) — invigilation threshold exceeded`);
    }
  }

  if (o.absenceRun >= p.absenceFrames) {
    const seconds = (o.absenceRun * p.sampleIntervalMs / 1000).toFixed(1);
    fire('absent', `Subject absent from frame — presence lock lost for ${seconds}s`);
  }

  if (o.multiRun >= p.multiFaceFrames) {
    fire('multi', `Secondary profile in frame — face_count=${faces}, edge_var=${(o.edges * 100).toFixed(1)}%`);
  }

  if (o.gadgetRun >= p.gadgetFrames) {
    const m = o.metrics;
    fire('gadget',
      `Handheld device signature — fill=${(m.fill * 100).toFixed(0)}%, `
      + `aspect=${m.aspect.toFixed(2)}, area=${(m.area * 100).toFixed(1)}%, `
      + `stability=${o.stability.toFixed(1)}%`);
  }

  if (p.heartbeatEveryFrames && o.frames % p.heartbeatEveryFrames === 0) {
    logEvent('scan', 'SCAN',
      `Optical sweep nominal · presence=${o.presencePct.toFixed(1)}% · `
      + `stability=${o.stability.toFixed(1)}% · luma=${Math.round(o.luma)}`);
  }
}
