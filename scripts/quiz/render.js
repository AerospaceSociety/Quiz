/* ==========================================================================
   QUIZZITCH — quiz/render.js
   Modern DOM renderer for Waiting Room, Assessment Workspace & Dossier.
   ========================================================================== */

import {
  CFG, S, bus, EV, Vault,
  scheme, moduleOf, clamp, esc,
  answeredCount, flaggedCount
} from '../core/state.js';

import { pad, mmss, wallTime, stampUTC } from '../utils/timer.js';

/* --- 01 · DOM ACCESS CACHE ------------------------------------------------ */
const cache = new Map();

export function el(id) {
  if (!cache.has(id)) cache.set(id, document.getElementById(id));
  return cache.get(id);
}

export const setText = (id, value) => { const n = el(id); if (n) n.textContent = value; };
export const setHTML = (id, value) => { const n = el(id); if (n) n.innerHTML = value; };
export const show = (id, visible) => { const n = el(id); if (n) n.hidden = !visible; };

const setBar = (id, pct) => {
  const n = el(id);
  if (n) n.style.width = `${clamp(pct, 0, 100).toFixed(1)}%`;
};

/* --- 02 · STATIC SCAFFOLDING ---------------------------------------------- */
export function buildStaticUI() {
  const s = CFG.settings;

  /* Hero & Briefing */
  setText('hero-duration', `${Math.round(s.exam.durationSeconds / 60)} Minutes · ${CFG.questions.length || 20} Questions`);
  setText('hero-build', `Build ${s.meta.build}`);
  setText('brief-badge', `${Math.round(s.exam.durationSeconds / 60)}:00 · ${CFG.questions.length || 20} Items`);
  setText('dos-round', s.meta.round);
  setText('badge-round', s.meta.round.split('—')[0].trim());

  /* Module strip on hero */
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

  /* Grade selection */
  const grade = el('in-grade');
  if (grade && grade.children.length <= 1) {
    s.registry.grades.forEach((g) => {
      const opt = document.createElement('option');
      opt.value = g;
      opt.textContent = `Class ${g}`;
      grade.appendChild(opt);
    });
  }

  /* Registry defaults */
  const school = el('in-school');
  if (school && !school.value && s.registry.defaultSchool) school.value = s.registry.defaultSchool;
  const idIn = el('in-id');
  if (idIn) idIn.placeholder = s.registry.idPlaceholder;

  /* Protocol briefing list */
  const rules = el('rules-list');
  if (rules) {
    rules.innerHTML = '';
    s.briefing.forEach((line) => {
      const li = document.createElement('li');
      li.innerHTML = line;
      rules.appendChild(li);
    });
  }

  /* Clock & initial meters */
  setText('clock-val', mmss(s.exam.durationSeconds));
  setText('tel-answered', `0 / ${CFG.questions.length || 20}`);
  setText('tel-strikes', `0 / ${s.security.maxStrikes}`);
  setText('q-progress', `00 / ${pad(CFG.questions.length || 20)} answered`);

  buildMatrixTabs();
}

export function buildMatrixTabs() {
  const host = el('matrix-tabs');
  if (!host) return;
  host.innerHTML = '';
  CFG.modules.forEach((m) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'matrix-tab' + (m.id === S.activeModule ? ' is-active' : '');
    b.dataset.cat = String(m.id);
    b.setAttribute('role', 'tab');
    b.textContent = `${m.code} · ${m.short}`;
    b.addEventListener('click', () => bus.emit(EV.INTENT_MODULE, m.id));
    host.appendChild(b);
  });
}

/* --- 03 · STAGE ROUTER ---------------------------------------------------- */
export function paintStage(stage) {
  show('screen-preflight', stage === 'preflight');
  show('screen-lounge', stage === 'lounge');
  show('screen-exam', stage === 'live');
  show('screen-dossier', stage === 'sealed');

  const badge = el('badge-stage');
  if (!badge) return;

  if (stage === 'preflight') {
    badge.className = 'badge badge--live';
    badge.innerHTML = '<i class="dot dot--pulse"></i> Candidate Setup';
  } else if (stage === 'lounge') {
    badge.className = 'badge badge--accent';
    badge.innerHTML = '<i class="dot dot--pulse"></i> Waiting Lounge';

    /* Populate lounge card data */
    setText('lounge-cand-name', S.candidate.name || 'Candidate');
    setText('lounge-cand-id', S.candidate.id || 'CC26-QZ-0000');
    setText('lounge-cand-code', S.candidate.code || 'VERIFIED');
  } else if (stage === 'live') {
    badge.className = 'badge badge--live';
    badge.innerHTML = '<i class="dot dot--pulse"></i> Assessment Active';
    setHTML('badge-cand', `CAND · <b>${esc(S.candidate.id || '—')}</b>`);
  } else {
    badge.className = 'badge badge--accent';
    badge.innerHTML = '<i class="dot"></i> Submitted';
  }
}

export function paintLoungeClock(seconds) {
  setText('lounge-clock', mmss(Math.max(0, seconds)));
}

/* --- 04 · GATE LEDGER & VALIDITY ------------------------------------------ */
export function paintGates(gates, note) {
  const host = el('gate-list');
  if (host) {
    host.querySelectorAll('[data-gate]').forEach((node) => {
      const ok = !!gates[node.dataset.gate];
      node.className = `badge ${ok ? 'badge--live' : 'badge--muted'}`;
    });
  }
  const launch = el('btn-launch');
  if (launch) {
    const allOk = Object.values(gates).every(Boolean);
    launch.disabled = !allOk;
  }

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
      hint.classList.toggle('is-ok', valid);
      if (hintText) hint.textContent = hintText;
    }
  }
}

export function paintSession(sessionId) {
  setText('sess-id', sessionId);
}

/* --- 05 · QUESTION CARD --------------------------------------------------- */
export function renderQuestion() {
  const q = CFG.questions[S.idx];
  if (!q) return;
  const r = S.responses[S.idx];
  const sc = scheme(q.scheme);
  const mod = moduleOf(q.catId);

  setHTML('q-num', `${pad(S.idx + 1)}<sup>/${pad(CFG.questions.length)}</sup>`);
  setText('q-cat', `${mod.code} · ${mod.name}`);
  setText('q-scheme', sc.label);
  setText('q-text', q.question);

  const supp = (q.supplement && q.supplement.trim()) || sc.note || '';
  const suppNode = el('q-supp');
  if (suppNode) {
    suppNode.textContent = supp;
    suppNode.hidden = !supp;
  }

  const state = el('q-state');
  if (state) {
    if (r.flagged) {
      state.textContent = 'Flagged for Review';
      state.className = 'badge badge--warn';
    } else if (r.sel.length) {
      state.textContent = 'Answered';
      state.className = 'badge badge--live';
    } else {
      state.textContent = 'Unvisited';
      state.className = 'badge badge--outline';
    }
  }

  const flagBtn = el('btn-flag');
  if (flagBtn) flagBtn.textContent = r.flagged ? '⚑ Unflag' : '⚑ Flag for Review';

  const prevBtn = el('btn-prev');
  if (prevBtn) prevBtn.disabled = S.idx === 0;

  const nextBtn = el('btn-next');
  if (nextBtn) {
    const isLast = S.idx === CFG.questions.length - 1;
    if (isLast) {
      nextBtn.innerHTML = 'Submit Assessment ▶';
      nextBtn.classList.add('btn--accent');
      nextBtn.classList.remove('btn--primary');
    } else {
      nextBtn.innerHTML = 'Save &amp; Proceed ▶ <span class="btn__key">N</span>';
      nextBtn.classList.remove('btn--accent');
      nextBtn.classList.add('btn--primary');
    }
  }

  renderOptions(q, r, sc);
}

function renderOptions(q, r, sc) {
  const host = el('q-opts');
  if (!host) return;
  host.innerHTML = '';

  const multi = sc.multi;

  q.options.forEach((optText, i) => {
    const isPicked = r.sel.includes(i);
    const li = document.createElement('li');
    li.className = 'opt' + (isPicked ? ' is-selected' : '');
    li.dataset.idx = String(i);

    const mark = document.createElement('span');
    mark.className = 'opt__marker';
    mark.textContent = CFG.letters[i] || String(i + 1);

    const txt = document.createElement('span');
    txt.className = 'opt__text';
    txt.textContent = optText;

    li.appendChild(mark);
    li.appendChild(txt);

    li.addEventListener('click', () => bus.emit(EV.INTENT_PICK, i));
    host.appendChild(li);
  });
}

/* --- 06 · QUESTION MATRIX ------------------------------------------------- */
export function renderMatrix() {
  const mod = moduleOf(S.activeModule);
  setText('matrix-cat', `${mod.code} · ${mod.short}`);

  const tabs = el('matrix-tabs');
  if (tabs) {
    tabs.querySelectorAll('.matrix-tab').forEach((b) => {
      b.classList.toggle('is-active', Number(b.dataset.cat) === S.activeModule);
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
    b.className = 'matrix-cell'
      + (r.sel.length ? ' is-answered' : '')
      + (r.flagged ? ' is-flagged' : '')
      + (i === S.idx ? ' is-current' : '');
    b.textContent = pad(i + 1);
    b.title = `Item ${i + 1}: ${moduleOf(q.catId).short}`;
    b.addEventListener('click', () => bus.emit(EV.INTENT_NAV, i));
    host.appendChild(b);
  });
}

export function renderProgress() {
  const total = CFG.questions.length;
  const answered = answeredCount();
  const flagged = flaggedCount();

  setText('tel-answered', `${answered} / ${total}`);
  setBar('tel-answered-bar', (answered / total) * 100);

  setText('tel-flagged', String(flagged));
  setBar('tel-flagged-bar', (flagged / total) * 100);

  setText('q-progress', `${pad(answered)} / ${pad(total)} answered`);
}

/* --- 07 · CLOCK & STRIKES ------------------------------------------------- */
export function paintClock(remaining) {
  const s = CFG.settings.exam;
  setText('clock-val', mmss(remaining));

  const node = el('clock');
  if (node) {
    node.classList.toggle('is-bad', remaining <= s.criticalAtSeconds);
    node.classList.toggle('is-warn', remaining > s.criticalAtSeconds && remaining <= s.warnAtSeconds);
  }

  setText('tel-clock', wallTime());

  if (S.qEnterTs && S.responses[S.idx]) {
    const dwell = (S.responses[S.idx].timeMs + (performance.now() - S.qEnterTs)) / 1000;
    setText('q-timer', `Δt ${mmss(dwell)}`);
  }
}

export function paintStrikes() {
  const max = CFG.settings.security.maxStrikes;
  const host = el('strikes');
  if (host) {
    host.querySelectorAll('.strikes__pip').forEach((pip, i) => {
      pip.classList.toggle('is-armed', i < S.strikes);
    });
  }
  setText('tel-strikes', `${S.strikes} / ${max}`);
  setBar('tel-strikes-bar', (S.strikes / max) * 100);
}

export function paintFocusCounter() {
  setText('tel-blur', String(S.blurCount));
  setBar('tel-blur-bar', S.blurCount * 25);
}

/* --- 08 · SECURITY LOG & TOASTS ------------------------------------------- */
export function appendLog(entry) {
  const box = el('logbox');
  if (box) {
    const line = document.createElement('div');
    line.className = `log-row is-${entry.level}`;
    line.innerHTML = `<span style="opacity:0.6">${esc(entry.clock)}</span> <span>[${esc(entry.category)}] ${esc(entry.message)}</span>`;
    box.appendChild(line);

    const capacity = CFG.settings.security.logDomCap || 260;
    while (box.children.length > capacity) box.firstChild.remove();
    box.scrollTop = box.scrollHeight;
  }
  setText('log-count', String(S.log.length));
}

export function showToast({ title, body, kind, ttl }) {
  const toast = el('toast');
  if (!toast) return;

  setText('toast-title', title);
  setText('toast-body', body);
  toast.className = `toast toast--${kind} is-active`;

  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.classList.remove('is-active');
  }, ttl || 4500);
}

/* --- 09 · OPTICAL & AI OBJECT RECOGNITION --------------------------------- */
export function paintOpticState(mode, text) {
  const badge = el('optic-state');
  if (badge) {
    badge.textContent = text;
    badge.className = 'badge ' + ({
      online: 'badge--live',
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
  cam.hidden = false;
  host.insertBefore(cam, host.firstChild);
}

export function paintBaseline(dataUrl) {
  const img = el('snap-img');
  if (img) { img.src = dataUrl; img.hidden = false; }
  show('snap-empty', false);
  const btn = el('btn-snap');
  if (btn) btn.textContent = 'Re-capture Baseline';
}

/** Updates the real-time AI object recognition tracking overlay */
export function paintObjectDetection(detection) {
  const box = el('obj-track');
  const label = el('obj-track-label');
  const tbGadget = el('tb-gadget');
  const tbFace = el('tb-face');

  if (!box || !detection) return;

  if (detection.found) {
    box.hidden = false;
    box.style.left = `${(detection.x * 100).toFixed(1)}%`;
    box.style.top = `${(detection.y * 100).toFixed(1)}%`;
    box.style.width = `${(detection.w * 100).toFixed(1)}%`;
    box.style.height = `${(detection.h * 100).toFixed(1)}%`;

    if (detection.isProhibited) {
      box.className = 'optic__obj-box is-prohibited';
      label.textContent = `ALERT: ${detection.className.toUpperCase()} (${(detection.score * 100).toFixed(0)}%)`;
      if (tbGadget) {
        tbGadget.className = 'chip chip--flagged';
        tbGadget.innerHTML = `Device Alert: <b>${detection.className}</b>`;
      }
    } else {
      box.className = 'optic__obj-box';
      label.textContent = `${detection.className} (${(detection.score * 100).toFixed(0)}%)`;
      if (tbGadget) {
        tbGadget.className = 'chip chip--accent';
        tbGadget.innerHTML = `Objects: <b>Clean</b>`;
      }
    }
  } else {
    box.hidden = true;
    if (tbGadget) {
      tbGadget.className = 'chip chip--accent';
      tbGadget.innerHTML = `Objects: <b>Clean</b>`;
    }
  }

  if (tbFace) {
    if (detection.personCount === 0) {
      tbFace.className = 'chip chip--flagged';
      tbFace.innerHTML = `Subject: <b>Absent</b>`;
    } else if (detection.personCount > 1) {
      tbFace.className = 'chip chip--flagged';
      tbFace.innerHTML = `Subject: <b>Multiple Persons (${detection.personCount})</b>`;
    } else {
      tbFace.className = 'chip chip--accent';
      tbFace.innerHTML = `Subject: <b>Verified (1 Person)</b>`;
    }
  }
}

/* --- 10 · SUBMISSION DOSSIER (NO ANSWERS STORED/REVEALED LOCALLY) ---------- */
export function renderDossier(d) {
  setText('dos-name', d.candidate.name || 'Candidate');
  setText('dos-id', `${d.candidate.id || '—'} · Class ${d.candidate.grade || '—'}`);
  setText('dos-code', d.candidate.code || 'VERIFIED');
  setText('dos-school', d.candidate.school || '—');
  setText('dos-stamp', stampUTC(new Date(d.meta.generated)));
  setText('dos-jf-id', d.jotform?.id || 'RECORDED_TO_JOTFORM');

  const verdict = el('dos-verdict');
  if (verdict) {
    if (d.meta.verdict === 'DISQUALIFIED') {
      verdict.textContent = `Submission Flagged & Transmitted to JotForm (Disqualified: ${d.meta.dqReason})`;
      verdict.className = 'verdict is-bad';
    } else {
      verdict.textContent = 'Assessment Choices Successfully Recorded to JotForm';
      verdict.className = 'verdict';
    }
  }

  setText('dos-answered', `${d.summary.answeredCount} / ${d.summary.totalItems}`);
  setText('dos-time', mmss(d.summary.timeConsumedSec));
  setText('dos-inc', String(d.proctoring.strikes + d.proctoring.objectViolations));
  setText('dos-verdict-tag', d.meta.verdict);

  /* Item level choice registry - NO answer keys or correctness shown! */
  setText('dos-itemcount', `${d.items.length} items recorded`);
  const itemBody = el('dos-items');
  if (itemBody) {
    itemBody.innerHTML = d.items.map((it) => {
      const hasChoice = it.selectedText && it.selectedText.length;
      const choiceHtml = hasChoice
        ? esc(it.selectedText.join(', '))
        : '<span style="color:var(--ink-4)">Unattempted</span>';
      return '<tr>'
        + `<td class="num"><b>${pad(it.n)}</b></td>`
        + `<td>${esc(it.moduleShort)}</td>`
        + `<td><code>${esc(it.questionId)}</code></td>`
        + `<td>${choiceHtml}</td>`
        + `<td class="num">${mmss(it.seconds)}</td>`
        + `<td class="num">${it.visits}</td>`
        + '</tr>';
    }).join('');
  }

  /* Incident log */
  setText('dos-logcount', `${d.incidents.length} entries`);
  const logBody = el('dos-log');
  if (logBody) {
    logBody.innerHTML = d.incidents.map((l) => {
      const isCrit = l.level === 'crit';
      return '<tr>'
        + `<td class="num">${esc(l.clock)}</td>`
        + `<td class="num">${esc(l.wall)}</td>`
        + `<td><b>${esc(l.category)}</b></td>`
        + `<td>${esc(l.message)}</td>`
        + `<td class="num">${isCrit ? '<span style="color:#F43F5E">Yes</span>' : '—'}</td>`
        + '</tr>';
    }).join('');
  }

  setText('dos-hash', d.meta.integrityHash);
  setText('dos-gen', new Date(d.meta.generated).toLocaleString());
}

/* --- 11 · BIND RENDERER TO STATE BUS -------------------------------------- */
export function bindRenderer() {
  bus.on(EV.STAGE, paintStage);
  bus.on(EV.LOG, appendLog);
  bus.on(EV.TOAST, showToast);
  bus.on(EV.STRIKE, paintStrikes);
  bus.on(EV.QUESTION, renderQuestion);
  bus.on(EV.MATRIX, renderMatrix);
  bus.on(EV.PROGRESS, renderProgress);
  bus.on(EV.CLOCK, ({ remaining }) => paintClock(remaining));
  bus.on(EV.LOUNGE_CLOCK, ({ remaining }) => paintLoungeClock(remaining));
  bus.on(EV.OBJECT_DETECTED, paintObjectDetection);
  bus.on(EV.SEALED, renderDossier);
}
