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

  registerStrike(`Portal focus breach — ${kind} (Alt+Tab / Window switch)`);
  if (!S.locked) openFocusAlarm(kind);
}

function openFocusAlarm(kind) {
  toast('Focus Warning', `Portal focus lost (${kind}). Focus changes are recorded.`, 'warn', 5000);
}

export function acknowledgeFocusAlarm() {
  logEvent('ok', 'FOCUS', 'Focus-breach alarm acknowledged by candidate');
}

export async function toggleFullscreen() {
  if (fullscreenElement()) {
    exitFullscreen();
    return false;
  } else {
    try {
      await requestFullscreen();
      return true;
    } catch (err) {
      console.warn('[Fullscreen] toggle failed:', err);
      toast('Fullscreen Notice', 'Could not engage fullscreen. Please click anywhere or press F11.', 'warn', 4000);
      return false;
    }
  }
}

let forcedTriggerAttached = false;

function autoReenterFullscreen() {
  if (fullscreenElement() || S.stage !== 'live' || S.locked) return;
  requestFullscreen().catch(() => {});
}

export function attachForcedFullscreenAutoTrigger() {
  if (forcedTriggerAttached) return;
  forcedTriggerAttached = true;
  window.addEventListener('click', autoReenterFullscreen, true);
  window.addEventListener('keydown', autoReenterFullscreen, true);
  window.addEventListener('pointerdown', autoReenterFullscreen, true);
}

export function detachForcedFullscreenAutoTrigger() {
  if (!forcedTriggerAttached) return;
  forcedTriggerAttached = false;
  window.removeEventListener('click', autoReenterFullscreen, true);
  window.removeEventListener('keydown', autoReenterFullscreen, true);
  window.removeEventListener('pointerdown', autoReenterFullscreen, true);
}

/* --- 03 · FULLSCREEN TRACKING & ENFORCEMENT ------------------------------- */
function onFullscreenChange() {
  const isFs = !!fullscreenElement();
  bus.emit(EV.FULLSCREEN, isFs);

  if (S.stage !== 'live' || S.locked) return;

  if (isFs) {
    logEvent('ok', 'DISPLAY', 'Fullscreen containment active');
    view.showFullscreenPrompt(false);
    view.hideForcedFullscreenModal();
    detachForcedFullscreenAutoTrigger();

    // Lock keyboard shortcuts if supported by browser (Chrome/Edge in Fullscreen)
    if (navigator.keyboard && typeof navigator.keyboard.lock === 'function') {
      try {
        navigator.keyboard.lock(['Escape', 'Tab', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight']);
      } catch (_) {}
    }
    return;
  }

  // Fullscreen exited (via Esc, gesture, or OS switch)
  S.fsBreaches += 1;
  S.fsExitTries = (S.fsExitTries || 0) + 1;
  const maxTries = S.maxFsExitTries || 3;

  logEvent('crit', 'DISPLAY', `Fullscreen exited by candidate (Attempt ${S.fsExitTries} of ${maxTries})`);

  if (S.fsExitTries >= maxTries) {
    toast('Disqualified: Max Fullscreen Exits', 'Exceeded 3 fullscreen exit attempts. Assessment automatically submitted.', 'danger', 10000);
    view.hideForcedFullscreenModal();
    detachForcedFullscreenAutoTrigger();
    import('../quiz/engine.js').then((eng) => {
      eng.sealExam('MAX_FULLSCREEN_EXITS_EXCEEDED');
    });
    return;
  }

  // Show forced fullscreen modal and attach auto-reentry trigger
  view.showForcedFullscreenModal(S.fsExitTries, maxTries);
  attachForcedFullscreenAutoTrigger();
  toast(`Fullscreen Exited (${S.fsExitTries}/${maxTries})`, 'Continuous fullscreen required. 3 exits will auto-submit.', 'danger', 6000);
}

export function beginRedock() {
  view.showFullscreenPrompt(true);
}

export function redock() {
  return requestFullscreen()
    .then(() => {
      logEvent('ok', 'DISPLAY', 'Fullscreen re-entered');
      view.showFullscreenPrompt(false);
      view.hideForcedFullscreenModal();
      detachForcedFullscreenAutoTrigger();
    })
    .catch(() => {
      toast('Fullscreen Notice', 'Could not switch to fullscreen. Click anywhere to re-enter.', 'info');
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
