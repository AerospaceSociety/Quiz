/* ==========================================================================
   QUIZZITCH — render.js
   Every DOM write in the candidate portal. Dynamic content is inserted as
   text nodes (via util.h / textContent) — there is no innerHTML anywhere, so
   question stems, names and IDs can never be interpreted as markup. Formulae
   written as $…$ are typeset by KaTeX into dedicated nodes.
   ========================================================================== */

import { S, cfg, Stage, isAnswered, answeredCount, markedCount, unansweredCount } from './session.js';
import { cellState, moduleProgress } from './engine.js';
import { $, h, mount, setText, show, pad, mmss, istStamp } from './util.js';

const STAGES = {
  [Stage.SIGNIN]: 'stage-signin',
  [Stage.CALIBRATE]: 'stage-calibrate',
  [Stage.PROTOCOL]: 'stage-protocol',
  [Stage.EXAM]: 'stage-exam',
  [Stage.SUBMITTING]: 'stage-submitting',
  [Stage.SEALED]: 'stage-sealed'
};
const STEP_INDEX = { signin: 1, calibrate: 2, protocol: 3, exam: 4, submitting: 4, sealed: 5 };
const LETTER = (i) => String.fromCharCode(65 + i);
const sign = (v) => (v > 0 ? `+${v}` : v < 0 ? `−${Math.abs(v)}` : '0');

/* --- 01 · STAGE ROUTER ---------------------------------------------------- */
export function paintStage(stage) {
  show('boot', false);
  Object.entries(STAGES).forEach(([key, id]) => show(id, key === stage));
  show('topbar', stage === Stage.CALIBRATE || stage === Stage.PROTOCOL || stage === Stage.SEALED);
  const current = STEP_INDEX[stage] || 0;
  document.querySelectorAll('#stepper [data-step]').forEach((li) => {
    const n = Number(li.dataset.step);
    li.classList.toggle('is-done', n < current);
    li.classList.toggle('is-current', n === current);
  });
  window.scrollTo(0, 0);
}

export function bootError(title, detail) {
  show('boot-spinner', false);
  setText('boot-title', title);
  setText('boot-detail', detail);
  show('boot-detail', true);
}

/* --- 02 · TOASTS ---------------------------------------------------------- */
export function showToast({ title, body, kind = 'info', ttl = 4500 }) {
  const host = $('toasts');
  if (!host) return;
  const node = h('div', { class: `toast toast--${kind}`, role: kind === 'danger' ? 'alert' : 'status' },
    h('strong', null, title), body ? h('span', null, body) : null);
  host.appendChild(node);
  while (host.children.length > 4) host.firstChild.remove();
  setTimeout(() => node.classList.add('is-leaving'), ttl);
  setTimeout(() => node.remove(), ttl + 400);
}

/* --- 03 · RICH TEXT (formulae) -------------------------------------------- */
/** Plain text with $…$ inline math. Text segments are text nodes; math goes through katex.render. */
export function renderRich(node, text) {
  node.replaceChildren();
  const parts = String(text || '').split(/(\$[^$\n]+\$)/g);
  for (const part of parts) {
    if (!part) continue;
    if (part.length > 2 && part.startsWith('$') && part.endsWith('$') && window.katex) {
      const span = h('span', { class: 'math' });
      try {
        window.katex.render(part.slice(1, -1), span, { throwOnError: false, trust: false, strict: 'ignore', output: 'html' });
      } catch (_) {
        span.textContent = part;
      }
      node.appendChild(span);
    } else {
      node.appendChild(document.createTextNode(part));
    }
  }
}

/* --- 04 · STAGE 1 · SIGN-IN ----------------------------------------------- */
export function fieldState(inputId, hintId, ok, message) {
  const input = $(inputId);
  if (input) {
    input.classList.toggle('is-invalid', ok === false);
    input.classList.toggle('is-valid', ok === true);
    input.setAttribute('aria-invalid', ok === false ? 'true' : 'false');
  }
  const hint = $(hintId);
  if (hint) {
    if (message != null) hint.textContent = message;
    hint.classList.toggle('is-bad', ok === false);
  }
}

export function signinError(message) {
  setText('signin-error', message || '');
  show('signin-error', !!message);
}

export function setBusy(buttonId, busy, label) {
  const b = $(buttonId);
  if (!b) return;
  if (busy) {
    b.dataset.label = b.dataset.label || b.textContent;
    b.textContent = label || 'Working…';
  } else if (b.dataset.label) {
    b.textContent = b.dataset.label;
    delete b.dataset.label;
  }
  b.disabled = !!busy;
  b.setAttribute('aria-busy', busy ? 'true' : 'false');
}

export function paintNet(online) {
  const n = $('net-status');
  if (!n) return;
  n.textContent = online ? 'LINK ONLINE' : 'LINK OFFLINE';
  n.classList.toggle('is-bad', !online);
}

/* --- 05 · STAGE 2 · CALIBRATION ------------------------------------------ */
/** state: pending | busy | pass | fail */
export function paintCheck(id, state, detail) {
  const li = document.querySelector(`#checklist [data-check="${id}"]`);
  if (!li) return;
  li.dataset.state = state;
  if (detail != null) setText(`chk-${id}-detail`, detail);
}

export function paintCalibration(r, baselineTaken) {
  const s = cfg().proctoring;
  paintCheck('camera', r.camera ? 'pass' : 'fail', r.camera ? 'Live' : 'No video');
  const lightNote = r.lightOk ? '' : r.light.luma < s.lumaMin ? ' — too dark' : r.light.luma > s.lumaMax ? ' — too bright' : ' — flat image';
  paintCheck('light', r.lightOk ? 'pass' : 'fail', `Luma ${Math.round(r.light.luma)} · contrast ${Math.round(r.light.contrast)}${lightNote}`);
  if (r.model && !r.degraded) paintCheck('model', 'pass', 'Face Landmarker ready');

  const good = r.model && r.oneFace && r.centred;
  const readout = !r.model ? 'MODEL LOADING'
    : r.faces === 0 ? 'NO FACE'
    : r.faces > 1 ? `${r.faces} FACES`
    : r.centred ? 'FACE LOCKED' : 'CENTRE YOUR FACE';
  const oval = $('reticle');
  if (oval) oval.dataset.state = good ? 'lock' : r.faces > 1 ? 'bad' : 'seek';
  const tag = $('face-readout');
  if (tag) { tag.textContent = readout; tag.dataset.state = good ? 'lock' : 'seek'; }

  const ready = r.camera && r.lightOk && r.model && good;
  $('btn-baseline').disabled = !ready;
  $('btn-to-protocol').disabled = !(baselineTaken && r.camera && r.model);
}

export function paintBaseline(photo) {
  const img = $('baseline-img');
  if (img) { img.src = photo; img.hidden = false; }
  show('baseline-empty', false);
  setText('btn-baseline', 'Re-capture Baseline Reference Photo');
}

export function calibError(message) {
  setText('calib-error', message || '');
  show('calib-error', !!message);
}

/* --- 06 · STAGE 3 · PROTOCOL ---------------------------------------------- */
export function buildProtocol() {
  const s = cfg();
  const count = s.exam.itemsPerModule > 0 ? s.exam.itemsPerModule * s.modules.length : null;
  setText('paper-summary', `${Math.round(s.exam.durationSeconds / 60)} minutes · ${count ? `${count} questions` : 'full bank'} · ${s.modules.length} modules`);
  setText('protocol-scratch-note', 'Scratch paper is allowed — keep your face visible in frame.');
  document.querySelectorAll('[data-cfg]').forEach((n) => {
    const v = n.dataset.cfg.split('.').reduce((o, k) => (o ? o[k] : undefined), s);
    if (v != null) n.textContent = String(v);
  });

  mount($('scheme-body'), Object.values(s.schemes).map((sc) => h('tr', null,
    h('th', { scope: 'row' }, sc.label),
    h('td', { class: 'num is-ok' }, sign(sc.correct)),
    h('td', { class: `num${sc.incorrect < 0 ? ' is-bad' : ''}` }, sign(sc.incorrect)),
    h('td', { class: 'num' }, '0'),
    h('td', null, sc.multi ? 'All correct options; exact match only' : 'Exactly one option')
  )));

  mount($('module-list'), s.modules.map((m) => h('li', null, h('b', null, `Module ${m.letter}`), ` — ${m.name}`)));
}

/** state: waiting | active | ended | local */
export function paintRelease(state, ackChecked) {
  const text = {
    waiting: 'Awaiting invigilator release — keep this page open; the button unlocks automatically.',
    active: 'Paper released. You may enter the examination workspace.',
    ended: 'The examination window has closed.',
    local: 'Rehearsal mode — no invigilator release required.'
  }[state] || '';
  const led = $('release-led');
  if (led) led.dataset.state = state === 'active' || state === 'local' ? 'pass' : state === 'ended' ? 'fail' : 'busy';
  setText('release-text', text);
  $('btn-enter-exam').disabled = !ackChecked || !(state === 'active' || state === 'local');
}

/* --- 07 · STAGE 4 · WORKSPACE --------------------------------------------- */
export function paintCandidate() {
  setText('rb-uid', S.candidate.schoolUid);
  const teamLabel = S.candidate.memberId ? `${S.candidate.teamId} (${S.candidate.memberId})` : S.candidate.teamId;
  setText('rb-team', teamLabel);
  setText('rb-name', S.candidate.name);
}

export function buildModuleTabs(onSelect) {
  const tabs = $('module-tabs');
  if (!tabs) return;
  const s = cfg();
  if (s.modules.length <= 1 || (s.modules.length === 2 && s.modules[1].isBonus)) {
    tabs.hidden = true;
    return;
  }
  tabs.hidden = false;
  mount(tabs, moduleProgress().map((p) => h('button', {
    type: 'button', class: 'mtab', role: 'tab', dataset: { cat: p.module.id }, onclick: () => onSelect(p.module.id)
  },
  h('span', { class: 'mtab__letter' }, p.module.letter),
  h('span', { class: 'mtab__name' }, p.module.short),
  h('span', { class: 'mtab__count', id: `mtab-count-${p.module.id}` }))));
}

function paintModuleTabs() {
  const cur = S.paper[S.idx];
  moduleProgress().forEach((p) => {
    const n = $(`mtab-count-${p.module.id}`);
    if (!n) return;
    n.textContent = `${p.answered}/${p.total} Answered`;
    n.dataset.full = p.answered === p.total ? 'true' : 'false';
  });
  document.querySelectorAll('#module-tabs .mtab').forEach((b) => {
    const active = !!cur && Number(b.dataset.cat) === cur.catId;
    b.classList.toggle('is-active', active);
    b.setAttribute('aria-selected', active ? 'true' : 'false');
  });
}

export function renderQuestion(onPick) {
  const q = S.paper[S.idx];
  if (!q) return;
  const a = S.answers[S.idx];
  const s = cfg();
  const sc = s.schemes[q.scheme] || s.schemes.standard;
  const mod = s.modules.find((m) => m.id === q.catId);
  const isBonus = q.isBonus || q.segment === 'bonus';
  const mainTotal = S.paper.filter((item) => !item.isBonus && item.segment !== 'bonus').length || Math.min(40, S.paper.length);
  const totalDisplay = S.bonusUnlocked ? S.paper.length : mainTotal;

  setText('q-num', isBonus ? `Q${pad(q.n)} [BONUS]` : `Q${pad(q.n)}`);
  setText('q-of', `of ${totalDisplay}`);
  setText('q-module', isBonus ? '⚡ Bonus Question' : (s.modules.length > 2 && mod ? `Module ${mod.letter} · ${mod.name}` : ''));
  setText('q-scheme', isBonus ? '⚡ Bonus' : sc.label);
  setText('q-value', `${sign(sc.correct)} / ${sign(sc.incorrect)}`);
  renderRich($('q-stem'), q.question);
  const supp = $('q-supp');
  renderRich(supp, q.supplement);
  supp.hidden = !q.supplement;
  setText('q-hint', sc.note);

  const opts = $('q-opts');
  opts.setAttribute('role', sc.multi ? 'group' : 'radiogroup');
  mount(opts, q.options.map((text, i) => {
    const picked = a.sel.includes(i);
    const label = h('span', { class: 'opt__text' });
    renderRich(label, text);
    return h('button', {
      type: 'button',
      class: `opt${picked ? ' is-picked' : ''}${sc.multi ? ' opt--multi' : ''}`,
      role: sc.multi ? 'checkbox' : 'radio',
      'aria-checked': picked ? 'true' : 'false',
      onclick: () => onPick(i)
    }, h('span', { class: 'opt__key' }, LETTER(i)), label, h('span', { class: 'opt__tick', 'aria-hidden': 'true' }));
  }));

  const markBtn = $('btn-mark');
  markBtn.classList.toggle('is-on', a.marked);
  markBtn.setAttribute('aria-pressed', a.marked ? 'true' : 'false');
  setText('btn-mark-label', a.marked ? 'Unmark Review' : 'Mark for Review');
  $('btn-prev').disabled = S.idx === 0;
  $('btn-next').disabled = S.idx >= totalDisplay - 1;
  $('btn-clear').disabled = !isAnswered(a);
  paintAnswers();
}

let paletteNav = null;
export function setPaletteNav(fn) { paletteNav = fn; }

function buildPalette() {
  const s = cfg();
  const isSingleCategory = s.modules.length <= 1 || (s.modules.length === 2 && s.modules[1].isBonus);
  const mainQuestions = S.paper.filter((q) => !q.isBonus && q.segment !== 'bonus');
  const bonusQuestions = S.paper.filter((q) => q.isBonus || q.segment === 'bonus');

  const groups = [];
  if (isSingleCategory) {
    const mainIdxs = mainQuestions.map((q) => S.paper.indexOf(q));
    groups.push(h('div', { class: 'pgroup' },
      h('div', { class: 'pgroup__cells' }, mainIdxs.map((i) => h('button', {
        type: 'button', id: `pc-${i}`, class: 'pcell', onclick: () => paletteNav && paletteNav(i)
      }, pad(S.paper[i].n))))));

    if (S.bonusUnlocked && bonusQuestions.length) {
      const bonusIdxs = bonusQuestions.map((q) => S.paper.indexOf(q));
      groups.push(h('div', { class: 'pgroup pgroup--bonus' },
        h('div', { class: 'pgroup__label pgroup__label--bonus', style: 'color: var(--accent, #38bdf8); font-weight: 600;' }, '⚡ Bonus Questions'),
        h('div', { class: 'pgroup__cells' }, bonusIdxs.map((i) => h('button', {
          type: 'button', id: `pc-${i}`, class: 'pcell pcell--bonus', onclick: () => paletteNav && paletteNav(i)
        }, pad(S.paper[i].n))))));
    }
  } else {
    s.modules.forEach((m) => {
      if (m.isBonus && !S.bonusUnlocked) return;
      const idxs = S.paper.map((q, i) => (q.catId === m.id ? i : -1)).filter((i) => i > -1);
      if (!idxs.length) return;
      groups.push(h('div', { class: `pgroup${m.isBonus ? ' pgroup--bonus' : ''}` },
        h('div', { class: 'pgroup__label' }, m.isBonus ? '⚡ Bonus Questions' : `Module ${m.letter} · ${m.short}`),
        h('div', { class: 'pgroup__cells' }, idxs.map((i) => h('button', {
          type: 'button', id: `pc-${i}`, class: `pcell${m.isBonus ? ' pcell--bonus' : ''}`, onclick: () => paletteNav && paletteNav(i)
        }, pad(S.paper[i].n))))));
    });
  }
  mount($('palette-grid'), groups);
}

/** Palette, counters and module tabs — cheap enough to repaint on every response. */
export function paintAnswers() {
  const grid = $('palette-grid');
  const needsRebuild = !grid || grid.childElementCount === 0 || (S.bonusUnlocked && !document.querySelector('.pgroup--bonus') && S.paper.some((q) => q.isBonus || q.segment === 'bonus'));
  if (needsRebuild) buildPalette();
  const activeLen = S.bonusUnlocked ? S.paper.length : S.paper.filter((item) => !item.isBonus && item.segment !== 'bonus').length || Math.min(40, S.paper.length);
  for (let i = 0; i < activeLen; i++) {
    const q = S.paper[i];
    const cell = $(`pc-${i}`);
    if (!cell) continue;
    const st = cellState(i);
    const isBonus = q && (q.isBonus || q.segment === 'bonus');
    cell.className = `pcell pcell--${st}${i === S.idx ? ' is-current' : ''}${isBonus ? ' pcell--bonus' : ''}`;
    cell.setAttribute('aria-label', `Question ${q.n}: ${st.replace('-', ' and ')}`);
    if (i === S.idx) cell.setAttribute('aria-current', 'true');
    else cell.removeAttribute('aria-current');
  }
  setText('sum-answered', answeredCount());
  setText('sum-unanswered', unansweredCount());
  setText('sum-marked', markedCount());
  paintModuleTabs();
}

export function paintClock(remaining, source) {
  const s = cfg().exam;
  setText('rb-clock-val', remaining == null ? '--:--' : mmss(remaining));
  if (source) setText('rb-clock-src', source);
  const node = $('rb-clock');
  if (node && remaining != null) {
    node.dataset.level = remaining <= s.criticalAtSeconds ? 'crit' : remaining <= s.warnAtSeconds ? 'warn' : 'ok';
  }
  const dwell = $('q-dwell');
  if (dwell && S.enteredAt && S.answers[S.idx]) {
    dwell.textContent = mmss((S.answers[S.idx].timeMs + performance.now() - S.enteredAt) / 1000);
  }
}

export function paintProctor(status) {
  const pill = $('rb-proctor');
  if (!pill) return;
  pill.dataset.state = status;
  setText('rb-proctor-label', { secure: 'Secure', warning: 'Warning', flagged: 'Flagged' }[status] || status);
}

export function paintFullscreen(on) {
  const pill = $('rb-fs');
  if (!pill) return;
  pill.dataset.state = on ? 'secure' : 'flagged';
  setText('rb-fs-label', on ? 'Fullscreen' : 'Windowed');
}

export function paintStrikes() {
  const max = cfg().security.maxStrikes;
  const host = $('rb-strikes');
  if (!host) return;
  if (host.childElementCount !== max) {
    mount(host, Array.from({ length: max }, () => h('i', { class: 'strike' })));
  }
  Array.from(host.children).forEach((pip, i) => pip.classList.toggle('is-on', i < S.strikes));
  host.setAttribute('aria-label', `Strikes: ${S.strikes} of ${max}`);
  host.title = `Strikes ${S.strikes} / ${max}`;
}

export function setShield(on) {
  document.body.classList.toggle('is-shielded', !!on);
}

export function showFsLock(seconds) {
  show('modal-fslock', true);
  setText('fs-count', seconds);
  setText('fs-strikes', `${S.strikes} / ${cfg().security.maxStrikes}`);
  const ring = $('fs-ring');
  if (ring) ring.style.setProperty('--p', String(seconds / cfg().security.fullscreenGraceSeconds));
}

export const hideFsLock = () => show('modal-fslock', false);

export function openReview(onJump, onBonusUnlock, canUnlockBonus, remainingTimeText) {
  setText('rv-answered', answeredCount());
  setText('rv-unanswered', unansweredCount());
  setText('rv-marked', markedCount());

  const isOnlySingleCategory = cfg().modules.length <= 1 || (cfg().modules.length === 2 && cfg().modules[1].isBonus);
  const rvModules = $('rv-modules');
  if (rvModules) {
    rvModules.hidden = isOnlySingleCategory;
    if (!isOnlySingleCategory) {
      mount(rvModules, moduleProgress().map((p) => h('li', null,
        h('span', null, `Module ${p.module.letter} · ${p.module.short}`),
        h('span', { class: 'meter' }, h('i', { style: { transform: `scaleX(${p.total ? p.answered / p.total : 0})` } })),
        h('b', null, `${p.answered}/${p.total}`))));
    }
  }

  const activeLen = S.bonusUnlocked ? S.paper.length : S.paper.filter((item) => !item.isBonus && item.segment !== 'bonus').length || S.paper.length;
  const list = (pred) => S.paper.slice(0, activeLen).map((q, i) => (pred(i) ? i : -1)).filter((i) => i > -1);
  const chips = (idxs, cls) => (idxs.length
    ? idxs.map((i) => h('button', { type: 'button', class: `chip ${cls}`, onclick: () => onJump(i) }, `Q${pad(S.paper[i].n)}`))
    : [h('span', { class: 'muted' }, 'None')]);
  mount($('rv-unanswered-list'), chips(list((i) => !isAnswered(S.answers[i])), 'chip--slate'));
  mount($('rv-marked-list'), chips(list((i) => S.answers[i].marked), 'chip--amber'));

  const bonusCard = $('rv-bonus-card');
  if (bonusCard) {
    if (canUnlockBonus) {
      bonusCard.hidden = false;
      setText('rv-bonus-time', remainingTimeText || 'before time');
      const unlockBtn = $('btn-unlock-bonus');
      if (unlockBtn && onBonusUnlock) {
        unlockBtn.onclick = onBonusUnlock;
      }
    } else {
      bonusCard.hidden = true;
    }
  }

  $('rv-confirm').checked = false;
  $('btn-submit-final').disabled = true;
  show('modal-review', true);
  $('btn-review-return').focus();
}

export const closeReview = () => show('modal-review', false);

export function showLockout(message) {
  setText('lockout-text', message);
  show('modal-lockout', true);
}

export const hideLockout = () => show('modal-lockout', false);

/* --- 08 · STAGE 5 · RECEIPT ----------------------------------------------- */
const REASONS = {
  CANDIDATE_SUBMIT: 'Submitted by the candidate.',
  TIME_EXPIRY: 'Submitted automatically when the examination time expired.',
  EXAM_ENDED: 'Submitted automatically when the invigilator closed the examination window.',
  CLOCK_ANOMALY: 'Submitted automatically after a clock or freeze anomaly was detected.'
};

export function renderSealed(pkg, dispatch) {
  const sub = pkg.submission;
  const reason = sub.reason.startsWith('MAX_STRIKES')
    ? 'Submitted automatically after the maximum number of proctoring strikes.'
    : REASONS[sub.reason] || sub.reason;
  setText('seal-reason', reason);
  setText('rc-uid', sub.candidate.schoolUid);
  setText('rc-name', sub.candidate.name);
  setText('rc-team', `${sub.candidate.teamId} · ${sub.candidate.division}`);
  setText('rc-answered', `${sub.answered} / ${sub.total}`);
  setText('rc-skipped', String(sub.unanswered));
  setText('rc-marked', String(sub.marked));
  setText('rc-elapsed', mmss(sub.elapsedSec));
  setText('rc-sealed', istStamp(sub.sealedAt));
  setText('rc-session', sub.sessionId);
  setText('rc-checksum', pkg.checksum);
  paintDispatch(dispatch);
  buildPrintReceipt(pkg);
}

export function paintDispatch(d) {
  const label = {
    sending: 'Transmitting…',
    recorded: 'Recorded in examination database',
    queued: 'Queued — retrying automatically (keep this tab open)',
    'offline-mode': 'Rehearsal mode — not transmitted',
    dispatched: 'Dispatched to mirror',
    failed: 'Mirror unavailable — database record is authoritative',
    disabled: 'Not configured'
  };
  const fbNode = $('dp-firebase');
  const jfNode = $('dp-jotform');
  if (fbNode) {
    fbNode.textContent = label[d.firebase] || d.firebase;
    fbNode.dataset.state = d.firebase === 'recorded' ? 'pass' : d.firebase === 'queued' || d.firebase === 'sending' ? 'busy' : 'fail';
  }
  if (jfNode) {
    jfNode.textContent = label[d.jotform] || d.jotform;
    jfNode.dataset.state = d.jotform === 'dispatched' ? 'pass' : d.jotform === 'sending' ? 'busy' : d.jotform === 'disabled' ? 'idle' : d.firebase === 'recorded' ? 'idle' : 'fail';
  }
}

export function paintSubmitting(step, detail) {
  if (step === 2) {
    const s2 = $('sub-step-2');
    if (s2) {
      s2.classList.add('is-complete');
      s2.classList.remove('is-active');
      const b = s2.querySelector('.submitting-step__badge');
      if (b) { b.className = 'submitting-step__badge'; b.textContent = '✓'; }
    }
    const s3 = $('sub-step-3');
    if (s3) {
      s3.classList.add('is-active');
      const b = s3.querySelector('.submitting-step__badge');
      if (b) { b.className = 'submitting-step__badge submitting-step__badge--spin'; b.textContent = ''; }
      if (detail) setText('sub-step-3-text', detail);
    }
  }
}

function buildPrintReceipt(pkg) {
  const sub = pkg.submission;
  const s = cfg();
  setText('pr-event', `${s.meta.event} · ${s.meta.edition} · ${s.meta.round}`);
  setText('pr-uid', sub.candidate.schoolUid);
  setText('pr-name', sub.candidate.name);
  setText('pr-team', sub.candidate.teamId);
  setText('pr-division', sub.candidate.division);
  setText('pr-session', sub.sessionId);
  setText('pr-paper', sub.paperId);
  setText('pr-stamp', istStamp(sub.sealedAt));
  setText('pr-summary', `Answered ${sub.answered} of ${sub.total} · Unanswered ${sub.unanswered} · Marked for review ${sub.marked} · Time elapsed ${mmss(sub.elapsedSec)}`);
  setText('pr-checksum', pkg.checksum);
  setText('pr-salt', sub.salt);
  mount($('pr-rows'), sub.items.map((it) => {
    const m = s.modules.find((x) => x.id === it.catId);
    return h('tr', null,
      h('td', { class: 'num' }, pad(it.n)),
      h('td', null, m ? m.letter : ''),
      h('td', null, it.id),
      h('td', null, it.displayed.length ? it.displayed.join(', ') : '—'),
      h('td', null, it.marked ? 'Yes' : ''),
      h('td', { class: 'num' }, mmss(it.seconds)));
  }));
  const wm = $('pr-watermark');
  if (wm && !wm.childElementCount) {
    const line = 'OFFICIAL CELESTECON 2026 SUBMISSION RECORD - AEROSS DPS RK PURAM';
    mount(wm, Array.from({ length: 16 }, () => h('span', null, line)));
  }
}
