/* ==========================================================================
   QUIZZITCH — quiz/render.js
   Every DOM write in the portal happens here. The module subscribes to the
   state bus and repaints; it never mutates application state directly — user
   gestures are re-published as intents for quiz/engine.js to act on.
   ========================================================================== */

import {
  CFG, S, bus, EV, Vault,
  scheme, moduleOf, clamp, esc,
  answeredCount, flaggedCount, elapsedSeconds
} from '../core/state.js';

import { pad, mmss, wallTime, stampUTC } from '../utils/timer.js';

/* --- 01 · DOM ACCESS ------------------------------------------------------ */
const cache = new Map();

/** Cached getElementById. */
export function el(id) {
  if (!cache.has(id)) cache.set(id, document.getElementById(id));
  return cache.get(id);
}

const setText = (id, value) => { const n = el(id); if (n) n.textContent = value; };
const setHTML = (id, value) => { const n = el(id); if (n) n.innerHTML = value; };
const show = (id, visible) => { const n = el(id); if (n) n.hidden = !visible; };

/* --- 02 · STATIC SCAFFOLDING (built once from config) --------------------- */
export function buildStaticUI() {
  const s = CFG.settings;

  /* Hero + briefing badges */
  setText('hero-duration', `${mmss(s.exam.durationSeconds)} · ${CFG.questions.length} items`);
  setText('hero-build', `Build ${s.meta.build}`);
  setText('brief-badge', `${mmss(s.exam.durationSeconds)} · ${CFG.maxScore} marks · ${CFG.questions.length} items`);
  setText('dos-round', s.meta.round);
  setText('badge-round', s.meta.round.split('—')[0].trim());
  setText('foot-preflight',
    `${s.meta.portal} secure portal · build ${s.meta.build} · ${s.meta.organiser} · all processing local to this device`);

  /* Module strip on the hero */
  const strip = el('hero-modules');
  if (strip) {
    strip.innerHTML = '';
    CFG.modules.forEach((m) => {
      const b = document.createElement('span');
      b.className = 'badge badge--outline';
      b.title = m.blurb || '';
      b.textContent = `${m.code} · ${m.name}`;
      strip.appendChild(b);
    });
  }

  /* Grade options */
  const grade = el('in-grade');
  if (grade) {
    s.registry.grades.forEach((g) => {
      const opt = document.createElement('option');
      opt.value = g;
      opt.textContent = g;
      grade.appendChild(opt);
    });
  }

  /* Registry defaults + hints */
  const school = el('in-school');
  if (school && s.registry.defaultSchool) school.value = s.registry.defaultSchool;
  const idIn = el('in-id');
  if (idIn) idIn.placeholder = s.registry.idPlaceholder;
  setText('hint-id', `Format ${s.registry.idPlaceholder.replace(/0/g, 'X')}`);

  /* Protocol briefing */
  const rules = el('rules-list');
  if (rules) {
    rules.innerHTML = '';
    s.briefing.forEach((line) => {
      const li = document.createElement('li');
      li.innerHTML = line;   // authored content from settings.json, not user input
      rules.appendChild(li);
    });
  }

  /* Clock face + telemetry seeds */
  setText('clock-val', 'T‑' + mmss(s.exam.durationSeconds));
  setText('tel-answered', `0 / ${CFG.questions.length}`);
  setText('tel-strikes', `0 / ${s.security.maxStrikes}`);
  setText('q-progress', `00 / ${pad(CFG.questions.length)} answered`);
  setHTML('dos-score', `0<small>/${CFG.maxScore}</small>`);

  buildMatrixTabs();
}

function buildMatrixTabs() {
  const host = el('matrix-tabs');
  if (!host) return;
  host.innerHTML = '';
  CFG.modules.forEach((m) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.cat = String(m.id);
    b.setAttribute('role', 'tab');
    b.title = m.name;
    b.innerHTML = `<span>${esc(m.code)}</span>${esc(m.short)}`;
    b.addEventListener('click', () => bus.emit(EV.INTENT_MODULE, m.id));
    host.appendChild(b);
  });
}

/* --- 03 · STAGE ROUTER (screen visibility) -------------------------------- */
export function paintStage(stage) {
  show('screen-preflight', stage === 'preflight');
  show('screen-exam', stage === 'live');
  show('screen-dossier', stage === 'sealed');

  const badge = el('badge-stage');
  if (!badge) return;

  if (stage === 'preflight') {
    badge.className = 'badge badge--live';
    badge.innerHTML = '<i class="dot dot--pulse"></i> Pre-flight';
  } else if (stage === 'live') {
    badge.className = 'badge badge--danger';
    badge.innerHTML = '<i class="dot dot--pulse"></i> Live';
  } else {
    const dq = S.verdict === 'DISQUALIFIED';
    badge.className = `badge ${dq ? 'badge--danger' : 'badge--ok'}`;
    badge.innerHTML = `<i class="dot"></i> ${dq ? 'Disqualified' : 'Sealed'}`;
  }
}

/* --- 04 · PRE-FLIGHT DIAGNOSTICS ----------------------------------------- */
export function addDiagRow(probe, index) {
  const list = el('diag-list');
  if (!list) return;
  const li = document.createElement('li');
  li.id = `diagrow-${probe.key}`;   // namespaced: "diag-<key>" collides with the kv-strip ids
  li.innerHTML =
    `<span class="ix">${pad(index + 1)}</span>` +
    `<span class="nm">${esc(probe.name)}<em>${esc(probe.detail)}</em></span>` +
    `<span class="st st--wait">Probing…</span>`;
  list.appendChild(li);
}

export function setDiagResult(key, result) {
  const row = document.getElementById(`diagrow-${key}`);
  if (!row) return;
  const cell = row.querySelector('.st');
  if (!cell) return;
  const cls = result.ok ? (result.warn ? 'st--warn' : 'st--ok') : 'st--fail';
  const glyph = result.ok ? (result.warn ? '▲' : '●') : '✕';
  cell.className = `st ${cls}`;
  cell.textContent = `${glyph} ${result.text}`;
}

export function setDiagSummary(fails, warns) {
  const badge = el('diag-summary');
  if (!badge) return;
  badge.className = 'badge ' + (fails ? 'badge--danger' : warns ? 'badge--warn' : 'badge--ok');
  badge.textContent = fails
    ? `${fails} fault${fails > 1 ? 's' : ''}`
    : warns ? `${warns} advisory` : 'System Verified & Ready';
}

export function paintEnvironment(env) {
  setText('diag-node', env.node);
  setText('diag-raster', env.raster);
  setText('diag-locale', env.locale);
  setText('diag-tz', env.offset);
}

export function paintSession(sessionId) {
  setText('sess-id', sessionId);
  setText('sess-issued', stampUTC());
}

/* --- 05 · GATE LEDGER ----------------------------------------------------- */
export function paintGates(gates, note) {
  const host = el('gate-list');
  if (host) {
    host.querySelectorAll('[data-gate]').forEach((node) => {
      const ok = !!gates[node.dataset.gate];
      node.className = `badge ${ok ? 'badge--ok' : 'badge--muted'}`;
    });
  }
  const launch = el('btn-launch');
  if (launch) launch.disabled = !Object.values(gates).every(Boolean);

  const noteNode = el('gate-note');
  if (noteNode) {
    noteNode.hidden = !note;
    noteNode.textContent = note || '';
  }

  setHTML('badge-cand', `CAND · <b>${esc(S.candidate.id || '—')}</b>`);
}

export function markFieldValidity(id, valid, hintId, hintText) {
  const node = el(id);
  if (node) node.classList.toggle('is-invalid', !valid);
  if (hintId) {
    const hint = el(hintId);
    if (hint) {
      hint.classList.toggle('is-bad', !valid);
      if (hintText) hint.textContent = hintText;
    }
  }
}

/* --- 06 · QUESTION CARD --------------------------------------------------- */
export function renderQuestion() {
  const q = CFG.questions[S.idx];
  if (!q) return;
  const r = S.responses[S.idx];
  const sc = scheme(q.scheme);
  const mod = moduleOf(q.catId);

  setHTML('q-num', `${pad(S.idx + 1)}<sup>/${pad(CFG.questions.length)}</sup>`);
  setText('q-cat', `${mod.code} · ${mod.name}`);
  setText('q-scheme', sc.label);
  setText('q-marks', sc.marks);
  setText('q-text', q.question);

  /* Supplement: the item's own note, otherwise the scheme's standing note. */
  const supp = (q.supplement && q.supplement.trim()) || sc.note || '';
  const suppNode = el('q-supp');
  if (suppNode) {
    suppNode.textContent = supp;
    suppNode.hidden = !supp;
  }

  const state = el('q-state');
  if (state) {
    if (r.flagged) { state.textContent = 'Flagged for review'; state.className = 'badge badge--warn'; }
    else if (r.sel.length) { state.textContent = 'Answered'; state.className = 'badge badge--ok'; }
    else { state.textContent = 'Unanswered'; state.className = 'badge badge--outline'; }
  }

  const flagBtn = el('btn-flag');
  if (flagBtn) flagBtn.textContent = r.flagged ? '⚑ Unflag' : '⚑ Flag';

  const prevBtn = el('btn-prev');
  if (prevBtn) prevBtn.disabled = S.idx === 0;

  const nextBtn = el('btn-next');
  if (nextBtn) {
    nextBtn.textContent = S.idx === CFG.questions.length - 1
      ? 'Save & return to 01 ▶'
      : 'Save & proceed ▶';
  }

  renderOptions(q, r, sc);
  renderProgress();
}

function renderOptions(q, r, sc) {
  const host = el('q-opts');
  if (!host) return;
  host.innerHTML = '';

  q.options.forEach((text, oi) => {
    const selected = r.sel.indexOf(oi) > -1;
    const li = document.createElement('li');
    li.className = 'opt' + (selected ? ' is-selected' : '');
    li.dataset.multi = String(!!sc.multi);
    li.dataset.index = String(oi);
    li.setAttribute('role', sc.multi ? 'checkbox' : 'radio');
    li.setAttribute('aria-checked', selected ? 'true' : 'false');
    li.setAttribute('tabindex', '0');
    li.innerHTML =
      `<span class="opt__key">${CFG.letters[oi] || oi + 1}</span>` +
      `<span class="opt__text">${esc(text)}</span>`;

    li.addEventListener('click', () => bus.emit(EV.INTENT_PICK, oi));
    li.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        bus.emit(EV.INTENT_PICK, oi);
      }
    });
    host.appendChild(li);
  });
}

export function renderProgress() {
  const answered = answeredCount();
  const flagged = flaggedCount();
  const total = CFG.questions.length;

  setText('q-progress', `${pad(answered)} / ${pad(total)} answered`);
  setText('tel-answered', `${answered} / ${total}`);
  setBar('tel-answered-bar', (answered / total) * 100);
  setText('tel-flagged', String(flagged));
  setBar('tel-flagged-bar', (flagged / total) * 100);
}

function setBar(id, pct) {
  const node = el(id);
  if (node) node.style.width = `${clamp(pct, 0, 100).toFixed(1)}%`;
}

/* --- 07 · QUESTION MATRIX ------------------------------------------------- */
export function renderMatrix() {
  const mod = moduleOf(S.activeModule);
  setText('matrix-cat', `${mod.code} · ${mod.short}`);

  const tabs = el('matrix-tabs');
  if (tabs) {
    tabs.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('is-on', Number(b.dataset.cat) === S.activeModule);
    });
  }

  const host = el('matrix');
  if (!host) return;
  host.innerHTML = '';

  CFG.questions.forEach((q, i) => {
    if (q.catId !== S.activeModule) return;
    const r = S.responses[i];
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'matrix__cell'
      + (r.sel.length ? ' is-answered' : '')
      + (r.flagged ? ' is-flagged' : '')
      + (i === S.idx ? ' is-current' : '');
    b.textContent = pad(i + 1);
    b.title = `${moduleOf(q.catId).short} · ${scheme(q.scheme).label}`;
    b.addEventListener('click', () => bus.emit(EV.INTENT_NAV, i));
    host.appendChild(b);
  });
}

/* --- 08 · HUD CLOCK & STRIKES -------------------------------------------- */
export function paintClock(remaining) {
  const s = CFG.settings.exam;
  setText('clock-val', 'T‑' + mmss(remaining));

  const node = el('clock');
  if (node) {
    node.classList.toggle('is-crit', remaining <= s.criticalAtSeconds);
    node.classList.toggle('is-warn', remaining > s.criticalAtSeconds && remaining <= s.warnAtSeconds);
  }

  setText('tel-clock', wallTime());

  if (S.qEnterTs) {
    const dwell = (S.responses[S.idx].timeMs + (performance.now() - S.qEnterTs)) / 1000;
    setText('q-timer', `Δt ${mmss(dwell)}`);
  }
}

export function paintStrikes() {
  const max = CFG.settings.security.maxStrikes;
  const host = el('strikes');
  if (host) {
    host.querySelectorAll('.strikes__pip').forEach((pip, i) => {
      pip.classList.toggle('is-hit', i < S.strikes);
    });
  }
  setText('tel-strikes', `${S.strikes} / ${max}`);
  setBar('tel-strikes-bar', (S.strikes / max) * 100);
}

export function paintFocusCounter() {
  setText('tel-blur', String(S.blurCount));
  setBar('tel-blur-bar', S.blurCount * 20);
}

/* --- 09 · SECURITY LOG & TOASTS ------------------------------------------ */
export function appendLog(entry) {
  const box = el('logbox');
  if (box) {
    const line = document.createElement('div');
    line.className = `logline sev-${entry.sev}`;
    line.innerHTML =
      `<span class="ts">${esc(entry.clock)}</span>` +
      `<span class="msg">[${esc(entry.cls)}] ${esc(entry.msg)}</span>`;
    box.appendChild(line);

    const capacity = CFG.settings.security.logDomCap;
    while (box.children.length > capacity) box.firstChild.remove();
    box.scrollTop = box.scrollHeight;
  }
  setText('log-count', String(S.log.length));
}

export function showToast({ title, body, kind, ttl }) {
  const rail = el('toasts');
  if (!rail) return;

  const node = document.createElement('div');
  node.className = 'toast' + (kind ? ` toast--${kind}` : '');
  node.innerHTML =
    `<div class="toast__head"><span>${esc(title)}</span><time>${wallTime()}</time></div>` +
    `<div class="toast__body">${esc(body)}</div>`;
  rail.appendChild(node);

  while (rail.children.length > 4) rail.firstChild.remove();

  setTimeout(() => {
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 320);
  }, ttl || 6000);
}

export function clearToasts() {
  const rail = el('toasts');
  if (rail) rail.innerHTML = '';
}

/* --- 10 · OPTICAL TELEMETRY ---------------------------------------------- */
export function paintOptical(sample) {
  const o = S.optic;

  /* Pre-flight calibration read-outs */
  if (S.stage === 'preflight') {
    const luma = el('cal-luma');
    if (luma) {
      luma.textContent = `${Math.round(o.luma)} / 255`;
      luma.className = 'meter-cell__v ' + (o.luma < 34 ? 'is-bad' : o.luma < 62 ? 'is-warn' : 'is-ok');
    }
    const face = el('cal-face');
    if (face) {
      face.textContent = sample.present
        ? (sample.faces > 1 ? `${sample.faces} profiles` : 'Locked')
        : 'No subject';
      face.className = 'meter-cell__v ' + (sample.present ? (sample.faces > 1 ? 'is-warn' : 'is-ok') : 'is-bad');
    }
    return;
  }

  /* Live status strip */
  const face = el('tb-face');
  if (face) {
    const label = sample.faces === 0 ? 'Absent' : sample.faces > 1 ? 'Multiple' : 'Locked';
    face.innerHTML = `Subject lock <b>${label}</b>`;
    face.className = 'chip ' + (sample.faces === 1 ? 'chip--accent' : 'chip--danger');
  }

  const stab = el('tb-stab');
  if (stab) {
    stab.innerHTML = `Optical stability <b>${o.stability.toFixed(1)}%</b>`;
    stab.className = 'chip ' + (o.stability > 90 ? 'chip--accent' : o.stability > 72 ? 'chip--warn' : 'chip--danger');
  }

  const gadget = el('tb-gadget');
  if (gadget) {
    gadget.innerHTML = `Gadget scan <b>${sample.gadget ? 'Alert' : 'Clear'}</b>`;
    gadget.className = 'chip ' + (sample.gadget ? 'chip--danger' : 'chip--accent');
  }

  /* Subject bounding box */
  const box = el('track');
  if (box) {
    if (sample.present && o.box) {
      box.hidden = false;
      box.style.left = `${(o.box.x * 100).toFixed(1)}%`;
      box.style.top = `${(o.box.y * 100).toFixed(1)}%`;
      box.style.width = `${(o.box.w * 100).toFixed(1)}%`;
      box.style.height = `${(o.box.h * 100).toFixed(1)}%`;
      setText('track-label', `Subject 01 · L${Math.round(o.luma)} · E${(o.edges * 100).toFixed(0)}`);
    } else {
      box.hidden = true;
    }
  }

  /* Meters */
  const presence = el('tel-presence');
  if (presence) {
    presence.textContent = `${o.presencePct.toFixed(1)}%`;
    presence.className = 'meter-cell__v ' + (o.presencePct > 92 ? 'is-ok' : o.presencePct > 75 ? 'is-warn' : 'is-bad');
  }
  const presenceBar = el('tel-presence-bar');
  if (presenceBar) {
    presenceBar.style.width = `${clamp(o.presencePct, 0, 100).toFixed(1)}%`;
    presenceBar.className = o.presencePct > 92 ? 'is-ok' : o.presencePct > 75 ? 'is-warn' : 'is-bad';
  }

  const motionPct = clamp(o.motion * 5, 0, 100);
  const motion = el('tel-motion');
  if (motion) {
    motion.textContent = o.motion.toFixed(2);
    motion.className = 'meter-cell__v ' + (motionPct > 70 ? 'is-warn' : '');
  }
  setBar('tel-motion-bar', motionPct);
}

/* --- 11 · OPTICAL LINK STATE (pre-flight + live viewport chrome) --------- */
export function paintOpticState(mode, text) {
  const badge = el('optic-state');
  if (badge) {
    badge.textContent = text;
    badge.className = 'badge ' + ({
      online: 'badge--ok',
      negotiating: 'badge--accent',
      refused: 'badge--danger',
      degraded: 'badge--warn'
    }[mode] || 'badge--muted');
  }
}

export function mountCameraInto(hostId) {
  const host = el(hostId);
  const cam = el('cam');
  if (!host || !cam) return;
  cam.classList.remove('visually-hidden');
  host.insertBefore(cam, host.firstChild);
}

export function paintBaseline(dataUrl) {
  const img = el('snap-img');
  if (img) { img.src = dataUrl; img.hidden = false; }
  show('snap-frame', true);
  show('snap-empty', false);
  const btn = el('btn-snap');
  if (btn) btn.textContent = 'Re-capture baseline';
}

/* --- 12 · OVERLAYS -------------------------------------------------------- */
export const overlay = {
  open(id) { show(id, true); },
  close(id) { show(id, false); },
  bootError(message, detail) {
    setText('ov-boot-msg', message);
    setText('ov-boot-detail', detail || '');
    show('ov-boot', true);
  },
  focusAlarm(kind, clockText, strikesText, seconds) {
    setText('ov-focus-kind', kind);
    setText('ov-focus-clock', clockText);
    setText('ov-focus-strikes', strikesText);
    this.focusCount(seconds);
    show('ov-focus', true);
  },
  focusCount(seconds) {
    setHTML('ov-focus-count',
      `${Math.max(0, seconds)}<small>seconds to acknowledge — failure adds a further strike</small>`);
  },
  redockCount(seconds) {
    setHTML('ov-fs-count', `${Math.max(0, seconds)}<small>seconds to re-dock</small>`);
  },
  lockout(trigger, clockText, criticalCount) {
    setText('ov-lock-trigger', trigger);
    setText('ov-lock-clock', clockText);
    setText('ov-lock-count', `${criticalCount} critical`);
    show('ov-lock', true);
  },
  submit() {
    const answered = answeredCount();
    const total = CFG.questions.length;
    setText('sub-answered', `${answered} / ${total}`);
    setText('sub-unatt', `${total - answered} items`);
    setText('sub-flag', `${flaggedCount()} flagged`);
    setText('sub-left', `${mmss(S.remaining)} remaining`);
    setText('sub-strikes', `${S.strikes} / ${CFG.settings.security.maxStrikes}`);
    show('ov-submit', true);
  },
  closeAll() {
    ['ov-focus', 'ov-fs', 'ov-submit', 'ov-lock'].forEach((id) => show(id, false));
  }
};

/* --- 13 · AUDIT DOSSIER --------------------------------------------------- */
export function renderDossier(d) {
  /* Header */
  setText('dos-name', d.candidate.name || '—');
  setText('dos-id', `${d.candidate.id || '—'} · Grade ${d.candidate.grade || '—'}`);
  setText('dos-school', d.candidate.school || '—');
  setText('dos-stamp', stampUTC(new Date(d.meta.generated)));

  const verdict = el('dos-verdict');
  if (verdict) {
    if (d.meta.verdict === 'DISQUALIFIED') {
      verdict.textContent = `Disqualified — ${d.meta.dqReason}`;
      verdict.className = 'verdict is-dq';
    } else if (d.meta.submitReason === 'TIME_EXPIRY') {
      verdict.textContent = 'Auto-submitted to JotForm at T‑00:00' + (d.meta.proctored ? '' : ' · unproctored session');
      verdict.className = 'verdict is-warn';
    } else {
      verdict.textContent = 'Assessment Sealed & Submitted to JotForm' + (d.meta.proctored ? '' : ' · unproctored session');
      verdict.className = 'verdict' + (d.meta.proctored ? '' : ' is-warn');
    }
  }

  setHTML('dos-score', `${d.result.score}<small>/${d.result.max}</small>`);
  setHTML('dos-acc', `${d.result.accuracyPct.toFixed(0)}<small>%</small>`);
  setText('dos-time', mmss(d.result.timeConsumedSec));
  setText('dos-inc', String(d.proctoring.incidents));

  /* Module breakdown */
  const modBody = el('dos-modules');
  if (modBody) {
    modBody.innerHTML = d.modules.map((m) => {
      const pct = m.max ? clamp((m.marks / m.max) * 100, 0, 100) : 0;
      return '<tr>'
        + `<td><b>${esc(m.code)}</b> ${esc(m.short)}</td>`
        + `<td class="num">${m.attempted}</td>`
        + `<td class="num">${m.correct}</td>`
        + `<td class="num">${m.incorrect}</td>`
        + `<td class="num"><b>${m.marks}</b> / ${m.max}</td>`
        + `<td><span class="bar"><i style="width:${pct.toFixed(0)}%"></i></span></td>`
        + '</tr>';
    }).join('');
  }

  /* Optical summary */
  const p = d.proctoring;
  setText('dos-presence', p.opticalSamples ? `${p.presencePct.toFixed(1)}% of samples` : 'No optical link');
  setText('dos-stability', p.meanStabilityPct === null ? '—' : `${p.meanStabilityPct.toFixed(1)}% mean`);
  setText('dos-frames', `${p.opticalSamples} samples @ ${p.sampleRateHz} Hz`);
  setText('dos-optflags', `${p.opticalFlags} flag${p.opticalFlags === 1 ? '' : 's'}`);
  setText('dos-blur', `${p.focusBreaches} breach${p.focusBreaches === 1 ? '' : 'es'}`);
  setText('dos-fs', `${p.fullscreenReleases} release${p.fullscreenReleases === 1 ? '' : 's'}`);

  const baseline = S.baseline || Vault.get('qz.baseline');
  if (baseline) {
    const img = el('dos-snap');
    if (img) { img.src = baseline; img.hidden = false; }
    show('dos-snap-empty', false);
  }

  /* Item-level review */
  setText('dos-itemcount', `${d.items.length} items · ${d.result.max} marks`);
  const itemBody = el('dos-items');
  if (itemBody) {
    itemBody.innerHTML = d.items.map((it) => {
      const tag = it.status === 'CORRECT' ? 'tag--ok' : it.status === 'INCORRECT' ? 'tag--bad' : 'tag--skipped';
      return '<tr>'
        + `<td class="num"><b>${pad(it.n)}</b>${it.flagged ? ' <span style="color:var(--warn)">⚑</span>' : ''}</td>`
        + `<td>${esc(it.moduleShort)}</td>`
        + `<td style="font-size:10.5px">${esc(it.schemeLabel)}</td>`
        + `<td class="num">${esc(it.response)}</td>`
        + `<td class="num">${esc(it.key)}</td>`
        + `<td><span class="tag ${tag}">${it.status}</span></td>`
        + `<td class="num"><b>${it.marks > 0 ? '+' : ''}${it.marks}</b></td>`
        + `<td class="num">${mmss(it.seconds)}</td>`
        + `<td class="num">${it.visits}</td>`
        + '</tr>';
    }).join('');
  }

  /* Incident log */
  setText('dos-logcount', `${d.incidents.length} entries`);
  const logBody = el('dos-log');
  if (logBody) {
    const colour = {
      crit: 'var(--danger)', warn: 'var(--warn)', ok: 'var(--ok)', scan: 'var(--accent-2)'
    };
    logBody.innerHTML = d.incidents.map((l) => {
      const c = colour[l.sev] || 'inherit';
      return '<tr>'
        + `<td class="num">${esc(l.clock)}</td>`
        + `<td class="num">${esc(l.wall)}</td>`
        + `<td style="color:${c}"><b style="color:${c}">${esc(l.cls)}</b></td>`
        + `<td style="color:${c}">${esc(l.msg)}</td>`
        + `<td class="num">${l.strike ? '<span class="tag tag--bad">Yes</span>' : '—'}</td>`
        + '</tr>';
    }).join('');
  }

  setText('dos-hash', d.meta.integrityHash);
  setText('dos-gen', new Date(d.meta.generated).toLocaleString());
}

/** Re-labels the HUD clock once the paper is sealed. */
export function paintSealedClock(consumedSeconds) {
  setText('clock-cap', 'Time consumed');
  setText('clock-val', mmss(consumedSeconds));
  const node = el('clock');
  if (node) node.classList.remove('is-warn', 'is-crit');
}

/* --- 14 · LIVE VIEWPORT DEGRADED STATE ------------------------------------ */
export function paintDegradedViewport() {
  const live = el('optic-live');
  if (live) live.classList.add('is-degraded');

  const link = el('hud-link');
  if (link) {
    link.className = 'badge badge--warn';
    link.innerHTML = '<i class="dot"></i> Degraded';
  }
  setHTML('tb-face', 'Subject lock <b>No link</b>');
  setHTML('tb-stab', 'Optical stability <b>N/A</b>');
  setHTML('tb-gadget', 'Gadget scan <b>Unmonitored</b>');
  ['tb-face', 'tb-stab', 'tb-gadget'].forEach((id) => {
    const n = el(id);
    if (n) n.className = 'chip chip--warn';
  });
}

/* --- 15 · BUS SUBSCRIPTIONS ---------------------------------------------- */
export function bindRenderer() {
  bus.on(EV.STAGE, paintStage);
  bus.on(EV.LOG, appendLog);
  bus.on(EV.TOAST, showToast);
  bus.on(EV.STRIKE, paintStrikes);
  bus.on(EV.QUESTION, renderQuestion);
  bus.on(EV.MATRIX, renderMatrix);
  bus.on(EV.PROGRESS, renderProgress);
  bus.on(EV.CLOCK, ({ remaining }) => paintClock(remaining));
  bus.on(EV.OPTIC, paintOptical);
  bus.on(EV.SEALED, renderDossier);
}

/* Exposed so other modules can reuse the same helpers without re-querying. */
export { setText, setHTML, show, elapsedSeconds };
