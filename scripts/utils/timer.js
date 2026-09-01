/* ==========================================================================
   QUIZZITCH — utils/timer.js
   Synchronised countdown clock plus the shared time-formatting primitives.
   Dependency-free: nothing in this module imports application state.
   ========================================================================== */

/* --- 01 · FORMATTERS ------------------------------------------------------ */

/** Zero-pads a number to `width` digits (default 2). */
export function pad(n, width = 2) {
  let s = String(Math.abs(Math.trunc(Number(n) || 0)));
  while (s.length < width) s = '0' + s;
  return s;
}

/** Seconds → "MM:SS" (minutes are not wrapped at 60). */
export function mmss(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

/** Seconds → "HH:MM:SS". */
export function hhmmss(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** Local wall-clock time as "HH:MM:SS". */
export function wallTime(date) {
  const d = date instanceof Date ? date : new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** ISO timestamp trimmed to second precision, e.g. "2026-08-31 09:41:07 UTC". */
export function stampUTC(date) {
  const d = date instanceof Date ? date : new Date();
  return `${d.toISOString().replace('T', ' ').slice(0, 19)} UTC`;
}

/** Current UTC offset, e.g. "+05:30". */
export function utcOffset() {
  const mins = -new Date().getTimezoneOffset();
  const sign = mins >= 0 ? '+' : '−';
  return `${sign}${pad(Math.floor(Math.abs(mins) / 60))}:${pad(Math.abs(mins) % 60)}`;
}

/* --- 02 · COUNTDOWN ------------------------------------------------------- */
/**
 * Wall-clock-anchored countdown. The remaining time is always derived from
 * Date.now() against a fixed end timestamp, so it cannot drift if the tab is
 * throttled, suspended or the interval fires late.
 *
 * @param {object}   opts
 * @param {number}   opts.durationSeconds  total length of the countdown
 * @param {number}  [opts.tickMs=250]      UI refresh period
 * @param {number}  [opts.warnAt]          seconds remaining → onThreshold('warn')
 * @param {number}  [opts.critAt]          seconds remaining → onThreshold('crit')
 * @param {Function}[opts.onTick]          (remainingSeconds, elapsedSeconds) => void
 * @param {Function}[opts.onThreshold]     ('warn'|'crit') => void, fired once each
 * @param {Function}[opts.onExpire]        () => void
 */
export function createCountdown(opts) {
  const {
    durationSeconds,
    tickMs = 250,
    warnAt = null,
    critAt = null,
    onTick = null,
    onThreshold = null,
    onExpire = null
  } = opts || {};

  let startTs = 0;
  let endTs = 0;
  let handle = null;
  let expired = false;
  let firedWarn = false;
  let firedCrit = false;

  function remaining() {
    if (!endTs) return durationSeconds;
    return Math.max(0, (endTs - Date.now()) / 1000);
  }

  function elapsed() {
    if (!startTs) return 0;
    return (Date.now() - startTs) / 1000;
  }

  function tick() {
    const left = remaining();

    if (onTick) onTick(left, elapsed());

    if (critAt !== null && !firedCrit && left <= critAt) {
      firedCrit = true;
      firedWarn = true;
      if (onThreshold) onThreshold('crit');
    } else if (warnAt !== null && !firedWarn && left <= warnAt) {
      firedWarn = true;
      if (onThreshold) onThreshold('warn');
    }

    if (left <= 0 && !expired) {
      expired = true;
      stop();
      if (onExpire) onExpire();
    }
  }

  function start() {
    if (handle) return api;
    startTs = Date.now();
    endTs = startTs + durationSeconds * 1000;
    expired = false;
    firedWarn = false;
    firedCrit = false;
    tick();
    handle = setInterval(tick, tickMs);
    return api;
  }

  function stop() {
    if (handle) {
      clearInterval(handle);
      handle = null;
    }
    return api;
  }

  const api = {
    start,
    stop,
    tick,
    remaining,
    elapsed,
    get running() { return handle !== null; },
    get startTs() { return startTs; },
    get endTs() { return endTs; }
  };

  return api;
}

/* --- 03 · SIMPLE REPEATING COUNTDOWN (overlay counters) ------------------- */
/**
 * A one-second ticking counter used by the focus-breach and re-dock overlays.
 * @param {number} seconds  starting value
 * @param {Function} onTick (secondsLeft) => void — called immediately, then each second
 * @param {Function} onDone () => void
 * @returns {{cancel: Function}}
 */
export function createTicker(seconds, onTick, onDone) {
  let left = seconds;
  if (onTick) onTick(left);

  const handle = setInterval(() => {
    left -= 1;
    if (onTick) onTick(Math.max(0, left));
    if (left <= 0) {
      clearInterval(handle);
      if (onDone) onDone();
    }
  }, 1000);

  return { cancel() { clearInterval(handle); } };
}
