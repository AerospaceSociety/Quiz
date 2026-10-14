/* ==========================================================================
   QUIZZITCH — admin.js
   Real-time invigilation command center.

     • Email/password auth, gated by the admins/{uid} allowlist (the same
       check is enforced server-side in firestore.rules).
     • Live listeners: sessions (candidate grid), events (activity feed),
       submissions (results), exam_control (paper release / end / extend).
     • Forensic modal: audit timeline, baseline vs. incident stills,
       checksum re-verification, module breakdown.
     • Scoring against an invigilator-only answer key, IPD team pooling,
       CSV / JSON exports.

   All dynamic text is written through util.h (text nodes only).
   ========================================================================== */

import * as fb from './firebase.js';
import {
  $, h, mount, setText, show, sha256Hex, canonicalJSON, istStamp, istTime, mmss, pad,
  downloadBlob, toCSV, deepFreeze, normName
} from './util.js';
import { identityKeyFor } from './submission.js';

const OFFLINE_MS = 75000;
const STATUS_ORDER = { flagged: 0, warning: 1, secure: 2, offline: 3, submitted: 4 };
const STATUS_LABEL = { secure: 'Secure', warning: 'Warning', flagged: 'Flagged', submitted: 'Submitted', offline: 'Offline' };
const STAGE_LABEL = { signin: 'Signing in', calibrate: 'Calibrating', protocol: 'Reading protocol', exam: 'In paper', sealed: 'Sealed' };
const LEVEL_LABEL = ['Info', 'Advisory', 'Strike'];

let settings = null;
let me = null;
let control = { status: 'waiting' };
let answerKey = null;
let unsubs = [];
let ticker = null;
const sessions = new Map();
const submissions = new Map();
let events = [];
const verified = new Map();          // uid → 'ok' | 'bad' | 'pending'
const filters = { q: '', school: '', team: '', division: '', minStrikes: 0, status: '' };

/* --- 01 · SMALL HELPERS --------------------------------------------------- */
function toast(title, body, kind = 'info', ttl = 4500) {
  const host = $('toasts');
  const node = h('div', { class: `toast toast--${kind}`, role: 'status' }, h('strong', null, title), body ? h('span', null, body) : null);
  host.appendChild(node);
  setTimeout(() => node.classList.add('is-leaving'), ttl);
  setTimeout(() => node.remove(), ttl + 400);
}

function view(name) {
  document.body.dataset.view = name;
  show('boot', name === 'boot');
  show('view-auth', name === 'auth');
  show('view-denied', name === 'denied');
  show('view-deck', name === 'deck');
}

function bootError(title, detail) {
  view('boot');
  show('boot-spinner', false);
  setText('boot-title', title);
  setText('boot-detail', detail);
  show('boot-detail', true);
}

const ago = (ms) => (ms == null ? '—' : ms < 10000 ? 'just now' : ms < 60000 ? `${Math.round(ms / 1000)}s ago` : `${Math.round(ms / 60000)}m ago`);
const svg = (tag, attrs, ...kids) => {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.entries(attrs || {}).forEach(([k, v]) => n.setAttribute(k, String(v)));
  kids.forEach((k) => k != null && n.appendChild(typeof k === 'string' ? document.createTextNode(k) : k));
  return n;
};

/* --- 02 · DERIVED CANDIDATE ROWS ------------------------------------------ */
function liveStatus(s, sub) {
  if (sub || (s && s.status === 'submitted')) return 'submitted';
  if (!s) return 'offline';
  const age = Date.now() - (fb.toMs(s.heartbeatAt) || 0);
  if (age > OFFLINE_MS) return 'offline';
  if ((s.strikes || 0) > 0 || s.status === 'flagged') return 'flagged';
  if (s.status === 'warning') return 'warning';
  return 'secure';
}

function rows() {
  const uids = new Set([...sessions.keys(), ...submissions.keys()]);
  return [...uids].map((uid) => {
    const s = sessions.get(uid) || null;
    const sub = submissions.get(uid) || null;
    const c = sub ? sub.candidate : {};
    return {
      uid,
      s,
      sub,
      name: (s && s.name) || c.name || '—',
      schoolUid: (s && s.schoolUid) || c.schoolUid || '—',
      teamId: (s && s.teamId) || c.teamId || '—',
      division: (s && s.division) || c.division || '—',
      identityKey: (s && s.identityKey) || (sub && sub.identityKey) || '',
      status: liveStatus(s, sub),
      stage: sub ? 'sealed' : (s && s.stage) || '—',
      strikes: Math.max((s && s.strikes) || 0, (sub && sub.strikes) || 0),
      advisories: sub ? Object.values(sub.advisories || {}).reduce((a, b) => a + b, 0) : (s && s.advisories) || 0,
      answered: sub ? sub.answered : (s && s.answered) || 0,
      total: sub ? sub.total : (s && s.total) || 0,
      currentQ: (s && s.currentQ) || 0,
      fullscreen: s ? !!s.fullscreen : false,
      age: s ? Date.now() - (fb.toMs(s.heartbeatAt) || 0) : null
    };
  });
}

function passes(r) {
  const q = filters.q.trim().toUpperCase();
  if (q && ![r.name, r.schoolUid, r.teamId].some((v) => String(v).toUpperCase().includes(q))) return false;
  if (filters.school && r.schoolUid !== filters.school) return false;
  if (filters.team && r.teamId !== filters.team) return false;
  if (filters.division && r.division !== filters.division) return false;
  if (r.strikes < filters.minStrikes) return false;
  if (filters.status && r.status !== filters.status) return false;
  return true;
}

/* --- 03 · SCORING --------------------------------------------------------- */
function scoreItem(item) {
  const key = answerKey && answerKey[item.id];
  const sc = settings.schemes[item.scheme] || settings.schemes.standard;
  if (!key) return { pts: 0, state: 'nokey' };
  const sel = (item.original || []).slice().sort((a, b) => a - b);
  if (!sel.length) return { pts: 0, state: 'blank' };
  const want = key.slice().sort((a, b) => a - b);
  const ok = sel.length === want.length && sel.every((v, i) => v === want[i]);
  return ok ? { pts: sc.correct, state: 'correct' } : { pts: sc.incorrect, state: 'wrong' };
}

function scoreSubmission(sub) {
  if (!answerKey || !sub) return null;
  const modules = {};
  let total = 0;
  let correct = 0;
  let wrong = 0;
  (sub.items || []).forEach((it) => {
    const r = scoreItem(it);
    total += r.pts;
    modules[it.catId] = (modules[it.catId] || 0) + r.pts;
    if (r.state === 'correct') correct++;
    if (r.state === 'wrong') wrong++;
  });
  return { total, modules, correct, wrong };
}

/** Recomputes SHA-256(salt | canonicalJSON(body)) from the stored record. */
async function verifyChecksum(sub) {
  if (!sub || !sub.checksum || !sub.salt) return false;
  const { checksum, checksumAlgo, uid, receivedAt, updatedAt, id, ...body } = sub;
  const digest = await sha256Hex(`${sub.salt}|${canonicalJSON(body)}`);
  return digest === checksum;
}

function queueVerification() {
  submissions.forEach((sub, uid) => {
    const tag = `${uid}:${sub.checksum}`;
    if (verified.has(tag)) return;
    verified.set(tag, 'pending');
    verifyChecksum(sub).then((ok) => {
      verified.set(tag, ok ? 'ok' : 'bad');
      renderResults();
    });
  });
}
const verification = (sub) => (sub ? verified.get(`${sub.uid || sub.id}:${sub.checksum}`) || 'pending' : 'none');

/* --- 04 · LIVE GRID ------------------------------------------------------- */
function renderKpis(all) {
  const count = (st) => all.filter((r) => r.status === st).length;
  setText('kpi-connected', all.filter((r) => r.status !== 'offline' && r.status !== 'submitted').length);
  ['secure', 'warning', 'flagged', 'submitted', 'offline'].forEach((st) => setText(`kpi-${st}`, count(st)));
}

function syncSelect(id, values, label) {
  const sel = $(id);
  const cur = sel.value;
  const want = ['', ...values];
  const have = [...sel.options].map((o) => o.value);
  if (have.join('|') === want.join('|')) return;
  mount(sel, h('option', { value: '' }, label), values.map((v) => h('option', { value: v }, v)));
  sel.value = want.includes(cur) ? cur : '';
}

function card(r) {
  const pct = r.total ? Math.round((r.answered / r.total) * 100) : 0;
  return h('button', { type: 'button', class: `ccard ccard--${r.status}`, onclick: () => openForensic(r.uid), 'aria-label': `${r.name}, ${STATUS_LABEL[r.status]}` },
    h('div', { class: 'ccard__top' },
      h('span', { class: 'status', dataset: { state: r.status } }, STATUS_LABEL[r.status]),
      h('span', { class: 'ccard__age' }, r.status === 'submitted' ? 'sealed' : ago(r.age))),
    h('div', { class: 'ccard__name' }, r.name),
    h('div', { class: 'ccard__meta' }, `${r.schoolUid} · ${r.teamId} · ${r.division}`),
    h('div', { class: 'ccard__progress' },
      h('span', { class: 'meter' }, h('i', { style: { transform: `scaleX(${pct / 100})` } })),
      h('span', null, `${r.answered}/${r.total || '—'}`)),
    h('div', { class: 'ccard__foot' },
      h('span', null, r.stage === 'exam' ? `Q${pad(r.currentQ)} · ${r.fullscreen ? 'fullscreen' : 'WINDOWED'}` : STAGE_LABEL[r.stage] || r.stage),
      h('span', { class: 'ccard__flags' },
        r.advisories ? h('span', { class: 'adv', title: 'Advisories' }, `▲${r.advisories}`) : null,
        h('span', { class: 'pips', title: `${r.strikes} strike(s)` },
          Array.from({ length: settings.security.maxStrikes }, (_, i) => h('i', { class: i < r.strikes ? 'is-on' : '' }))))));
}

function renderGrid() {
  const all = rows();
  renderKpis(all);
  syncSelect('f-school', [...new Set(all.map((r) => r.schoolUid))].filter((v) => v !== '—').sort(), 'All schools');
  syncSelect('f-team', [...new Set(all.filter((r) => !filters.school || r.schoolUid === filters.school).map((r) => r.teamId))].filter((v) => v !== '—').sort(), 'All teams');
  const shown = all.filter(passes).sort((a, b) => (STATUS_ORDER[a.status] - STATUS_ORDER[b.status]) || (b.strikes - a.strikes) || a.name.localeCompare(b.name));
  setText('f-count', `${shown.length} of ${all.length} shown`);
  mount($('grid'), shown.length ? shown.map(card) : h('p', { class: 'empty' }, all.length ? 'No candidates match the filters.' : 'No candidates connected yet. Sessions appear here as soon as a candidate signs in.'));
}

/* --- 05 · ACTIVITY FEED --------------------------------------------------- */
function renderFeed() {
  mount($('feed'), events.length ? events.map((e) => h('li', {
    class: `fe fe--${e.level}`,
    onclick: () => openForensic(e.uid),
    title: 'Open forensic record'
  },
  h('span', { class: 'fe__time' }, istTime(fb.toMs(e.ts) || e.clientTs)),
  h('span', { class: 'fe__level' }, e.level === 2 ? `STRIKE ${e.strikes || ''}`.trim() : LEVEL_LABEL[e.level] || 'Info'),
  h('span', { class: 'fe__who' }, `${String(e.schoolUid || '').replace('CLT-2026-SCH-', 'SCH-')} · ${e.name || '—'}`),
  h('span', { class: 'fe__msg' }, e.message || e.type),
  e.thumb ? h('img', { class: 'fe__thumb', src: e.thumb, alt: `Still at ${e.type}` }) : null))
    : h('li', { class: 'empty' }, 'Waiting for events…'));
}

/* --- 06 · EXAM CONTROL ---------------------------------------------------- */
function controlEnd() {
  if (control.status !== 'active' || !control.startedAtMs) return null;
  return control.startedAtMs + ((control.durationSeconds || settings.exam.durationSeconds) + (control.extensionSeconds || 0)) * 1000;
}

function paintControl() {
  const st = control.status || 'waiting';
  const node = $('ctl-state');
  node.textContent = st.toUpperCase();
  node.dataset.state = st;
  const end = controlEnd();
  setText('ctl-clock', end ? mmss(Math.max(0, (end - Date.now()) / 1000)) : '--:--');
  $('btn-ctl-start').disabled = st === 'active';
  $('btn-ctl-extend').disabled = st !== 'active';
  $('btn-ctl-end').disabled = st !== 'active';
}

async function command(fn, okMsg) {
  try {
    await fn();
    toast('Command sent', okMsg, 'ok');
  } catch (err) {
    toast('Command failed', err.message, 'danger', 7000);
  }
}

/* --- 07 · RESULTS & STANDINGS -------------------------------------------- */
function resultRows() {
  return [...submissions.values()].map((sub) => ({ sub, score: scoreSubmission(sub), v: verification(sub) }))
    .sort((a, b) => ((b.score ? b.score.total : 0) - (a.score ? a.score.total : 0)) || a.sub.candidate.name.localeCompare(b.sub.candidate.name));
}

function duplicates() {
  const seen = new Map();
  submissions.forEach((sub) => seen.set(sub.identityKey, (seen.get(sub.identityKey) || 0) + 1));
  return seen;
}

function renderResults() {
  if ($('tab-results').hidden) return;
  const mods = settings.modules;
  mount($('res-head'), h('tr', null,
    h('th', null, 'Candidate'), h('th', null, 'School UID'), h('th', null, 'Team'), h('th', null, 'Div'),
    h('th', { class: 'num' }, 'Answered'), h('th', { class: 'num' }, 'Score'),
    mods.map((m) => h('th', { class: 'num' }, m.letter)),
    h('th', { class: 'num' }, 'Strikes'), h('th', null, 'Verdict'), h('th', null, 'Reason'), h('th', null, 'Sealed (IST)'), h('th', null, 'Checksum')));
  const dup = duplicates();
  const list = resultRows();
  mount($('res-body'), list.length ? list.map(({ sub, score, v }) => h('tr', { class: 'clickable', onclick: () => openForensic(sub.uid || sub.id) },
    h('td', null, sub.candidate.name, dup.get(sub.identityKey) > 1 ? h('span', { class: 'tag tag--bad' }, 'DUPLICATE') : null),
    h('td', { class: 'mono' }, sub.candidate.schoolUid),
    h('td', { class: 'mono' }, sub.candidate.teamId),
    h('td', null, sub.candidate.division),
    h('td', { class: 'num' }, `${sub.answered}/${sub.total}`),
    h('td', { class: 'num strong' }, score ? score.total : '—'),
    mods.map((m) => h('td', { class: 'num' }, score ? (score.modules[m.id] || 0) : '—')),
    h('td', { class: `num${sub.strikes ? ' is-bad' : ''}` }, sub.strikes),
    h('td', null, h('span', { class: `tag tag--${sub.verdict}` }, sub.verdict)),
    h('td', { class: 'small' }, sub.reason),
    h('td', { class: 'small' }, istStamp(sub.sealedAt).replace(' IST', '')),
    h('td', null, h('span', { class: `tag tag--v-${v}` }, v === 'ok' ? 'Verified' : v === 'bad' ? 'MISMATCH' : '…'))))
    : h('tr', null, h('td', { colspan: 12 + mods.length, class: 'empty' }, 'No sealed submissions yet.')));
  renderStandings();
}

function standings() {
  const div = settings.divisions.find((d) => d.code === 'IPD') || { teamSize: 3, seedTop: 16 };
  const teams = new Map();
  submissions.forEach((sub) => {
    if (sub.candidate.division !== 'IPD') return;
    const t = teams.get(sub.candidate.teamId) || { teamId: sub.candidate.teamId, schoolUid: sub.candidate.schoolUid, members: 0, pooled: 0, strikes: 0 };
    const sc = scoreSubmission(sub);
    t.members += 1;
    t.pooled += sc ? sc.total : 0;
    t.strikes += sub.strikes || 0;
    teams.set(t.teamId, t);
  });
  const list = [...teams.values()].sort((a, b) => b.pooled - a.pooled || a.strikes - b.strikes);
  return { list, div };
}

function renderStandings() {
  const { list, div } = standings();
  setText('standings-note', `Team score = sum of up to ${div.teamSize} members' scores. Top ${div.seedTop} seed into the national rounds. Ties break on fewer strikes.`);
  mount($('standings-body'), list.length ? list.map((t, i) => h('tr', { class: i < div.seedTop && answerKey ? 'is-seed' : '' },
    h('td', { class: 'num' }, i + 1),
    h('td', { class: 'mono' }, t.teamId),
    h('td', { class: 'mono' }, t.schoolUid),
    h('td', { class: `num${t.members !== div.teamSize ? ' is-warn' : ''}` }, `${t.members}/${div.teamSize}`),
    h('td', { class: 'num strong' }, answerKey ? t.pooled : '—'),
    h('td', { class: `num${t.strikes ? ' is-bad' : ''}` }, t.strikes),
    h('td', null, answerKey && i < div.seedTop ? h('span', { class: 'tag tag--CLEAN' }, `Seed ${i + 1}`) : '')))
    : h('tr', null, h('td', { colspan: 7, class: 'empty' }, 'No IPD submissions yet.')));
}

function paintKeyState() {
  const n = $('key-state');
  n.dataset.state = answerKey ? 'ok' : 'missing';
  n.textContent = answerKey ? `Answer key loaded · ${Object.keys(answerKey).length} items` : 'Answer key not loaded — scores unavailable';
}

/* --- 08 · FORENSIC MODAL -------------------------------------------------- */
let fxCurrent = null;

function ledgerFor(uid, fx) {
  if (fx && Array.isArray(fx.ledger) && fx.ledger.length) return fx.ledger;
  return events.filter((e) => e.uid === uid).map((e) => ({ elapsed: e.elapsed || 0, level: e.level, type: e.type, message: e.message })).reverse();
}

function timeline(ledger, durationSec) {
  const W = 1000;
  const L = 110;
  const R = 16;
  const lanes = [
    { key: 'resp', y: 34, label: 'Responses' },
    { key: 'adv', y: 74, label: 'Advisories' },
    { key: 'strike', y: 114, label: 'Strikes' }
  ];
  const maxT = Math.max(durationSec, ...ledger.map((e) => e.elapsed || 0), 60);
  const x = (t) => L + ((W - L - R) * Math.min(t, maxT)) / maxT;
  const root = svg('svg', { viewBox: `0 0 ${W} 160`, class: 'tl', role: 'img', 'aria-label': 'Audit timeline: responses, advisories and strikes over the paper' });

  lanes.forEach((ln) => {
    root.appendChild(svg('line', { x1: L, x2: W - R, y1: ln.y, y2: ln.y, class: 'tl__lane' }));
    root.appendChild(svg('text', { x: 0, y: ln.y + 4, class: 'tl__label' }, ln.label));
  });
  for (let m = 0; m <= maxT / 60; m += 5) {
    root.appendChild(svg('line', { x1: x(m * 60), x2: x(m * 60), y1: 18, y2: 130, class: 'tl__grid' }));
    root.appendChild(svg('text', { x: x(m * 60), y: 150, class: 'tl__tick', 'text-anchor': 'middle' }, `${m}m`));
  }

  const tip = (e) => svg('title', null, `T+${mmss(e.elapsed || 0)} · ${e.type} · ${e.message}`);
  ledger.forEach((e) => {
    const cx = x(e.elapsed || 0);
    if (e.type === 'ANSWER' || e.type === 'MARK') {
      root.appendChild(svg('g', { class: 'tl__hit' },
        svg('rect', { x: cx - 4, y: 22, width: 8, height: 24, fill: 'transparent' }),
        svg('rect', { x: cx - 1, y: 27, width: 2, height: 14, rx: 1, class: e.type === 'MARK' ? 'tl__mark' : 'tl__resp' }), tip(e)));
    } else if (e.level === 1) {
      root.appendChild(svg('g', { class: 'tl__hit' },
        svg('rect', { x: cx - 7, y: 62, width: 14, height: 24, fill: 'transparent' }),
        svg('path', { d: `M${cx} ${68}l6 11h-12z`, class: 'tl__adv' }), tip(e)));
    } else if (e.level === 2) {
      root.appendChild(svg('g', { class: 'tl__hit' },
        svg('rect', { x: cx - 8, y: 102, width: 16, height: 24, fill: 'transparent' }),
        svg('path', { d: `M${cx} ${107}l7 7l-7 7l-7 -7z`, class: 'tl__strike' }), tip(e)));
    } else if (e.type === 'SUBMITTED' || e.type === 'EXAM_STARTED' || e.type === 'SESSION_RESUMED') {
      root.appendChild(svg('g', null,
        svg('line', { x1: cx, x2: cx, y1: 18, y2: 130, class: 'tl__event' }),
        svg('text', { x: cx + 4, y: 14, class: 'tl__tick' }, e.type === 'SUBMITTED' ? 'sealed' : e.type === 'EXAM_STARTED' ? 'start' : 'resume'), tip(e)));
    }
  });
  return root;
}

async function openForensic(uid) {
  const r = rows().find((x) => x.uid === uid);
  if (!r) return;
  fxCurrent = { uid, r, fx: null };
  const sub = r.sub;
  setText('fx-name', r.name);
  setText('fx-sub', `${r.schoolUid} · ${r.teamId} · ${r.division} · session ${sub ? sub.sessionId : (r.s && r.s.sessionId) || '—'}`);
  const st = $('fx-status');
  st.dataset.state = r.status;
  st.textContent = STATUS_LABEL[r.status];
  setText('fx-verdict', sub ? `${sub.verdict} · ${sub.reason}` : STAGE_LABEL[r.stage] || r.stage);
  mount($('fx-timeline'), h('p', { class: 'muted' }, 'Loading forensic record…'));
  mount($('fx-stills'));
  mount($('fx-ledger'));
  mount($('fx-modules'));
  setText('fx-checksum', sub ? sub.checksum : 'Not sealed yet');
  const vnode = $('fx-verify');
  vnode.dataset.state = 'idle';
  vnode.textContent = sub ? 'Verifying…' : 'Checksum is computed at submission.';
  $('btn-fx-release').disabled = !r.identityKey;
  show('modal-forensic', true);

  const score = scoreSubmission(sub);
  const stat = (k, v) => h('div', { class: 'stat' }, h('span', null, k), h('b', null, String(v)));
  mount($('fx-stats'),
    stat('Answered', `${r.answered}/${r.total || '—'}`),
    stat('Marked', sub ? sub.marked : (r.s && r.s.marked) || 0),
    stat('Strikes', r.strikes),
    stat('Advisories', r.advisories),
    stat('Elapsed', sub ? mmss(sub.elapsedSec) : '—'),
    stat('Score', score ? score.total : '—'),
    stat('Resumes', sub ? sub.resumes : '—'),
    stat('Clock', sub ? sub.clockSource : '—'));

  if (sub) {
    verifyChecksum(sub).then((ok) => {
      vnode.dataset.state = ok ? 'ok' : 'bad';
      vnode.textContent = ok
        ? 'VERIFIED — recomputed SHA-256(salt | canonical body) matches the sealed checksum.'
        : 'MISMATCH — the stored record differs from what was sealed. Treat as tampered.';
    });
  }
  if (score) {
    mount($('fx-modules'), h('table', { class: 'table table--dense' }, h('tbody', null,
      settings.modules.map((m) => h('tr', null, h('th', null, `Module ${m.letter} · ${m.short}`), h('td', { class: 'num strong' }, score.modules[m.id] || 0))),
      h('tr', null, h('th', null, `Correct ${score.correct} · Incorrect ${score.wrong}`), h('td', { class: 'num strong' }, score.total)))));
  }

  let fx = null;
  try { fx = await fb.getForensics(uid); } catch (err) { toast('Forensics unavailable', err.message, 'warn'); }
  if (!fxCurrent || fxCurrent.uid !== uid) return;
  fxCurrent.fx = fx;
  const ledger = ledgerFor(uid, fx).slice().sort((a, b) => (a.elapsed || 0) - (b.elapsed || 0) || (a.seq || 0) - (b.seq || 0));

  mount($('fx-timeline'), timeline(ledger, (control.durationSeconds || settings.exam.durationSeconds)),
    h('ul', { class: 'tl-legend' },
      h('li', null, h('i', { class: 'k k--resp' }), 'Response / review mark'),
      h('li', null, h('i', { class: 'k k--adv' }), 'Advisory'),
      h('li', null, h('i', { class: 'k k--strike' }), 'Strike')));

  const stills = [];
  if (fx && fx.baseline && fx.baseline.photo) stills.push({ src: fx.baseline.photo, cap: 'Baseline reference', cls: 'is-baseline' });
  const thumbs = (fx && fx.thumbs && fx.thumbs.length) ? fx.thumbs : events.filter((e) => e.uid === uid && e.thumb).map((e) => ({ dataUrl: e.thumb, type: e.type, level: e.level, t: fb.toMs(e.ts) }));
  thumbs.forEach((t) => stills.push({ src: t.dataUrl, cap: `${t.type}${t.t ? ` · ${istTime(t.t)}` : ''}`, cls: t.level === 2 ? 'is-strike' : 'is-adv' }));
  mount($('fx-stills'), stills.length
    ? stills.map((s) => h('figure', { class: `still ${s.cls}` }, h('img', { src: s.src, alt: s.cap }), h('figcaption', null, s.cap)))
    : h('p', { class: 'muted' }, 'No stills recorded.'));

  mount($('fx-ledger'), ledger.length ? ledger.map((e) => h('tr', { class: `lv-${e.level}` },
    h('td', { class: 'num mono' }, mmss(e.elapsed || 0)),
    h('td', null, LEVEL_LABEL[e.level] || 'Info'),
    h('td', { class: 'mono small' }, e.type),
    h('td', null, e.message)))
    : h('tr', null, h('td', { colspan: 4, class: 'empty' }, 'No ledger entries.')));
}

/* --- 09 · EXPORTS ---------------------------------------------------------- */
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

function exportCandidatesCSV() {
  const mods = settings.modules;
  const header = ['Name', 'School UID', 'Team ID', 'Division', 'Live status', 'Stage', 'Answered', 'Total', 'Score',
    ...mods.map((m) => `Module ${m.letter}`), 'Strikes', 'Advisories', 'Verdict', 'Reason', 'Sealed (IST)', 'Session', 'Checksum', 'Checksum verified', 'UID'];
  const data = rows().map((r) => {
    const sc = scoreSubmission(r.sub);
    return [r.name, r.schoolUid, r.teamId, r.division, r.status, r.stage, r.answered, r.total, sc ? sc.total : '',
      ...mods.map((m) => (sc ? sc.modules[m.id] || 0 : '')), r.strikes, r.advisories,
      r.sub ? r.sub.verdict : '', r.sub ? r.sub.reason : '', r.sub ? istStamp(r.sub.sealedAt) : '',
      r.sub ? r.sub.sessionId : (r.s && r.s.sessionId) || '', r.sub ? r.sub.checksum : '', r.sub ? verification(r.sub) : '', r.uid];
  });
  downloadBlob(new Blob([`﻿${toCSV(header, data)}`], { type: 'text/csv;charset=utf-8' }), `quizzitch-candidates-${stamp()}.csv`);
}

function exportStandingsCSV() {
  const { list, div } = standings();
  const data = list.map((t, i) => [i + 1, t.teamId, t.schoolUid, t.members, answerKey ? t.pooled : '', t.strikes, answerKey && i < div.seedTop ? `Seed ${i + 1}` : '']);
  downloadBlob(new Blob([`﻿${toCSV(['Rank', 'Team ID', 'School UID', 'Members', 'Pooled score', 'Strikes', 'Seed'], data)}`], { type: 'text/csv;charset=utf-8' }), `quizzitch-ipd-standings-${stamp()}.csv`);
}

async function exportLogCSV() {
  toast('Preparing integrity log', 'Downloading every forensic ledger…', 'info');
  try {
    const all = await fb.getAllForensics();
    const data = [];
    all.forEach((fx) => {
      const sub = submissions.get(fx.id);
      const s = sessions.get(fx.id);
      const who = sub ? sub.candidate : s || {};
      (fx.ledger || []).forEach((e) => data.push([who.name || '', who.schoolUid || '', who.teamId || '', fx.sessionId || '', e.seq, mmss(e.elapsed || 0), istStamp(e.t), LEVEL_LABEL[e.level] || e.level, e.type, e.message]));
    });
    downloadBlob(new Blob([`﻿${toCSV(['Name', 'School UID', 'Team ID', 'Session', 'Seq', 'T+', 'Time (IST)', 'Level', 'Type', 'Message'], data)}`], { type: 'text/csv;charset=utf-8' }), `quizzitch-integrity-log-${stamp()}.csv`);
  } catch (err) {
    toast('Export failed', err.message, 'danger');
  }
}

async function exportJSON() {
  toast('Preparing full export', 'Downloading forensic records and event log…', 'info');
  try {
    const [forensics, allEvents] = await Promise.all([fb.getAllForensics(), fb.getAllEvents()]);
    const payload = {
      exportedAt: new Date().toISOString(),
      paperId: settings.meta.paperId,
      control,
      answerKeyLoaded: !!answerKey,
      candidates: rows().map((r) => ({ uid: r.uid, session: r.s, submission: r.sub, score: scoreSubmission(r.sub), checksumVerified: r.sub ? verification(r.sub) : null })),
      forensics,
      events: allEvents,
      standings: standings().list
    };
    downloadBlob(new Blob([JSON.stringify(payload, (k, v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : v), 2)], { type: 'application/json' }), `quizzitch-full-export-${stamp()}.json`);
  } catch (err) {
    toast('Export failed', err.message, 'danger');
  }
}

/* --- 10 · TOOLS ----------------------------------------------------------- */
async function readJSONFile(input) {
  const file = input.files && input.files[0];
  if (!file) return null;
  const text = await file.text();
  input.value = '';
  return JSON.parse(text);
}

function keyFromAny(data) {
  if (Array.isArray(data)) {
    const key = {};
    data.forEach((q) => { if (q && q.id != null && Array.isArray(q.correct)) key[String(q.id)] = q.correct.map(Number); });
    return key;
  }
  if (data && typeof data === 'object') {
    const key = {};
    Object.entries(data).forEach(([id, v]) => { if (Array.isArray(v)) key[id] = v.map(Number); });
    return key;
  }
  return {};
}

async function onSeedFile() {
  try {
    const data = await readJSONFile($('file-questions'));
    if (!Array.isArray(data) || !data.length) throw new Error('Expected a non-empty JSON array of questions.');
    const bad = data.filter((q) => !q || q.id == null || typeof q.question !== 'string' || !Array.isArray(q.options) || q.options.length < 2);
    if (bad.length) throw new Error(`${bad.length} item(s) are missing id / question / options.`);
    if (!confirm(`Upload ${data.length} questions to Firestore? Existing documents with the same id are overwritten.`)) return;
    const n = await fb.seedQuestions(data);
    setText('seed-status', `Uploaded ${n} questions (answer fields stripped).`);
    const key = keyFromAny(data);
    if (Object.keys(key).length && confirm(`The file also contains ${Object.keys(key).length} answers. Save them as the invigilator-only answer key?`)) {
      await fb.saveAnswerKey(key);
      answerKey = deepFreeze(key);
      paintKeyState();
      renderResults();
    }
  } catch (err) {
    setText('seed-status', `Failed: ${err.message}`);
  }
}

async function onKeyFile() {
  try {
    const key = keyFromAny(await readJSONFile($('file-key')));
    const n = Object.keys(key).length;
    if (!n) throw new Error('No answers found in the file.');
    await fb.saveAnswerKey(key);
    answerKey = deepFreeze(key);
    setText('key-status', `Answer key saved · ${n} items.`);
    paintKeyState();
    renderResults();
  } catch (err) {
    setText('key-status', `Failed: ${err.message}`);
  }
}

async function parseRosterFile(file) {
  const text = await file.text();
  const name = file.name.toLowerCase();
  let rawList = [];

  if (name.endsWith('.json') || text.trim().startsWith('[') || text.trim().startsWith('{')) {
    const data = JSON.parse(text);
    if (Array.isArray(data)) {
      rawList = data;
    } else if (data && typeof data === 'object') {
      if (Array.isArray(data.candidates)) rawList = data.candidates;
      else if (Array.isArray(data.roster)) rawList = data.roster;
      else {
        for (const [k, v] of Object.entries(data)) {
          if (v && v.teams) {
            const sUid = k;
            for (const [tId, team] of Object.entries(v.teams)) {
              const members = team.members || [];
              for (const m of members) {
                const mName = typeof m === 'string' ? m : m.name;
                const mId = typeof m === 'object' ? m.memberId : '';
                rawList.push({ schoolUid: sUid, teamId: tId, name: mName, memberId: mId });
              }
            }
          }
        }
      }
    }
  } else {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) throw new Error('CSV must have a header row and at least one candidate row.');
    const headers = lines[0].split(',').map((h) => h.trim().toLowerCase().replace(/^["']|["']$/g, ''));
    const sIdx = headers.findIndex((h) => h.includes('school'));
    const tIdx = headers.findIndex((h) => h.includes('team'));
    const nIdx = headers.findIndex((h) => h.includes('name') || h.includes('candidate') || h.includes('student'));
    const mIdx = headers.findIndex((h) => h.includes('member'));
    const dIdx = headers.findIndex((h) => h.includes('division'));

    if (sIdx === -1 || tIdx === -1 || nIdx === -1) {
      throw new Error('CSV header must contain "schoolUid", "teamId", and "name" columns.');
    }

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map((c) => c.trim().replace(/^["']|["']$/g, ''));
      if (cols.length <= Math.max(sIdx, tIdx, nIdx)) continue;
      rawList.push({
        schoolUid: cols[sIdx],
        teamId: cols[tIdx],
        name: cols[nIdx],
        memberId: mIdx !== -1 ? cols[mIdx] : '',
        division: dIdx !== -1 ? cols[dIdx] : ''
      });
    }
  }

  const entries = [];
  for (const item of rawList) {
    if (!item.schoolUid || !item.teamId || !item.name) continue;
    const cleanTeamId = item.teamId.replace(/-M\d{1,2}$/i, '');
    const normalizedName = normName(item.name);
    const key = await identityKeyFor(item.schoolUid.trim(), cleanTeamId, normalizedName);
    entries.push({
      identityKey: key,
      schoolUid: item.schoolUid.trim(),
      teamId: item.teamId.trim(),
      cleanTeamId,
      name: item.name.trim(),
      normName: normalizedName,
      memberId: (item.memberId || '').trim(),
      division: (item.division || '').trim()
    });
  }
  return entries;
}

async function onRosterFile() {
  const file = $('file-roster').files && $('file-roster').files[0];
  if (!file) return;
  setText('roster-status', 'Parsing roster…');
  try {
    const entries = await parseRosterFile(file);
    if (!entries.length) throw new Error('No valid candidate records found in file.');
    if (!confirm(`Upload ${entries.length} candidates to the authoritative roster? Existing entries with the same identity key will be updated.`)) {
      $('file-roster').value = '';
      setText('roster-status', 'Cancelled.');
      return;
    }
    const n = await fb.uploadRoster(entries);
    $('file-roster').value = '';
    setText('roster-status', `Uploaded ${n} candidate roster entries to Firestore.`);
    toast('Roster uploaded', `${n} candidates active in roster`, 'ok');
  } catch (err) {
    $('file-roster').value = '';
    setText('roster-status', `Failed: ${err.message}`);
    toast('Roster upload failed', err.message, 'danger');
  }
}

async function releaseLock(key, statusId) {
  if (!/^[0-9a-f]{40}$/.test(key)) { setText(statusId, 'Identity keys are 40 hexadecimal characters.'); return; }
  if (!confirm('Release this identity lock? The candidate will be able to sign in from another device (not after a sealed submission).')) return;
  try {
    await fb.releaseIdentity(key);
    setText(statusId, 'Lock released.');
    toast('Identity lock released', key.slice(0, 12), 'ok');
  } catch (err) {
    setText(statusId, `Failed: ${err.message}`);
  }
}

/* --- 11 · WIRING ---------------------------------------------------------- */
function renderAll() {
  renderGrid();
  renderFeed();
  paintControl();
  renderResults();
}

function subscribe() {
  unsubs.push(fb.watchControl((c) => { control = c; paintControl(); }));
  unsubs.push(fb.watchSessions((list) => {
    sessions.clear();
    list.forEach((s) => sessions.set(s.id, s));
    renderGrid();
  }));
  unsubs.push(fb.watchEvents(200, (list) => { events = list; renderFeed(); }));
  unsubs.push(fb.watchSubmissions((list) => {
    submissions.clear();
    list.forEach((s) => submissions.set(s.id, { ...s, uid: s.uid || s.id }));
    queueVerification();
    renderGrid();
    renderResults();
  }));
  ticker = setInterval(() => { renderGrid(); paintControl(); }, 5000);
}

function unsubscribe() {
  unsubs.forEach((u) => u());
  unsubs = [];
  clearInterval(ticker);
  sessions.clear();
  submissions.clear();
  events = [];
}

function wire() {
  $('form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    show('auth-error', false);
    $('btn-login').disabled = true;
    try {
      await fb.signInAdmin($('in-email').value.trim(), $('in-password').value);
    } catch (err) {
      setText('auth-error', err.code === 'auth/invalid-credential' ? 'Incorrect email or password.' : err.message);
      show('auth-error', true);
    } finally {
      $('btn-login').disabled = false;
      $('in-password').value = '';
    }
  });
  $('btn-signout').addEventListener('click', () => fb.signOutUser());
  $('btn-denied-signout').addEventListener('click', () => fb.signOutUser());

  const email = () => (me && me.email) || '';
  $('btn-ctl-start').addEventListener('click', () => {
    if (!confirm(`Release paper ${settings.meta.paperId} to every waiting candidate now? The ${Math.round(settings.exam.durationSeconds / 60)}-minute window starts on the server clock.`)) return;
    command(() => fb.setControl({ status: 'active', restart: true, durationSeconds: settings.exam.durationSeconds, paperId: settings.meta.paperId }, email()), 'Paper released.');
  });
  $('btn-ctl-extend').addEventListener('click', () => {
    if (!confirm('Extend the examination window by 5 minutes for all candidates?')) return;
    command(() => fb.extendControl(300, email()), 'Window extended by 5 minutes.');
  });
  $('btn-ctl-end').addEventListener('click', () => {
    if (!confirm('END the paper now? Every candidate still writing is force-submitted.')) return;
    command(() => fb.setControl({ status: 'ended' }, email()), 'Paper ended.');
  });
  $('btn-ctl-reset').addEventListener('click', () => {
    if (!confirm('Reset control to WAITING? Candidates who have not entered will be held at the protocol screen.')) return;
    command(() => fb.setControl({ status: 'waiting' }, email()), 'Control reset to waiting.');
  });

  document.querySelectorAll('.dtab').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.dtab').forEach((x) => { x.classList.toggle('is-active', x === b); x.setAttribute('aria-selected', x === b ? 'true' : 'false'); });
    ['live', 'results', 'tools'].forEach((t) => show(`tab-${t}`, t === b.dataset.tab));
    renderResults();
  }));

  $('f-search').addEventListener('input', (e) => { filters.q = e.target.value; renderGrid(); });
  $('f-school').addEventListener('change', (e) => { filters.school = e.target.value; filters.team = ''; $('f-team').value = ''; renderGrid(); });
  $('f-team').addEventListener('change', (e) => { filters.team = e.target.value; renderGrid(); });
  $('f-division').addEventListener('change', (e) => { filters.division = e.target.value; renderGrid(); });
  $('f-flags').addEventListener('change', (e) => { filters.minStrikes = Number(e.target.value); renderGrid(); });
  $('f-status').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    filters.status = b.dataset.v;
    $('f-status').querySelectorAll('button').forEach((x) => x.classList.toggle('is-active', x === b));
    renderGrid();
  });

  $('btn-export-csv').addEventListener('click', exportCandidatesCSV);
  $('btn-export-standings').addEventListener('click', exportStandingsCSV);
  $('btn-export-log').addEventListener('click', exportLogCSV);
  $('btn-export-json').addEventListener('click', exportJSON);
  $('file-questions').addEventListener('change', onSeedFile);
  $('file-key').addEventListener('change', onKeyFile);
  $('file-roster').addEventListener('change', onRosterFile);
  $('btn-release').addEventListener('click', () => releaseLock($('in-identity').value.trim(), 'release-status'));

  $('btn-fx-close').addEventListener('click', () => { show('modal-forensic', false); fxCurrent = null; });
  $('modal-forensic').addEventListener('click', (e) => { if (e.target === $('modal-forensic')) $('btn-fx-close').click(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('modal-forensic').hidden) $('btn-fx-close').click(); });
  $('btn-fx-json').addEventListener('click', () => {
    if (!fxCurrent) return;
    const { r, fx } = fxCurrent;
    downloadBlob(new Blob([JSON.stringify({ session: r.s, submission: r.sub, forensics: fx, score: scoreSubmission(r.sub) }, (k, v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : v), 2)], { type: 'application/json' }),
      `quizzitch-record-${r.schoolUid}-${r.teamId}-${r.uid.slice(0, 8)}.json`);
  });
  $('btn-fx-release').addEventListener('click', () => fxCurrent && releaseLock(fxCurrent.r.identityKey, 'fx-verify'));
}

/* --- 12 · BOOT ------------------------------------------------------------ */
async function boot() {
  try {
    const res = await fetch('config/settings.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`config/settings.json → HTTP ${res.status}`);
    settings = deepFreeze(await res.json());
  } catch (err) {
    bootError('Configuration unavailable', err.message);
    return;
  }
  mount($('f-division'), h('option', { value: '' }, 'All divisions'), settings.divisions.map((d) => h('option', { value: d.code }, `${d.code} · ${d.name}`)));
  wire();

  const ok = await fb.initFirebase(settings.firebase);
  if (!ok) {
    bootError('Firebase unavailable', 'The command center needs Firebase. Check settings.json → firebase and your network, then reload.');
    return;
  }
  fb.onAuth(async (user) => {
    unsubscribe();
    me = user;
    if (!user || user.isAnonymous) { if (user) await fb.signOutUser(); view('auth'); return; }
    if (!(await fb.isAdmin(user.uid))) {
      setText('denied-uid', user.uid);
      view('denied');
      return;
    }
    setText('admin-email', user.email || user.uid);
    view('deck');
    answerKey = await fb.loadAnswerKey();
    if (answerKey) answerKey = deepFreeze(answerKey);
    paintKeyState();
    subscribe();
    renderAll();
  });
}

boot().catch((err) => bootError('Command center failed to start', err.message));
