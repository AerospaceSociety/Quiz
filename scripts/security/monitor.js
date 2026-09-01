/* ==========================================================================
   QUIZZITCH — security/monitor.js
   Window focus tracking, tab-visibility tracking, history interception and
   fullscreen containment (including the re-dock countdown).
   ========================================================================== */

import {
  CFG, S, logEvent, toast, registerStrike, clockStamp
} from '../core/state.js';

import { createTicker, wallTime } from '../utils/timer.js';
import * as view from '../quiz/render.js';

let focusTicker = null;
let redockTicker = null;
let armed = false;

/* --- 01 · FULLSCREEN API (vendor-tolerant) -------------------------------- */
export function fullscreenElement() {
  return document.fullscreenElement
    || document.webkitFullscreenElement
    || document.msFullscreenElement
    || null;
}

export function fullscreenSupported() {
  const el = document.documentElement;
  return !!(el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen);
}

export function requestFullscreen() {
  const el = document.documentElement;
  const fn = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
  if (!fn) return Promise.reject(new Error('Fullscreen API unavailable'));
  try {
    const result = fn.call(el);
    return result && typeof result.then === 'function' ? result : Promise.resolve();
  } catch (err) {
    return Promise.reject(err);
  }
}

export function exitFullscreen() {
  const fn = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
  if (fullscreenElement() && fn) {
    try {
      const result = fn.call(document);
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch (_) { /* no-op */ }
  }
}

/* --- 02 · FOCUS / VISIBILITY --------------------------------------------- */
function onFocusLost(kind) {
  if (S.stage !== 'live' || S.locked) return;

  const now = Date.now();
  // blur and visibilitychange fire together on a tab switch — count them once.
  if (now - (S.lastFocusTs || 0) < CFG.settings.security.focusDedupeMs) return;
  S.lastFocusTs = now;

  S.blurCount += 1;
  view.paintFocusCounter();

  registerStrike('FOCUS', `Portal focus breach — ${kind}`);
  if (!S.locked) openFocusAlarm(kind);
}

function openFocusAlarm(kind) {
  const seconds = CFG.settings.security.focusAckSeconds;
  const max = CFG.settings.security.maxStrikes;

  view.overlay.focusAlarm(kind, `${clockStamp()} · ${wallTime()}`, `${S.strikes} / ${max}`, seconds);

  if (focusTicker) focusTicker.cancel();
  focusTicker = createTicker(
    seconds,
    (left) => view.overlay.focusCount(left),
    () => {
      focusTicker = null;
      view.overlay.close('ov-focus');
      registerStrike('FOCUS', `Focus-breach alarm not acknowledged within ${seconds}s`);
    }
  );
}

export function acknowledgeFocusAlarm() {
  if (focusTicker) { focusTicker.cancel(); focusTicker = null; }
  view.overlay.close('ov-focus');
  logEvent('ok', 'FOCUS', 'Focus-breach alarm acknowledged by candidate');

  if (S.stage === 'live' && !S.locked
      && CFG.settings.security.requireFullscreen && !fullscreenElement()) {
    beginRedock();
  }
}

/* --- 03 · FULLSCREEN CONTAINMENT ----------------------------------------- */
function onFullscreenChange() {
  if (S.stage !== 'live' || S.locked) return;

  if (fullscreenElement()) {
    if (redockTicker) { redockTicker.cancel(); redockTicker = null; }
    view.overlay.close('ov-fs');
    logEvent('ok', 'DISPLAY', 'Fullscreen containment re-established');
    return;
  }

  S.fsBreaches += 1;
  const seconds = CFG.settings.security.redockSeconds;
  logEvent('warn', 'DISPLAY', `Fullscreen containment released — ${seconds}s re-dock window opened`);
  beginRedock();
}

export function beginRedock() {
  const seconds = CFG.settings.security.redockSeconds;

  if (redockTicker) redockTicker.cancel();
  view.overlay.redockCount(seconds);
  view.overlay.open('ov-fs');

  redockTicker = createTicker(
    seconds,
    (left) => view.overlay.redockCount(left),
    () => {
      redockTicker = null;
      registerStrike('DISPLAY', `Failed to re-dock fullscreen within ${seconds}s`);
      if (S.locked) return;
      if (!fullscreenElement()) beginRedock();
      else view.overlay.close('ov-fs');
    }
  );
}

export function redock() {
  return requestFullscreen()
    .then(() => {
      if (redockTicker) { redockTicker.cancel(); redockTicker = null; }
      view.overlay.close('ov-fs');
    })
    .catch(() => {
      toast('Re-dock failed', 'The browser refused fullscreen. Press the button again.', 'danger');
    });
}

/* --- 04 · UNLOAD GUARD ---------------------------------------------------- */
function beforeUnloadGuard(e) {
  e.preventDefault();
  e.returnValue = '';
  return '';
}

/* --- 05 · INSTALL / ARM / DISARM ----------------------------------------- */
/** Attaches the passive listeners. Safe to call once at boot. */
export function installMonitor() {
  window.addEventListener('blur', () => onFocusLost('WINDOW_BLUR'));

  window.addEventListener('focus', () => {
    if (S.stage === 'live' && !S.locked && S.lastFocusTs) {
      logEvent('ok', 'FOCUS', 'Portal focus restored');
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) onFocusLost('VISIBILITY_HIDDEN');
  });

  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);

  window.addEventListener('popstate', () => {
    if (S.stage === 'live' && !S.locked) {
      history.pushState({ qz: 1 }, '', location.href);
      logEvent('warn', 'NAVIGATION', 'History navigation attempt intercepted');
    }
  });
}

/** Engages the guards that only make sense while a paper is running. */
export function armMonitor() {
  if (armed) return;
  armed = true;

  history.pushState({ qz: 1 }, '', location.href);
  if (CFG.settings.security.warnOnUnload) {
    window.addEventListener('beforeunload', beforeUnloadGuard);
  }
  logEvent('ok', 'DISPLAY', 'Fullscreen containment established');
  logEvent('info', 'MONITOR', 'Focus, visibility and history tracking active');
}

/** Releases the live-paper guards once the paper is sealed. */
export function disarmMonitor() {
  armed = false;
  window.removeEventListener('beforeunload', beforeUnloadGuard);
  if (focusTicker) { focusTicker.cancel(); focusTicker = null; }
  if (redockTicker) { redockTicker.cancel(); redockTicker = null; }
}
