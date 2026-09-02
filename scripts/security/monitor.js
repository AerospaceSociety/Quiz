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
  toast('Focus Warning', `Portal focus lost (${kind}). Focus changes are recorded.`, 'warn', 5000);
}

export function acknowledgeFocusAlarm() {
  logEvent('ok', 'FOCUS', 'Focus-breach alarm acknowledged by candidate');
}

/* --- 03 · FULLSCREEN TRACKING -------------------------------------------- */
function onFullscreenChange() {
  if (S.stage !== 'live' || S.locked) return;

  if (fullscreenElement()) {
    logEvent('ok', 'DISPLAY', 'Fullscreen containment active');
    return;
  }

  S.fsBreaches += 1;
  logEvent('warn', 'DISPLAY', 'Fullscreen mode exited by candidate');
  toast('Fullscreen Exited', 'Warning: You have exited fullscreen mode. You can continue your assessment, but display state changes are logged.', 'warn', 7000);
}

export function beginRedock() {
  // Graceful notification without forced screen capture
  toast('Fullscreen Advisory', 'Fullscreen mode was exited. Press F11 or click to re-enter if required.', 'warn', 6000);
}

export function redock() {
  return requestFullscreen()
    .then(() => {
      logEvent('ok', 'DISPLAY', 'Fullscreen re-entered');
    })
    .catch(() => {
      toast('Fullscreen Notice', 'Could not switch to fullscreen. You may continue in windowed mode.', 'info');
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
