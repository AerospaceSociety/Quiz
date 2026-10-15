/* ==========================================================================
   QUIZZITCH — engine.js
   Question-bank validation, deterministic paper assembly, response capture,
   module switching, review marking and exam keyboard navigation.

   The paper is shuffled with a PRNG seeded from the candidate's session, so a
   reload rebuilds exactly the same paper and option order — which is what
   lets a crashed session resume without re-randomising.
   ========================================================================== */

import { S, cfg, bus, EV, Stage, Level, recordIncident, persist, isAnswered } from './session.js';
import { seedFrom, mulberry32, shuffle, deepFreeze } from './util.js';

const live = () => S.stage === Stage.EXAM && !S.locked;

/* --- 01 · BANK VALIDATION ------------------------------------------------- */
/**
 * Keeps every well-formed item and reports the rest, so one typo in the bank
 * removes one question instead of blocking the whole paper.
 */
export function validateBank(list) {
  const s = cfg();
  const moduleIds = new Set(s.modules.map((m) => m.id));
  const problems = [];
  const questions = [];

  (Array.isArray(list) ? list : []).forEach((q, i) => {
    const at = `item ${i + 1} (id ${q && q.id})`;
    if (!q || typeof q !== 'object') { problems.push(`${at}: not an object`); return; }
    const catId = Number(q.catId);
    if (q.id == null || String(q.id).trim() === '') problems.push(`${at}: missing id`);
    else if (!moduleIds.has(catId)) problems.push(`${at}: unknown catId ${q.catId}`);
    else if (!s.schemes[q.scheme || 'standard']) problems.push(`${at}: unknown scheme ${q.scheme}`);
    else if (typeof q.question !== 'string' || !q.question.trim()) problems.push(`${at}: empty question`);
    else if (!Array.isArray(q.options) || q.options.length < 2 || q.options.some((o) => typeof o !== 'string')) {
      problems.push(`${at}: needs two or more string options`);
    } else {
      questions.push({
        id: String(q.id),
        catId,
        scheme: q.scheme || 'standard',
        question: q.question,
        supplement: typeof q.supplement === 'string' ? q.supplement : '',
        options: q.options.slice(),
        divisions: Array.isArray(q.divisions) ? q.divisions : null
      });
    }
  });
  return { questions, problems };
}

/* --- 02 · PAPER ASSEMBLY -------------------------------------------------- */
export function buildPaper(bank, seedKey, division) {
  const s = cfg();
  const rng = mulberry32(seedFrom(seedKey));
  const pool = bank
    .filter((q) => !q.divisions || q.divisions.includes(division))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const paper = [];
  s.modules.forEach((m) => {
    let inModule = pool.filter((q) => q.catId === m.id);
    if (s.exam.shuffleQuestions) inModule = shuffle(inModule, rng);
    const count = m.isBonus ? (s.exam.bonusItems || 5) : (s.exam.itemsPerModule || 40);
    if (count > 0) inModule = inModule.slice(0, count);
    inModule.forEach((q) => {
      let order = q.options.map((_, i) => i);
      if (s.exam.shuffleOptions) order = shuffle(order, rng);
      paper.push({
        n: paper.length + 1,
        id: q.id,
        catId: q.catId,
        scheme: q.scheme,
        isBonus: Boolean(m.isBonus || q.isBonus),
        segment: m.isBonus ? 'bonus' : 'main',
        question: q.question,
        supplement: q.supplement,
        options: order.map((i) => q.options[i]),
        order                                   // displayed index → original index
      });
    });
  });

  S.paper = deepFreeze(paper);
  S.answers = paper.map(() => ({ sel: [], marked: false, visits: 0, timeMs: 0 }));
  S.idx = 0;
  return S.paper;
}

export function installPaper(paper) {
  if (!Array.isArray(paper) || !paper.length || paper.length > 200) throw new Error('The server returned an invalid paper.');
  const ids = new Set();
  for (let index = 0; index < paper.length; index++) {
    const question = paper[index];
    if (!question || typeof question.id !== 'string' || ids.has(question.id) || question.n !== index + 1
      || !Array.isArray(question.options) || question.options.length < 2
      || (question.order != null && (!Array.isArray(question.order) || question.order.length !== question.options.length
        || new Set(question.order).size !== question.options.length
        || question.order.some((optionIndex) => !Number.isSafeInteger(optionIndex) || optionIndex < 0 || optionIndex >= question.options.length)))) {
      throw new Error('The server returned an invalid paper.');
    }
    ids.add(question.id);
  }
  S.paper = deepFreeze(paper.map((question) => ({
    ...question,
    options: question.options.slice(),
    ...(Array.isArray(question.order) ? { order: question.order.slice() } : {})
  })));
  S.answers = S.paper.map(() => ({ sel: [], marked: false, visits: 0, timeMs: 0 }));
  S.idx = 0;
  return S.paper;
}

/** Re-applies a crash-recovery snapshot onto a freshly rebuilt paper. */
export function restoreAnswers(saved, idx) {
  if (!Array.isArray(saved) || saved.length !== S.paper.length) return false;
  S.answers = saved.map((a, i) => ({
    sel: Array.isArray(a.sel) ? a.sel.filter((x) => Number.isInteger(x) && x >= 0 && x < S.paper[i].options.length) : [],
    marked: !!a.marked,
    visits: Number(a.visits) || 0,
    timeMs: Number(a.timeMs) || 0
  }));
  S.idx = Number.isInteger(idx) && idx >= 0 && idx < S.paper.length ? idx : 0;
  return true;
}

/* --- 03 · NAVIGATION ------------------------------------------------------ */
export function commitDwell() {
  const a = S.answers[S.idx];
  if (!a || !S.enteredAt) return;
  const t = performance.now();
  a.timeMs += Math.round(t - S.enteredAt);
  S.enteredAt = t;
}

export function mainCount() {
  const nonBonus = S.paper.filter((q) => !q.isBonus && q.segment !== 'bonus');
  return nonBonus.length || Math.min(40, S.paper.length);
}

export const hasBonus = () => S.paper.some((q) => q.isBonus || q.segment === 'bonus');
export const activePaperLength = () => (S.bonusUnlocked ? S.paper.length : mainCount());

export function unlockBonus() {
  if (S.bonusUnlocked) return;
  S.bonusUnlocked = true;
  const firstBonusIdx = mainCount();
  recordIncident({
    type: 'BONUS_UNLOCKED',
    level: Level.INFO,
    message: `Bonus segment unlocked (${Math.max(0, S.paper.length - firstBonusIdx)} questions)`
  });
  persist();
  bus.emit(EV.ANSWERS);
  go(firstBonusIdx);
}

export function go(i) {
  const maxIdx = activePaperLength() - 1;
  if (!live() || i < 0 || i > maxIdx) return;
  commitDwell();
  S.idx = i;
  S.answers[i].visits += 1;
  S.enteredAt = performance.now();
  bus.emit(EV.QUESTION, i);
  persist();
}

export const next = () => go(Math.min(S.idx + 1, activePaperLength() - 1));
export const prev = () => go(Math.max(S.idx - 1, 0));

export function goModule(catId) {
  const i = S.paper.findIndex((q) => q.catId === catId);
  if (i > -1 && i < activePaperLength()) go(i);
}

/* --- 04 · RESPONSES ------------------------------------------------------- */
function changed(kind) {
  const q = S.paper[S.idx];
  const a = S.answers[S.idx];
  recordIncident({
    type: kind,
    level: Level.INFO,
    message: `Q${q.n} ${kind === 'MARK' ? (a.marked ? 'marked for review' : 'review mark removed') : `response → ${a.sel.map((i) => String.fromCharCode(65 + i)).join(',') || 'cleared'}`}`,
    data: { q: q.n, id: q.id, sel: a.sel.slice(), marked: a.marked }
  });
  bus.emit(EV.ANSWERS, S.idx);
  persist();
}

export function pick(optIdx) {
  if (!live()) return;
  const q = S.paper[S.idx];
  const a = S.answers[S.idx];
  if (!q || optIdx < 0 || optIdx >= q.options.length) return;
  if (cfg().schemes[q.scheme].multi) {
    const at = a.sel.indexOf(optIdx);
    if (at > -1) a.sel.splice(at, 1); else a.sel.push(optIdx);
    a.sel.sort((x, y) => x - y);
  } else {
    if (a.sel.length === 1 && a.sel[0] === optIdx) return;
    a.sel = [optIdx];
  }
  changed('ANSWER');
}

export function clearSelection() {
  if (!live()) return;
  const a = S.answers[S.idx];
  if (!a || !a.sel.length) return;
  a.sel = [];
  changed('ANSWER');
}

export function toggleMark() {
  if (!live()) return;
  const a = S.answers[S.idx];
  if (!a) return;
  a.marked = !a.marked;
  changed('MARK');
}

/* --- 05 · DERIVED VIEWS --------------------------------------------------- */
/** 'answered' | 'answered-marked' | 'marked' | 'unanswered' */
export function cellState(i) {
  const a = S.answers[i];
  if (!a) return 'unanswered';
  const ans = isAnswered(a);
  if (ans && a.marked) return 'answered-marked';
  if (ans) return 'answered';
  if (a.marked) return 'marked';
  return 'unanswered';
}

export function moduleProgress() {
  return cfg().modules.map((m) => {
    const idxs = S.paper.map((q, i) => (q.catId === m.id ? i : -1)).filter((i) => i > -1);
    return { module: m, total: idxs.length, answered: idxs.filter((i) => isAnswered(S.answers[i])).length };
  }).filter((p) => p.total > 0);
}

/** Response ledger in submission form: displayed choices only. */
export function responseItems() {
  return S.paper.map((q, i) => {
    const a = S.answers[i];
    return {
      n: q.n,
      id: q.id,
      catId: q.catId,
      scheme: q.scheme,
      displayed: a.sel.map((x) => String.fromCharCode(65 + x)),
      selected: a.sel.slice(),
      text: a.sel.map((x) => q.options[x]),
      marked: a.marked,
      visits: a.visits,
      seconds: Math.round(a.timeMs / 1000)
    };
  });
}

/* --- 06 · KEYBOARD -------------------------------------------------------- */
/**
 * Exam shortcuts. Called by sandbox.js only after its lockdown filter has run.
 * 1–4 / A–D pick · M mark · ← → navigate · Backspace/Delete clear.
 * (C is option C — clearing is deliberately not bound to a letter.)
 * @returns {boolean} true when the key was consumed
 */
export function handleExamKey(e) {
  if (!live() || e.ctrlKey || e.altKey || e.metaKey) return false;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const q = S.paper[S.idx];
  if (!q) return false;

  if (/^[1-9]$/.test(k) && Number(k) <= q.options.length) { pick(Number(k) - 1); return true; }
  if (/^[a-h]$/.test(k) && k.charCodeAt(0) - 97 < q.options.length) { pick(k.charCodeAt(0) - 97); return true; }
  if (k === 'm') { toggleMark(); return true; }
  if (k === 'ArrowRight') { next(); return true; }
  if (k === 'ArrowLeft') { prev(); return true; }
  if (k === 'Backspace' || k === 'Delete') { clearSelection(); return true; }
  return false;
}
