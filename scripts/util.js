/* ==========================================================================
   QUIZZITCH — util.js
   Dependency-free primitives shared by the candidate portal and the admin
   deck: a safe DOM builder (text nodes only, never innerHTML), SHA-256,
   canonical JSON, a seeded PRNG for reproducible papers, and formatters.
   ========================================================================== */

/* --- 01 · DOM ------------------------------------------------------------- */
export const $ = (id) => document.getElementById(id);

/**
 * Element builder. Strings and numbers become text nodes, so dynamic content
 * can never be parsed as markup.
 *   h('div', { class: 'x', dataset: { i: 3 }, onclick: fn }, 'text', child)
 */
export function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = String(v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (v === true) node.setAttribute(k, '');
      else node.setAttribute(k, String(v));
    }
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(node, c);
    else node.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** Replaces every child of `node` with `children`. */
export function mount(node, ...children) {
  if (!node) return;
  node.replaceChildren();
  append(node, children);
}

export function setText(id, value) {
  const n = typeof id === 'string' ? $(id) : id;
  if (n) n.textContent = value == null ? '' : String(value);
}

export function show(id, visible) {
  const n = typeof id === 'string' ? $(id) : id;
  if (n) n.hidden = !visible;
}

/* --- 02 · CRYPTO & INTEGRITY --------------------------------------------- */
export async function sha256Hex(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomHex(bytes = 16) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** JSON with object keys sorted at every depth, so equal data hashes equally. */
export function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`).join(',')}}`;
}

export function deepFreeze(obj) {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    Object.values(obj).forEach(deepFreeze);
  }
  return obj;
}

/* --- 03 · SEEDED RANDOMNESS ---------------------------------------------- */
/** 32-bit FNV-1a — used only to derive PRNG seeds, never for integrity. */
export function seedFrom(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates with an injected RNG; returns a new array. */
export function shuffle(list, rng = Math.random) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* --- 04 · FORMATTERS ----------------------------------------------------- */
export const pad = (n, w = 2) => String(Math.abs(Math.trunc(Number(n) || 0))).padStart(w, '0');

export function mmss(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

export function hhmmss(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

const IST_FMT = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: '2-digit', month: 'short', year: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
});
const IST_TIME = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
});

export const istStamp = (ms = Date.now()) => `${IST_FMT.format(new Date(ms))} IST`;
export const istTime = (ms = Date.now()) => IST_TIME.format(new Date(ms));

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Upper-cased, whitespace-collapsed identity string used for name matching. */
export const normName = (s) => String(s || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toUpperCase();

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Resolves with the promise's value, or rejects after `ms`. */
export function withTimeout(promise, ms, label = 'operation') {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timed out after ${ms} ms`)), ms); })
  ]);
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename, rel: 'noopener' });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/** RFC 4180 CSV cell. Leading = + - @ are prefixed to defuse spreadsheet formula injection. */
export function csvCell(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const toCSV = (header, rows) => [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
