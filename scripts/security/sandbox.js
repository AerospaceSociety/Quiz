/* ==========================================================================
   QUIZZITCH — security/sandbox.js
   Input sandboxing: context menu, text selection, drag, clipboard and the
   developer / system keystroke interceptors.

   Every suppression during a live paper is written to the incident ledger, so
   the invigilation panel sees exactly what the candidate attempted.

   NOTE ON SCOPE — a browser sandbox raises the cost of casual cheating; it is
   not a kernel-level lockdown. The OS window manager still owns Alt+Tab, the
   Windows/Command key and screenshot hotkeys. Treat these controls as
   deterrence plus an audit trail, never as a guarantee.
   ========================================================================== */

import { CFG, S, logEvent, toast } from '../core/state.js';

/* --- 01 · HELPERS --------------------------------------------------------- */
function isEditable(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true;
}

function live() {
  return S.stage === 'live' && !S.locked;
}

function describeCombo(e) {
  return (e.ctrlKey ? 'Ctrl+' : '')
    + (e.altKey ? 'Alt+' : '')
    + (e.shiftKey ? 'Shift+' : '')
    + (e.metaKey ? 'Meta+' : '')
    + String(e.key || '').toUpperCase();
}

/* --- 02 · INSTALL --------------------------------------------------------- */
/**
 * @param {object} hooks
 * @param {Function} [hooks.onLaunch]  Enter pressed on the pre-flight screen
 * @param {Function} [hooks.onPrev]    ArrowLeft during a live paper
 * @param {Function} [hooks.onNext]    ArrowRight during a live paper
 * @param {Function} [hooks.onPick]    digit 1–9 during a live paper (0-based index)
 * @param {Function} [hooks.onFlag]    "F" during a live paper
 */
export function installSandbox(hooks = {}) {
  const sec = CFG.settings.security;

  /* --- context menu --- */
  if (sec.blockContextMenu) {
    document.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (live()) logEvent('warn', 'INPUT', 'Context menu invocation suppressed');
    });
  }

  /* --- clipboard --- */
  if (sec.blockClipboard) {
    ['copy', 'cut', 'paste'].forEach((evt) => {
      document.addEventListener(evt, (e) => {
        if (isEditable(e.target) && S.stage === 'preflight') return; // registry typing stays usable
        e.preventDefault();
        if (live()) logEvent('warn', 'CLIPBOARD', `Clipboard operation blocked: ${evt.toUpperCase()}`);
      });
    });
  }

  /* --- selection & drag --- */
  if (sec.blockSelection) {
    document.addEventListener('selectstart', (e) => {
      if (isEditable(e.target)) return;
      e.preventDefault();
    });
  }
  if (sec.blockDrag) {
    document.addEventListener('dragstart', (e) => e.preventDefault());
  }

  /* --- keystrokes --- */
  window.addEventListener('keydown', (e) => {
    const key = String(e.key || '').toLowerCase();
    const editing = isEditable(e.target);

    /* Enter arms the paper from the pre-flight screen. */
    if (S.stage === 'preflight' && key === 'enter' && !editing) {
      const launch = document.getElementById('btn-launch');
      if (launch && !launch.disabled) {
        e.preventDefault();
        if (hooks.onLaunch) hooks.onLaunch();
      }
      return;
    }

    const devtools = sec.blockDevtoolsKeys && (
      e.key === 'F12'
      || (e.ctrlKey && e.shiftKey && ['i', 'j', 'c', 'k', 'e'].includes(key))
      || (e.metaKey && e.altKey && ['i', 'j', 'c'].includes(key))
      || (e.ctrlKey && key === 'u')
    );
    const reload = sec.blockReloadKeys && (
      e.key === 'F5' || (e.ctrlKey && (key === 'r' || key === 'f5'))
    );
    const clipboard = sec.blockClipboard && e.ctrlKey && ['c', 'v', 'x', 'a'].includes(key) && !editing;
    const sysprint = sec.blockPrintKeys && e.ctrlKey && ['p', 's', 'o'].includes(key) && S.stage !== 'sealed';
    const metaKey = (e.metaKey || key === 'meta') && !editing;
    const windowSwitch = e.altKey || key === 'alt' || (e.ctrlKey && key === 'tab') || (live() && key === 'tab' && !editing);
    const browserNav = e.ctrlKey && ['w', 't', 'n', 'h', 'j', 'l', 'd', 'b'].includes(key);

    if (devtools || reload || clipboard || sysprint || metaKey || windowSwitch || browserNav) {
      e.preventDefault();
      e.stopPropagation();

      const what = devtools ? 'Developer tools'
        : reload ? 'Page reload'
        : clipboard ? 'Clipboard shortcut'
        : sysprint ? 'System print / save'
        : metaKey ? 'Meta / Windows key'
        : browserNav ? 'Browser navigation'
        : 'Window switch / Alt-Tab';

      if (live()) {
        logEvent('warn', 'KEYBOARD', `Blocked shortcut — ${what} (${describeCombo(e)})`);
        if (devtools || reload || windowSwitch) {
          toast('Input blocked', `${what} is strictly prohibited during the assessment.`, 'warn', 3500);
        }
      }
      return false;
    }

    /* --- allowed navigation shortcuts (live paper only) --- */
    if (live() && !editing && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (key === 'arrowright' || key === 'n') {
        e.preventDefault();
        hooks.onNext && hooks.onNext();
      } else if (key === 'arrowleft' || key === 'p') {
        e.preventDefault();
        hooks.onPrev && hooks.onPrev();
      } else if (key === 'f') {
        e.preventDefault();
        hooks.onFlag && hooks.onFlag();
      } else if (key === 'c') {
        e.preventDefault();
        hooks.onClear && hooks.onClear();
      } else if (/^[1-9]$/.test(key)) {
        e.preventDefault();
        hooks.onPick && hooks.onPick(Number(key) - 1);
      } else if (['a', 'b', 'd'].includes(key)) {
        e.preventDefault();
        const optIdx = key.charCodeAt(0) - 97; // a->0, b->1, d->3
        hooks.onPick && hooks.onPick(optIdx);
      }
    }
  }, true);

  logEvent('info', 'SANDBOX',
    'Input sandbox armed · context menu, clipboard, selection, drag and developer shortcuts intercepted');
}
