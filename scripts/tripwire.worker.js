/* QUIZZITCH — tripwire.worker.js
   Anti-debugging tripwire. With DevTools closed the `debugger` statement is a
   no-op and the measured gap is ~0 ms. With DevTools open (and breakpoints
   active) the worker halts on it, and the gap reported to the page reveals
   the pause. Runs off the main thread, so it never stalls the exam UI. */

let period = 1000;

self.onmessage = (e) => {
  if (e.data && Number.isFinite(e.data.period)) period = Math.max(250, e.data.period);
};

function probe() {
  const t = performance.now();
  // eslint-disable-next-line no-debugger
  debugger;
  self.postMessage({ gap: performance.now() - t });
  setTimeout(probe, period);
}

probe();
