/* ==========================================================================
   QUIZZITCH — timer.js
   Authoritative, server-synchronised countdown.

   The client wall clock (Date.now) is never trusted for the paper. Time is
   read from a monotonic clock (performance.timeOrigin + performance.now()),
   corrected by an offset measured against the server:

     Δt          = t_server − (t_client_start + (t_client_response − t_client_start) / 2)
     t_remaining = T_end_server − (t_local_monotonic + Δt)

   Two anomaly detectors run on every tick:
     • FREEZE     — the tick loop stalled for longer than the threshold while
                    the page was visible (sleep, debugger pause, VM suspend).
     • CLOCK_SKEW — Date.now() moved relative to the monotonic clock by more
                    than the threshold (the OS clock was changed).
   ========================================================================== */

export const monoNow = () => performance.timeOrigin + performance.now();

/* --- 01 · OFFSET HANDSHAKE ----------------------------------------------- */
/**
 * Takes `samples` round trips and keeps the one with the smallest RTT — the
 * midpoint assumption is most accurate when the round trip is shortest.
 * @param {() => Promise<{server:number,t0:number,t1:number}>} sampler
 */
export async function measureOffset(sampler, samples = 3) {
  let best = null;
  for (let i = 0; i < samples; i++) {
    const { server, t0, t1 } = await sampler(monoNow);
    const rtt = t1 - t0;
    const offset = server - (t0 + rtt / 2);
    if (!best || rtt < best.rtt) best = { offset, rtt };
  }
  return best;
}

/** Fallback sampler: the HTTP Date header of our own origin (1 s resolution, +500 ms midpoint). */
export async function httpDateSampler(mono) {
  const t0 = mono();
  const res = await fetch(`${location.pathname}?t=${Date.now()}`, { method: 'HEAD', cache: 'no-store' });
  const t1 = mono();
  const header = res.headers.get('date');
  if (!header) throw new Error('no Date header');
  return { server: Date.parse(header) + 500, t0, t1 };
}

/**
 * Tries each sampler in order until one succeeds.
 * @returns {{offset:number, rtt:number, source:string}}
 */
export async function syncClock(samplers, samples = 3) {
  for (const [source, fn] of samplers) {
    try {
      const r = await measureOffset(fn, samples);
      if (r && Number.isFinite(r.offset)) return { ...r, source };
    } catch (err) {
      console.warn(`[timer] ${source} sync failed:`, err.message);
    }
  }
  // Last resort: trust the local wall clock, and say so in the ledger.
  return { offset: Date.now() - monoNow(), rtt: 0, source: 'local-wallclock' };
}

/* --- 02 · EXAM CLOCK ----------------------------------------------------- */
/**
 * @param {object}   o
 * @param {number}   o.offset             initial Δt (ms)
 * @param {() => number|null} o.getEndMs  authoritative server end time (ms), may change (extensions)
 * @param {number}   o.warnAt / o.critAt  seconds
 * @param {number}   o.anomalyThresholdMs
 * @param {Function} o.onTick(remainingSec)
 * @param {Function} o.onThreshold('warn'|'crit')
 * @param {Function} o.onExpire()
 * @param {Function} o.onAnomaly({kind, ms})
 */
export function createExamClock(o) {
  let offset = o.offset;
  let handle = null;
  let lastTick = 0;
  let wallBase = 0;
  let hiddenDuringGap = false;
  let firedWarn = false;
  let firedCrit = false;
  let expired = false;
  const freezeThreshold = o.freezeThresholdMs || o.anomalyThresholdMs || 8000;
  const skewThreshold = o.skewThresholdMs || 3000;

  const serverNow = () => monoNow() + offset;

  function remaining() {
    const end = o.getEndMs();
    if (!end) return null;
    return Math.max(0, (end - serverNow()) / 1000);
  }

  const onVisibility = () => { if (document.hidden) hiddenDuringGap = true; };

  function tick() {
    const now = monoNow();
    const gap = now - lastTick;

    if (lastTick && gap > freezeThreshold && !hiddenDuringGap && !document.hidden) {
      o.onAnomaly && o.onAnomaly({ kind: 'FREEZE', ms: Math.round(gap) });
    }
    const wallDrift = (Date.now() - now) - wallBase;
    if (Math.abs(wallDrift) > skewThreshold) {
      wallBase = Date.now() - now;
      o.onAnomaly && o.onAnomaly({ kind: 'CLOCK_SKEW', ms: Math.round(wallDrift) });
    }
    lastTick = now;
    hiddenDuringGap = document.hidden;

    const left = remaining();
    if (left == null) return;
    o.onTick && o.onTick(left);

    if (!firedCrit && o.critAt != null && left <= o.critAt) {
      firedCrit = firedWarn = true;
      o.onThreshold && o.onThreshold('crit');
    } else if (!firedWarn && o.warnAt != null && left <= o.warnAt) {
      firedWarn = true;
      o.onThreshold && o.onThreshold('warn');
    }
    if (left <= 0 && !expired) {
      expired = true;
      stop();
      o.onExpire && o.onExpire();
    }
  }

  function start() {
    if (handle) return;
    lastTick = monoNow();
    wallBase = Date.now() - lastTick;
    document.addEventListener('visibilitychange', onVisibility);
    tick();
    handle = setInterval(tick, 250);
  }

  function stop() {
    if (handle) clearInterval(handle);
    handle = null;
    document.removeEventListener('visibilitychange', onVisibility);
  }

  return {
    start,
    stop,
    remaining,
    serverNow,
    setOffset(v) { offset = v; },
    get offset() { return offset; },
    get running() { return handle !== null; }
  };
}
