/* ==========================================================================
   QUIZZITCH — sandbox.js
   Input lockdown, fullscreen enforcement, focus/visibility surveillance and
   DevTools detection.

   SCOPE, stated plainly: a web page cannot override the operating system.
   Alt+Tab, the Windows/Command key and OS screenshot tools belong to the OS.
   In fullscreen, Chromium's Keyboard Lock API lets us capture Alt+Tab, Meta
   and Esc; everywhere else these gestures still work — but every one of them
   causes a blur / visibility / fullscreen event, which this module turns into
   a timestamped strike. Deterrence plus an audit trail, not a kernel lock.
   ========================================================================== */
import { S, cfg, bus, EV, Stage, Level, recordIncident, toast, now } from './session.js';
import * as view from './render.js';

let hooks = {};
let armed = false;
let graceTimer = null;
let graceLeft = 0;
let lastFocusLoss = 0;
let focusPoll = null;
let tripwire = null;
let dimBase = null;
let resizeRaf = 0;

const inExam = () => S.stage === Stage.EXAM && !S.locked;

/* --- 01 · FULLSCREEN API -------------------------------------------------- */
export const isFullscreen = () => !!(document.fullscreenElement || document.webkitFullscreenElement);

export async function enterFullscreen() {
  const el = document.documentElement;
  const fn = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!fn) throw new Error('Fullscreen API unavailable');
  await fn.call(el, { navigationUI: 'hide' });
}

export function exitFullscreen() {
  const fn = document.exitFullscreen || document.webkitExitFullscreen;
  if (isFullscreen() && fn) Promise.resolve(fn.call(document)).catch(() => { });
}

function lockKeys() {
  if (navigator.keyboard && typeof navigator.keyboard.lock === 'function') {
    navigator.keyboard.lock(['Escape', 'Tab', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'F11', 'F12'])
      .catch(() => { });
  }
}

/* --- 02 · KEYBOARD FILTER ------------------------------------------------- */
const isEditable = (t) => !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);

function combo(e) {
  return `${e.ctrlKey ? 'Ctrl+' : ''}${e.metaKey ? 'Meta+' : ''}${e.altKey ? 'Alt+' : ''}${e.shiftKey ? 'Shift+' : ''}${e.key}`;
}

/** Returns a label when the combination must be suppressed in the current stage, else null. */
function classify(e) {
  const k = (e.key || '').toLowerCase();
  const mod = e.ctrlKey || e.metaKey;

  if (e.key === 'F12' || (mod && e.shiftKey && ['i', 'j', 'c', 'k'].includes(k))
    || (e.metaKey && e.altKey && ['i', 'j', 'c', 'u'].includes(k)) || (mod && k === 'u')) return 'DevTools';
  if (mod && k === 's') return 'Save page';
  if (mod && k === 'p' && S.stage !== Stage.SEALED) return 'Print';

  if (S.stage !== Stage.EXAM) return null;

  if (mod && ['c', 'v', 'x', 'a'].includes(k)) return 'Clipboard';
  if (e.key === 'F5' || (mod && k === 'r')) return 'Reload';
  if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return 'History navigation';
  if (e.key === 'BrowserBack' || e.key === 'BrowserForward') return 'History navigation';
  if (e.altKey && e.key === 'Tab') return 'Alt+Tab';
  if (mod && ['w', 't', 'n', 'l', 'd', 'h', 'j', 'f', 'g', 'o'].includes(k)) return 'Browser shortcut';
  if (mod && e.key === 'Tab') return 'Tab switch';
  if (e.key === 'Meta' || e.key === 'OS' || e.metaKey) return 'Windows / Command key';
  if (e.key === 'Alt' || e.key === 'ContextMenu') return 'System key';
  if (e.key === 'F11') return 'Fullscreen toggle';
  if (e.key === 'PrintScreen') return 'Screen capture';
  return null;
}

function onKeyDown(e) {
  const blocked = classify(e);
  if (blocked) {
    e.preventDefault();
    e.stopPropagation();
    if (inExam()) {
      const serious = blocked === 'DevTools' || blocked === 'Alt+Tab' || blocked === 'Screen capture';
      recordIncident({
        type: 'BLOCKED_SHORTCUT',
        level: serious ? Level.ADVISORY : Level.INFO,
        message: `Suppressed ${blocked} (${combo(e)})`,
        cooldownMs: serious ? 5000 : 0
      });
      if (serious) toast('Input blocked', `${blocked} is not permitted during the examination.`, 'warn', 3000);
    }
    return;
  }
  if (S.stage === Stage.EXAM && !isEditable(e.target) && hooks.onExamKey && hooks.onExamKey(e)) {
    e.preventDefault();
  }
}

// PrintScreen is only reported on keyup in most browsers.
function onKeyUp(e) {
  if (e.key === 'PrintScreen' && inExam()) {
    recordIncident({ type: 'SCREEN_CAPTURE', level: Level.ADVISORY, message: 'PrintScreen key pressed', cooldownMs: 5000 });
  }
}

/* --- 03 · FOCUS & VISIBILITY --------------------------------------------- */
let isBlurred = false;
let hiddenStrike = false;
let blurStart = 0;
let blurTimer = null;
let blurGraceLeft = 0;
let totalBlurCount = 0;
let cumulativeBlurSec = 0;

function startBlurGrace() {
  stopBlurGrace();
  blurGraceLeft = cfg().security.blurGraceSeconds || 5;
  view.showFsLock(blurGraceLeft);
  blurTimer = setInterval(() => {
    if (!inExam() || !isBlurred) {
      stopBlurGrace();
      return;
    }
    blurGraceLeft -= 1;
    view.showFsLock(Math.max(0, blurGraceLeft));
    if (blurGraceLeft <= 0) {
      stopBlurGrace();
      recordIncident({
        type: 'WINDOW_BLUR_TIMEOUT',
        level: Level.STRIKE,
        message: `Did not return to examination window within ${cfg().security.blurGraceSeconds || 5} s grace period`
      });
    }
  }, 1000);
}

function stopBlurGrace() {
  if (blurTimer) {
    clearInterval(blurTimer);
    blurTimer = null;
  }
}

function handleTabHidden() {
  view.setShield(true);
  if (!inExam() || hiddenStrike) return;
  hiddenStrike = true;
  stopBlurGrace();
  recordIncident({
    type: 'TAB_HIDDEN',
    level: Level.STRIKE,
    message: 'Examination tab hidden (tab switch / minimise)'
  });
  toast('Focus breach recorded', 'Minimising or switching tabs is an immediate strike with no grace period.', 'danger', 6000);
}

function handleWindowBlur() {
  if (document.hidden) {
    handleTabHidden();
    return;
  }
  view.setShield(true);
  if (!inExam() || isBlurred) return;
  isBlurred = true;
  blurStart = now();
  totalBlurCount += 1;
  startBlurGrace();
}

function handleFocusRestored() {
  stopBlurGrace();
  if (isBlurred) {
    isBlurred = false;
    const durationSec = Math.max(0, (now() - blurStart) / 1000);
    cumulativeBlurSec += durationSec;

    // Log EVERY blur as an advisory with its duration
    recordIncident({
      type: 'WINDOW_BLUR',
      level: Level.ADVISORY,
      message: `Examination window lost focus for ${durationSec.toFixed(1)} s`,
      data: { durationSec, count: totalBlurCount, cumulativeSec: cumulativeBlurSec }
    });

    const maxCum = cfg().security.blurMaxCumulativeSeconds || 20;
    const maxCnt = cfg().security.blurMaxCount || 4;

    if (cumulativeBlurSec > maxCum) {
      recordIncident({
        type: 'CUMULATIVE_BLUR_EXCEEDED',
        level: Level.STRIKE,
        message: `Cumulative off-focus time exceeded ${maxCum} s (${cumulativeBlurSec.toFixed(1)} s total)`
      });
    } else if (totalBlurCount > maxCnt) {
      recordIncident({
        type: 'BLUR_COUNT_EXCEEDED',
        level: Level.STRIKE,
        message: `Total blur count exceeded limit of ${maxCnt} (${totalBlurCount} blurs recorded)`
      });
    }
  }

  if (hiddenStrike && !document.hidden) {
    hiddenStrike = false;
    recordIncident({ type: 'TAB_RESTORED', level: Level.INFO, message: 'Examination tab visibility restored' });
  }

  if (!document.hidden && document.hasFocus()) {
    if (isFullscreen() || !cfg().security.requireFullscreen) {
      view.setShield(false);
      view.hideFsLock();
    }
  }
}

const onVisibility = () => (document.hidden ? handleTabHidden() : handleFocusRestored());
const onBlur = () => handleWindowBlur();
const onFocus = () => handleFocusRestored();

/* --- 04 · FULLSCREEN ENFORCEMENT ----------------------------------------- */
function onFullscreenChange() {
  const fs = isFullscreen();
  bus.emit(EV.FULLSCREEN, fs);
  if (!armed || !cfg().security.requireFullscreen) return;

  if (fs) {
    lockKeys();
    stopGrace();
    view.hideFsLock();
    if (document.hasFocus()) view.setShield(false);
    rebaseDims();
    if (inExam()) recordIncident({ type: 'FULLSCREEN_RESTORED', level: Level.INFO, message: 'Fullscreen containment restored' });
    return;
  }
  if (!inExam()) return;
  view.setShield(true);
  recordIncident({
    type: 'FULLSCREEN_EXIT',
    level: Level.ADVISORY,
    message: `Fullscreen exited — ${cfg().security.fullscreenGraceSeconds} s grace to return`
  });
  startGrace();
}

function startGrace() {
  stopGrace();
  graceLeft = cfg().security.fullscreenGraceSeconds;
  view.showFsLock(graceLeft);
  graceTimer = setInterval(() => {
    if (!inExam() || isFullscreen()) { stopGrace(); view.hideFsLock(); return; }
    graceLeft -= 1;
    view.showFsLock(Math.max(0, graceLeft));
    if (graceLeft <= 0) {
      recordIncident({
        type: 'FULLSCREEN_TIMEOUT',
        level: Level.STRIKE,
        message: `Did not return to fullscreen within ${cfg().security.fullscreenGraceSeconds} s`
      });
      graceLeft = cfg().security.fullscreenGraceSeconds;   // keeps striking every window until return or lockout
    }
  }, 1000);
}

function stopGrace() {
  if (graceTimer) clearInterval(graceTimer);
  graceTimer = null;
}

/* --- 05 · DEVTOOLS DETECTION --------------------------------------------- */
function rebaseDims() {
  dimBase = {
    w: window.outerWidth - window.innerWidth,
    h: window.outerHeight - window.innerHeight,
    dpr: window.devicePixelRatio
  };
}

/** Docked DevTools shrink the inner viewport without changing the outer window. */
function onResize() {
  if (resizeRaf) return;
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = 0;
    if (!inExam() || !dimBase) return;
    if (window.devicePixelRatio !== dimBase.dpr) { rebaseDims(); return; }   // zoom, not DevTools
    const th = cfg().security.devtoolsResizeThreshold;
    const dw = (window.outerWidth - window.innerWidth) - dimBase.w;
    const dh = (window.outerHeight - window.innerHeight) - dimBase.h;
    if (dw > th || dh > th) {
      recordIncident({
        type: 'DEVTOOLS_SUSPECTED',
        level: Level.ADVISORY,
        message: `Viewport shrank by ${Math.max(dw, dh)} px without an outer-window change (docked DevTools?)`,
        cooldownMs: 15000
      });
    }
  });
}

function startTripwire() {
  if (tripwire || !cfg().security.devtoolsTripwire || typeof Worker === 'undefined') return;
  try {
    tripwire = new Worker(new URL('./tripwire.worker.js', import.meta.url));
    tripwire.onmessage = (e) => {
      const gap = e.data && e.data.gap;
      if (inExam() && gap > cfg().security.devtoolsTripwireMs) {
        recordIncident({
          type: 'DEVTOOLS_TRIPWIRE',
          level: Level.STRIKE,
          message: `Debugger tripwire halted for ${Math.round(gap)} ms — DevTools open`,
          cooldownMs: 30000
        });
      }
    };
  } catch (err) {
    console.warn('[sandbox] tripwire unavailable:', err.message);
  }
}

/* --- 06 · NAVIGATION, PRINT, UNLOAD -------------------------------------- */
let unloadPromptAt = 0;

function onBeforeUnload(e) {
  if ((!inExam() && S.stage !== Stage.SUBMITTING) || !cfg().security.warnOnUnload) return;
  unloadPromptAt = performance.now();
  e.preventDefault();
  e.returnValue = '';
}

/** The "Leave site?" dialog blocks the main thread; the clock must not read that stall as a freeze. */
export const unloadPromptWithin = (ms) => unloadPromptAt > 0 && performance.now() - unloadPromptAt < ms;

function onPopState() {
  if (!inExam() && S.stage !== Stage.SUBMITTING) return;
  history.pushState({ qz: 1 }, '', location.href);
  recordIncident({ type: 'NAV_ATTEMPT', level: Level.ADVISORY, message: 'Browser back/forward navigation intercepted', cooldownMs: 5000 });
}

function onBeforePrint() {
  if (inExam()) recordIncident({ type: 'PRINT_ATTEMPT', level: Level.ADVISORY, message: 'Print dialog invoked during the paper', cooldownMs: 5000 });
}

function suppress(type) {
  return (e) => {
    if (S.stage !== Stage.EXAM && isEditable(e.target)) return;   // sign-in fields stay usable
    e.preventDefault();
    if (inExam() && (type === 'copy' || type === 'paste' || type === 'cut')) {
      recordIncident({ type: 'CLIPBOARD', level: Level.INFO, message: `Clipboard ${type} blocked`, cooldownMs: 3000 });
    }
  };
}

/* --- 07 · INSTALL / ARM / DISARM ----------------------------------------- */
/** Always-on listeners. @param {{onExamKey:(e:KeyboardEvent)=>boolean}} h */
export function installSandbox(h = {}) {
  hooks = h;
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  document.addEventListener('contextmenu', (e) => { if (!isEditable(e.target) || S.stage === Stage.EXAM) e.preventDefault(); });
  ['copy', 'cut', 'paste'].forEach((t) => document.addEventListener(t, suppress(t)));
  document.addEventListener('selectstart', (e) => { if (!isEditable(e.target)) e.preventDefault(); });
  document.addEventListener('dragstart', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('blur', onBlur);
  window.addEventListener('focus', onFocus);
  window.addEventListener('resize', onResize);
  window.addEventListener('beforeunload', onBeforeUnload);
  window.addEventListener('popstate', onPopState);
  window.addEventListener('beforeprint', onBeforePrint);
}

/** Engages the live-paper guards. Call once the candidate is in the workspace. */
export function armSandbox() {
  if (armed) return;
  armed = true;
  history.pushState({ qz: 1 }, '', location.href);
  rebaseDims();
  startTripwire();
  if (isFullscreen()) lockKeys();

  // document.hasFocus() poll — catches focus loss to overlays that never fire `blur`.
  focusPoll = setInterval(() => {
    if (inExam() && !document.hidden && !document.hasFocus()) handleWindowBlur();
  }, 2000);

  if (!document.hidden && document.hasFocus() && (isFullscreen() || !cfg().security.requireFullscreen)) view.setShield(false);
  else if (!document.hidden && !document.hasFocus()) handleWindowBlur();

  if (window.screen && window.screen.isExtended) {
    recordIncident({ type: 'MULTI_DISPLAY', level: Level.ADVISORY, message: 'More than one display is connected' });
  }
  if (cfg().security.requireFullscreen && !isFullscreen()) {
    view.setShield(true);
    recordIncident({ type: 'FULLSCREEN_EXIT', level: Level.ADVISORY, message: 'Paper opened outside fullscreen' });
    startGrace();
  }
}

export function disarmSandbox() {
  armed = false;
  stopGrace();
  stopBlurGrace();
  view.hideFsLock();
  view.setShield(false);
  if (focusPoll) clearInterval(focusPoll);
  focusPoll = null;
  if (tripwire) tripwire.terminate();
  tripwire = null;
  if (navigator.keyboard && navigator.keyboard.unlock) navigator.keyboard.unlock();
}
