import { authenticate, allowedOrigin, commitWrites, getDocument, listDocuments, json, jsonDepthWithin, readLimitedBody, sha256Hex, HttpError } from '../_lib/firebase-admin.js';
import { enforceActionRateLimit, enforceIpRateLimit, enforceUserRateLimit } from '../_lib/rate-limit.js';

function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`;
}

function normal(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

function hasOnlyKeys(value, allowed) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.has(key));
}

function requireIdentityKey(value) {
  const key = String(value || '');
  if (!/^[a-f0-9]{40}$/.test(key)) throw new HttpError(400, 'Invalid candidate identity key');
  return key;
}

function validText(value, max) {
  return typeof value === 'string' && value.length <= max && !/data:image\//i.test(value);
}

function validJpegDataUrl(value, maxBytes) {
  const match = typeof value === 'string' && /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[1].length % 4 !== 0) return false;
  try {
    const binary = atob(match[1]);
    return binary.length >= 4 && binary.length <= maxBytes
      && binary.charCodeAt(0) === 0xff && binary.charCodeAt(1) === 0xd8 && binary.charCodeAt(2) === 0xff
      && binary.charCodeAt(binary.length - 2) === 0xff && binary.charCodeAt(binary.length - 1) === 0xd9;
  } catch (_) {
    return false;
  }
}

function rosterDivision(profile) {
  const declared = String(profile.division || '').trim().toUpperCase();
  if (/^(THT|THEATRE|AEROSS THEATRE)$/.test(declared)) return 'THT';
  if (/^(IPD|IPOD|DISP|DEBATE|IN-PURSUIT OF DISPUTE)$/.test(declared)) return 'IPD';
  const teamId = String(profile.teamId || '').toUpperCase();
  return /(?:^|-)(THT|THEATRE)(?:-|$)/.test(teamId) ? 'THT' : 'IPD';
}

async function stillsPurgeState(env, startedAt) {
  const path = 'privacy_controls/stills_guard';
  let marker = await getDocument(env, path);
  if (!marker) {
    try {
      await commitWrites(env, [{ path, data: { purgedStartedAt: 0, updatedAt: 0 }, create: true }]);
    } catch (error) {
      if (error.status !== 409) throw error;
    }
    marker = await getDocument(env, path);
  }
  if (!marker) throw new HttpError(503, 'Privacy purge state is unavailable');
  return {
    purged: Number(marker.data.purgedStartedAt) === Number(startedAt),
    guard: { path, data: marker.data, updateTime: marker.updateTime }
  };
}

function cleanSession(data, uid, identityKey, previous = {}) {
  if (!data || typeof data !== 'object') throw new HttpError(400, 'Session state is required');
  const stages = new Set(['signin', 'calibrate', 'protocol', 'exam']);
  const statuses = new Set(['secure', 'warning', 'flagged']);
  if (!stages.has(data.stage) || !statuses.has(data.status)) throw new HttpError(400, 'Invalid session stage or status');
  const stageOrder = ['signin', 'calibrate', 'protocol', 'exam'];
  const stage = previous.stage && stageOrder.indexOf(previous.stage) > stageOrder.indexOf(data.stage) ? previous.stage : data.stage;
  const numeric = (key, fallback = 0, max = 100000) => {
    const value = Number(data[key] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new HttpError(400, `Invalid session field: ${key}`);
    return value;
  };
  const shortString = (key, max) => {
    const value = String(data[key] || '');
    if (value.length > max) throw new HttpError(400, `Invalid session field: ${key}`);
    return value;
  };
  const sessionId = shortString('sessionId', 80);
  if (!sessionId) throw new HttpError(400, 'Session identifier is required');
  if (previous.sessionId && previous.sessionId !== sessionId) throw new HttpError(409, 'The active session identifier cannot be changed');
  return {
    uid,
    identityKey,
    sessionId: previous.sessionId || sessionId,
    schoolUid: shortString('schoolUid', 80),
    teamId: shortString('teamId', 80),
    name: shortString('name', 200),
    attemptedBy: shortString('attemptedBy', 120) || previous.attemptedBy || '',
    division: shortString('division', 24),
    schoolName: shortString('schoolName', 120),
    stage,
    status: data.status,
    strikes: Math.max(Number(previous.strikes) || 0, numeric('strikes', 0, 1000)),
    advisories: Math.max(Number(previous.advisories) || 0, numeric('advisories', 0, 10000)),
    answered: numeric('answered', 0, 500),
    marked: numeric('marked', 0, 500),
    total: numeric('total', 0, 500),
    currentQ: numeric('currentQ', 0, 500),
    fullscreen: data.fullscreen === true,
    paperId: String(previous.paperId || ''),
    paperIssuedAt: Number(previous.paperIssuedAt) || null,
    examStartedAt: Number(previous.examStartedAt) || null,
    lastEvent: shortString('lastEvent', 100),
    consentVersion: shortString('consentVersion', 100),
    consentAt: Number.isFinite(Number(data.consentAt)) ? Number(data.consentAt) : null,
    clientTs: Number.isFinite(Number(data.clientTs)) ? Number(data.clientTs) : null,
    heartbeatAt: Date.now(),
    eventCount: Number(previous.eventCount) || 0
  };
}

async function claim(env, uid, payload) {
  const code = String(payload.claimCode || '').trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(code)) throw new HttpError(400, 'A valid roster access code is required');
  const rosterKey = (await sha256Hex(`quizzitch-roster-claim-v1|${code}`)).slice(0, 40);
  const roster = await getDocument(env, `roster/${rosterKey}`);
  if (!roster) throw new HttpError(403, 'Access code is not on the authorised roster');
  const profile = roster.data;
  const identityKey = String(profile.identityKey || '');
  if (!/^[a-f0-9]{40}$/.test(identityKey)) throw new HttpError(503, 'Roster identity configuration is invalid');
  const expectedIdentityKey = (await sha256Hex(`quizzitch-candidate-identity-v1|${JSON.stringify([
    normal(profile.schoolUid), normal(profile.rawTeamId || profile.teamId), normal(profile.name), String(profile.memberId || '').trim().toUpperCase()
  ])}`)).slice(0, 40);
  if (identityKey !== expectedIdentityKey) throw new HttpError(503, 'Roster identity configuration is invalid');
  const team = String(payload.teamId || '').trim();
  const registeredTeams = [profile.rawTeamId, profile.teamId].filter(Boolean).map(normal);
  if (normal(payload.schoolUid) !== normal(profile.schoolUid) || !registeredTeams.includes(normal(team))) {
    throw new HttpError(403, 'Entered candidate details do not match the roster');
  }

  const attemptedByName = String(payload.name || '').normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (!attemptedByName) {
    throw new HttpError(400, 'Candidate name is required');
  }

  const previousSubmission = await getDocument(env, `submissions/${uid}`);
  if (previousSubmission) throw new HttpError(409, 'This account has already submitted');
  const priorClaim = await getDocument(env, `candidate_claims/${uid}`);
  if (priorClaim && priorClaim.data.identityKey !== identityKey) throw new HttpError(409, 'This account is already bound to a different candidate');
  const existing = await getDocument(env, `identities/${identityKey}`);
  if (existing && existing.data.state === 'sealed') throw new HttpError(409, 'This candidate has already submitted');
  if (existing && existing.data.uid !== uid) throw new HttpError(409, 'This candidate is active on another device');
  const consentVersion = String(env.CONSENT_VERSION || '2026.1-DPDP-DRAFT');
  if (payload.consentAccepted !== true || payload.consentVersion !== consentVersion) {
    throw new HttpError(400, 'The current proctoring consent must be accepted before sign-in');
  }
  const consentAt = existing?.data.consentVersion === consentVersion && Number(existing.data.consentAt)
    ? Number(existing.data.consentAt)
    : Date.now();
  const identity = {
    uid,
    state: 'active',
    schoolUid: profile.schoolUid,
    teamId: profile.teamId,
    rawTeamId: profile.rawTeamId || profile.teamId,
    name: profile.name,
    attemptedBy: attemptedByName,
    claimedBy: attemptedByName,
    memberId: profile.memberId || (/-M\d{1,2}$/i.test(profile.rawTeamId || '') ? profile.rawTeamId : ''),
    division: rosterDivision(profile),
    isIndividual: String(profile.schoolUid || '').includes('-IND-'),
    consentVersion,
    consentAt,
    updatedAt: Date.now(),
    ...(existing ? {} : { createdAt: Date.now() })
  };
  try {
    const writes = [existing
      ? { path: `identities/${identityKey}`, data: identity, updateTime: existing.updateTime }
      : { path: `identities/${identityKey}`, data: identity, create: true }];
    const userClaim = { uid, identityKey, updatedAt: Date.now() };
    writes.push(priorClaim
      ? { path: `candidate_claims/${uid}`, data: userClaim, updateTime: priorClaim.updateTime }
      : { path: `candidate_claims/${uid}`, data: userClaim, create: true });
    await commitWrites(env, writes);
  } catch (error) {
    if (error.status === 409) throw new HttpError(409, 'This candidate was claimed on another device at the same time');
    throw error;
  }
  return { identityKey, profile: identity };
}

async function session(env, uid, payload) {
  const identityKey = requireIdentityKey(payload.identityKey);
  const identity = await getDocument(env, `identities/${identityKey}`);
  if (!identity || identity.data.uid !== uid || identity.data.state !== 'active') throw new HttpError(403, 'Active candidate identity required');
  const previous = await getDocument(env, `sessions/${uid}`);
  if (previous && previous.data.status === 'submitted') throw new HttpError(409, 'Submitted sessions are immutable');
  if (previous && previous.data.identityKey !== identityKey) throw new HttpError(409, 'This account is already attached to another candidate session');
  const data = cleanSession(payload.data, uid, identityKey, previous && previous.data);
  if (data.stage === 'sealed') throw new HttpError(400, 'Only the seal endpoint may submit a session');
  const control = await getDocument(env, 'exam_control/status');
  if (data.stage === 'exam') {
    const examEnd = control?.data.startedAt
      ? control.data.startedAt + (Number(control.data.durationSeconds) + Number(control.data.extensionSeconds || 0)) * 1000
      : 0;
    if (!control || control.data.status !== 'active' || !examEnd || Date.now() > examEnd) {
      throw new HttpError(403, 'The exam is not currently accepting live session updates');
    }
  }
  if (data.schoolUid !== identity.data.schoolUid || ![identity.data.teamId, identity.data.rawTeamId].map(normal).includes(normal(data.teamId)) || (identity.data.division && data.division !== identity.data.division)) {
    throw new HttpError(403, 'Session identity does not match the roster');
  }
  await commitWrites(env, [previous
    ? { path: `sessions/${uid}`, data, updateTime: previous.updateTime }
    : { path: `sessions/${uid}`, data, create: true }]);
  return { saved: true, heartbeatAt: data.heartbeatAt };
}

async function event(env, uid, payload) {
  const identityKey = requireIdentityKey(payload.identityKey);
  const identity = await getDocument(env, `identities/${identityKey}`);
  const sess = await getDocument(env, `sessions/${uid}`);
  if (!identity || identity.data.uid !== uid || identity.data.state !== 'active' || !sess || sess.data.status === 'submitted') {
    throw new HttpError(403, 'Active candidate session required');
  }
  if (sess.data.identityKey !== identityKey) throw new HttpError(403, 'Event identity does not match the active session');
  const eventId = String(payload.eventId || '').toLowerCase();
  const input = payload.data;
  if (!/^[0-9a-f]{32}$/.test(eventId) || !input || ![0, 1, 2].includes(input.level) || typeof input.message !== 'string' || input.message.length > 500) {
    throw new HttpError(400, 'Invalid event');
  }
  const sessionId = String(input.sessionId || '');
  if (!sessionId || sessionId.length > 80 || sessionId !== sess.data.sessionId) throw new HttpError(403, 'Event session does not match');
  if (input.thumb != null && !validJpegDataUrl(input.thumb, 30 * 1024)) throw new HttpError(400, 'Event thumbnails must be small JPEG data URLs');
  let thumb = null;
  let purgeGuard = null;
  if (typeof input.thumb === 'string' && sess.data.stage === 'exam') {
    const control = await getDocument(env, 'exam_control/status');
    if (control?.data.status === 'active' && control.data.startedAt) {
      const purgeState = await stillsPurgeState(env, control.data.startedAt);
      if (!purgeState.purged) {
        thumb = input.thumb;
        purgeGuard = purgeState.guard;
      }
    }
  }
  const eventGroup = (await sha256Hex(sessionId)).slice(0, 12);
  const path = `events/${uid}_${eventGroup}_${eventId}`;
  const existing = await getDocument(env, path);
  if (existing) return { recorded: true, duplicate: true };
  if ((Number(sess.data.eventCount) || 0) >= 80) return { recorded: false, limitReached: true };
  const data = {
    uid, identityKey, sessionId: String(input.sessionId || '').slice(0, 80),
    schoolUid: identity.data.schoolUid, teamId: identity.data.teamId,
    name: identity.data.name, division: identity.data.division || '',
    type: String(input.type || '').slice(0, 100), level: input.level,
    message: input.message, strikes: Math.max(Number(sess.data.strikes) || 0, Math.min(1000, Number(input.strikes) || 0)),
    elapsed: Math.max(0, Math.min(86400, Number(input.elapsed) || 0)),
    clientTs: Number.isFinite(Number(input.clientTs)) ? Number(input.clientTs) : null,
    ...(thumb && thumb.length <= 40000 ? { thumb } : {}),
    ts: Date.now()
  };
  try {
    await commitWrites(env, [
      { path, data, create: true },
      { path: `sessions/${uid}`, data: {
        ...sess.data,
        eventCount: (Number(sess.data.eventCount) || 0) + 1,
        strikes: Math.max(Number(sess.data.strikes) || 0, Number(data.strikes) || 0),
        advisories: Math.max(Number(sess.data.advisories) || 0, Number(data.level === 1) + (Number(sess.data.advisories) || 0)),
        heartbeatAt: Date.now()
      }, updateTime: sess.updateTime },
      ...(purgeGuard ? [purgeGuard] : [])
    ]);
  } catch (error) {
    if (error.status === 409) return { recorded: false, retryable: true };
    throw error;
  }
  return { recorded: true };
}

async function baseline(env, uid, payload) {
  const identityKey = requireIdentityKey(payload.identityKey);
  const identity = await getDocument(env, `identities/${identityKey}`);
  if (!identity || identity.data.uid !== uid || identity.data.state !== 'active') throw new HttpError(403, 'Active candidate identity required');
  const record = payload.data;
  if (!record || typeof record !== 'object' || !validJpegDataUrl(record.baseline?.photo, 340 * 1024)) {
    throw new HttpError(400, 'Invalid or oversized baseline');
  }
  const session = await getDocument(env, `sessions/${uid}`);
  const control = await getDocument(env, 'exam_control/status');
  const end = control?.data.startedAt
    ? control.data.startedAt + (Number(control.data.durationSeconds) + Number(control.data.extensionSeconds || 0)) * 1000
    : 0;
  if (!session || session.data.identityKey !== identityKey || session.data.sessionId !== String(record.sessionId || '')
    || session.data.stage !== 'exam' || !control || control.data.status !== 'active' || Date.now() > end) {
    throw new HttpError(403, 'A live assigned exam session is required to save a baseline');
  }
  const purgeState = await stillsPurgeState(env, control.data.startedAt);
  if (purgeState.purged) return { saved: false, purged: true };
  const previous = await getDocument(env, `forensics/${uid}`);
  if (previous?.data.sessionId === session.data.sessionId && previous.data.identityKey === identityKey && previous.data.baseline?.photo) {
    return { saved: true, duplicate: true };
  }
  const data = {
    uid, identityKey, sessionId: String(record.sessionId || '').slice(0, 80),
    baseline: {
      photo: record.baseline.photo,
      pose: {
        yaw: Number.isFinite(Number(record.baseline.pose?.yaw)) ? Number(record.baseline.pose.yaw) : 0,
        pitch: Number.isFinite(Number(record.baseline.pose?.pitch)) ? Number(record.baseline.pose.pitch) : 0
      },
      noise: Number.isFinite(Number(record.baseline.noise)) ? Number(record.baseline.noise) : 0,
      capturedAt: Date.now()
    },
    thumbs: [],
    ledger: [],
    updatedAt: Date.now()
  };
  await commitWrites(env, [previous
    ? { path: `forensics/${uid}`, data, updateTime: previous.updateTime }
    : { path: `forensics/${uid}`, data, create: true }, purgeState.guard]);
  return { saved: true };
}

async function verifyChecksum(sub) {
  const body = Object.fromEntries(Object.entries(sub).filter(([key]) => key !== 'checksum' && key !== 'checksumAlgo'));
  return (await sha256Hex(`${sub.salt}|${canonicalJSON(body)}`)) === String(sub.checksum || '').toLowerCase();
}

function secureRandomIndex(max) {
  const range = 0x100000000;
  const limit = Math.floor(range / max) * max;
  const sample = new Uint32Array(1);
  do { crypto.getRandomValues(sample); } while (sample[0] >= limit);
  return sample[0] % max;
}

function shuffle(values) {
  const result = values.slice();
  for (let index = result.length - 1; index > 0; index--) {
    const target = secureRandomIndex(index + 1);
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

async function buildExpectedPaper(env, division) {
  const bank = await listDocuments(env, 'quizzitch_questions');
  const modules = String(env.QUIZ_MODULE_IDS || '0,1,2,3').split(',').map((value) => Number(value.trim()));
  if (!modules.length || modules.length > 20 || modules.some((moduleId) => !Number.isSafeInteger(moduleId) || moduleId < 0) || new Set(modules).size !== modules.length) {
    throw new HttpError(503, 'Quiz module configuration is invalid');
  }
  const configuredItems = Number(env.QUIZ_ITEMS_PER_MODULE || 5);
  if (!Number.isSafeInteger(configuredItems) || configuredItems < 1 || configuredItems > 200) {
    throw new HttpError(503, 'Quiz paper-size configuration is invalid');
  }
  if (!bank.length || bank.length > 1000) throw new HttpError(503, 'Question bank size is invalid');
  const moduleSet = new Set(modules);
  const schemes = new Set(['standard', 'highstakes', 'multi']);
  const normalizedBank = bank.map((entry) => {
    const question = entry.data;
    const scheme = question && question.scheme !== undefined ? question.scheme : 'standard';
    if (!question || typeof question !== 'object' || Array.isArray(question)
      || typeof question.id !== 'string' || question.id !== entry.id || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(question.id)
      || !Number.isSafeInteger(question.catId) || !moduleSet.has(question.catId)
      || typeof scheme !== 'string' || !schemes.has(scheme)
      || typeof question.question !== 'string' || !question.question.trim() || question.question.length > 5000 || /data:image\//i.test(question.question)
      || (question.supplement != null && (typeof question.supplement !== 'string' || question.supplement.length > 5000 || /data:image\//i.test(question.supplement)))
      || !Array.isArray(question.options) || question.options.length < 2 || question.options.length > 26
      || question.options.some((option) => typeof option !== 'string' || !option.trim() || option.length > 1000 || /data:image\//i.test(option))
      || (question.divisions != null && (!Array.isArray(question.divisions) || !question.divisions.length
        || question.divisions.some((value) => !['IPD', 'THT'].includes(value))))) {
      throw new HttpError(503, 'Question bank contains an invalid item');
    }
    return question;
  });
  const expected = [];
  for (const moduleId of modules) {
    let pool = normalizedBank
      .filter((question) => question.catId === moduleId && (!question.divisions || question.divisions.includes(division)))
      .sort((left, right) => String(left.id) < String(right.id) ? -1 : String(left.id) > String(right.id) ? 1 : 0);
    if (env.QUIZ_SHUFFLE_QUESTIONS !== 'false') pool = shuffle(pool);
    pool = pool.slice(0, configuredItems);
    for (const question of pool) {
      const options = Array.isArray(question.options) ? question.options : [];
      const order = env.QUIZ_SHUFFLE_OPTIONS === 'false' ? options.map((_, index) => index) : shuffle(options.map((_, index) => index));
      expected.push({ question, order });
    }
  }
  return expected;
}

function validatePaper(submission, manifest) {
  if (submission.paperId !== manifest.paperId || submission.items.length !== manifest.items.length || submission.total !== manifest.items.length) {
    throw new HttpError(422, 'Submission does not match the assigned paper');
  }
  const expected = manifest.items.map((item) => ({
    question: { id: item.id, catId: item.catId, scheme: item.scheme, options: item.originalOptions },
    order: item.order
  }));
  const legacy = submission.v === 2;
  const itemKeys = new Set(['n', 'id', 'catId', 'scheme', 'displayed', ...(legacy ? ['original'] : ['selected']), 'text', 'marked', 'visits', 'seconds']);
  for (let index = 0; index < expected.length; index++) {
    const item = submission.items[index];
    if (!hasOnlyKeys(item, itemKeys)) throw new HttpError(422, 'Answer item contains invalid fields');
    const { question, order } = expected[index];
    const options = question.options || [];
    const displayedOptions = manifest.items[index].options;
    if (typeof item.id !== 'string' || !Number.isSafeInteger(item.n) || !Number.isSafeInteger(item.catId)
      || item.id !== String(question.id) || item.n !== index + 1 || item.catId !== Number(question.catId) || item.scheme !== (question.scheme || 'standard')) {
      throw new HttpError(422, 'Question order or identity is invalid');
    }
    const selections = legacy ? item.original : item.selected;
    if (!Array.isArray(selections) || !Array.isArray(item.displayed) || !Array.isArray(item.text) || selections.length !== item.displayed.length || selections.length !== item.text.length) {
      throw new HttpError(422, 'Answer selection has an invalid shape');
    }
    const picked = new Set();
    for (let selection = 0; selection < selections.length; selection++) {
      const optionIndex = selections[selection];
      const displayIndex = legacy ? order.indexOf(optionIndex) : optionIndex;
      const uniqueIndex = legacy ? optionIndex : displayIndex;
      if (!Number.isSafeInteger(optionIndex) || displayIndex < 0 || displayIndex >= displayedOptions.length || picked.has(uniqueIndex)
        || (legacy && order[displayIndex] !== optionIndex)
        || item.displayed[selection] !== String.fromCharCode(65 + displayIndex) || item.text[selection] !== displayedOptions[displayIndex]) {
        throw new HttpError(422, 'Answer selection does not match the released options');
      }
      picked.add(uniqueIndex);
    }
    if (item.scheme !== 'multi' && selections.length > 1) throw new HttpError(422, 'Single-choice answer has multiple selections');
    if (typeof item.marked !== 'boolean' || !Number.isSafeInteger(item.visits) || item.visits < 0 || item.visits > 100000
      || !Number.isSafeInteger(item.seconds) || item.seconds < 0 || item.seconds > 86400) {
      throw new HttpError(422, 'Answer timing or review marker is invalid');
    }
  }
}

function validateSubmissionSummary(submission, manifest) {
  if (!Number.isSafeInteger(submission.answered) || !Number.isSafeInteger(submission.unanswered)
    || !Number.isSafeInteger(submission.marked) || submission.answered < 0 || submission.marked < 0
    || submission.unanswered < 0 || submission.answered + submission.unanswered !== manifest.items.length
    || submission.marked > manifest.items.length) throw new HttpError(422, 'Submission counts are invalid');
  const answered = submission.items.filter((item) => (submission.v === 2 ? item.original : item.selected).length > 0).length;
  const marked = submission.items.filter((item) => item.marked).length;
  if (submission.answered !== answered || submission.unanswered !== manifest.items.length - answered || submission.marked !== marked) {
    throw new HttpError(422, 'Submission counts do not match its answers');
  }
  const expected = new Map();
  submission.items.forEach((item) => {
    const row = expected.get(item.catId) || { total: 0, answered: 0 };
    row.total++;
    if ((submission.v === 2 ? item.original : item.selected).length) row.answered++;
    expected.set(item.catId, row);
  });
  const seen = new Set();
  for (const module of submission.modules) {
    if (!hasOnlyKeys(module, new Set(['id', 'code', 'answered', 'total'])) || !Number.isSafeInteger(module.id)
      || !validText(module.code, 24) || !/^[A-Za-z0-9_-]*$/.test(module.code)
      || !Number.isSafeInteger(module.answered) || !Number.isSafeInteger(module.total) || seen.has(module.id)) {
      throw new HttpError(422, 'Module summary is invalid');
    }
    const expectedRow = expected.get(module.id);
    if (!expectedRow || module.total !== expectedRow.total || module.answered !== expectedRow.answered) throw new HttpError(422, 'Module counts do not match the assigned paper');
    seen.add(module.id);
  }
  if (seen.size !== expected.size) throw new HttpError(422, 'Module summary is incomplete');
}

function cleanForensics(input, uid, identityKey, sessionId, checksum, receivedAt) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  let baseline = null;
  if (input.baseline && typeof input.baseline === 'object' && !Array.isArray(input.baseline)) {
    const pose = input.baseline.pose && typeof input.baseline.pose === 'object' ? input.baseline.pose : {};
    baseline = {
      ...(validJpegDataUrl(input.baseline.photo, 340 * 1024) ? { photo: input.baseline.photo } : {}),
      pose: {
        yaw: Number.isFinite(Number(pose.yaw)) ? Math.max(-180, Math.min(180, Number(pose.yaw))) : 0,
        pitch: Number.isFinite(Number(pose.pitch)) ? Math.max(-180, Math.min(180, Number(pose.pitch))) : 0
      },
      noise: Number.isFinite(Number(input.baseline.noise)) ? Math.max(0, Math.min(1000, Number(input.baseline.noise))) : 0,
      capturedAt: receivedAt
    };
  }
  const thumbs = Array.isArray(input.thumbs) ? input.thumbs.flatMap((thumb) => {
    if (!thumb || typeof thumb !== 'object' || Array.isArray(thumb) || !validJpegDataUrl(thumb.dataUrl, 30 * 1024)) return [];
    return [{
      seq: Number.isSafeInteger(thumb.seq) ? Math.max(0, Math.min(100000, thumb.seq)) : 0,
      type: validText(thumb.type, 100) ? thumb.type : 'INCIDENT',
      level: [0, 1, 2].includes(thumb.level) ? thumb.level : 0,
      t: Number.isFinite(Number(thumb.t)) ? Math.max(0, Math.min(receivedAt, Number(thumb.t))) : receivedAt,
      dataUrl: thumb.dataUrl
    }];
  }).slice(0, 8) : [];
  const ledger = Array.isArray(input.ledger) ? input.ledger.slice(-600).flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    return [{
      seq: Number.isSafeInteger(entry.seq) ? Math.max(0, Math.min(100000, entry.seq)) : 0,
      t: Number.isFinite(Number(entry.t)) ? Math.max(0, Math.min(receivedAt, Number(entry.t))) : receivedAt,
      elapsed: Number.isFinite(Number(entry.elapsed)) ? Math.max(0, Math.min(86400, Number(entry.elapsed))) : 0,
      type: validText(entry.type, 100) ? entry.type : 'UNKNOWN',
      level: [0, 1, 2].includes(entry.level) ? entry.level : 0,
      message: validText(entry.message, 500) ? entry.message : '',
      ...(Number.isSafeInteger(entry.strike) ? { strike: Math.max(0, Math.min(1000, entry.strike)) } : {})
    }];
  }) : [];
  const device = input.device && typeof input.device === 'object' && !Array.isArray(input.device) ? {
    ua: validText(input.device.ua, 200) ? input.device.ua : '',
    cores: Number.isFinite(Number(input.device.cores)) ? Math.max(0, Math.min(128, Number(input.device.cores))) : 0,
    memoryGb: Number.isFinite(Number(input.device.memoryGb)) ? Math.max(0, Math.min(1024, Number(input.device.memoryGb))) : 0,
    screen: validText(input.device.screen, 40) ? input.device.screen : '',
    extendedDisplay: input.device.extendedDisplay === true
  } : {};
  return { uid, identityKey, sessionId, baseline, thumbs, ledger, ledgerTruncated: input.ledgerTruncated === true, device, checksum, updatedAt: receivedAt };
}

function fitForensics(record) {
  if (!record) return null;
  const size = () => new TextEncoder().encode(JSON.stringify(record)).byteLength;
  while (size() > 500 * 1024 && record.thumbs.length) record.thumbs.pop();
  while (size() > 500 * 1024 && record.ledger.length > 50) record.ledger.shift();
  return size() <= 500 * 1024 ? record : null;
}

async function paper(env, uid) {
  const claim = await getDocument(env, `candidate_claims/${uid}`);
  const identityKey = claim && claim.data.identityKey;
  if (identityKey && !/^[a-f0-9]{40}$/.test(identityKey)) throw new HttpError(503, 'Candidate identity configuration is invalid');
  const identity = identityKey && await getDocument(env, `identities/${identityKey}`);
  const session = await getDocument(env, `sessions/${uid}`);
  const control = await getDocument(env, 'exam_control/status');
  if (!identity || identity.data.uid !== uid || identity.data.state !== 'active'
    || !session || session.data.identityKey !== identityKey || session.data.status === 'submitted'
    || !['protocol', 'exam'].includes(session.data.stage)
    || !control || !['active', 'ended'].includes(control.data.status) || !control.data.startedAt || !control.data.paperId) {
    throw new HttpError(403, 'An active released candidate session is required');
  }
  const end = control.data.startedAt + (Number(control.data.durationSeconds) + Number(control.data.extensionSeconds || 0)) * 1000;
  const now = Date.now();
  const windowOpen = control.data.status === 'active' && now <= end;
  const forceEndGrace = control.data.status === 'ended' && control.data.updatedAt && now <= control.data.updatedAt + 2 * 60 * 1000;
  const path = `candidate_papers/${uid}`;
  const publicItems = (items) => items.map(({ originalOptions, order, ...item }) => item);
  const existing = await getDocument(env, path);
  if (existing) {
    const resumeGrace = control.data.status === 'active' && now <= end + 2 * 60 * 1000;
    if (!windowOpen && !resumeGrace && !forceEndGrace) throw new HttpError(403, 'The examination window has closed');
    if (existing.data.identityKey !== identityKey || existing.data.sessionId !== session.data.sessionId || existing.data.paperId !== control.data.paperId) {
      throw new HttpError(409, 'A different paper is already assigned to this account');
    }
    return { paper: publicItems(existing.data.items), paperId: existing.data.paperId };
  }
  if (!windowOpen) throw new HttpError(403, 'The examination window has closed');
  const questions = await buildExpectedPaper(env, identity.data.division || rosterDivision(identity.data));
  if (questions.length > 200) throw new HttpError(503, 'The configured paper exceeds the submission limit');
  const items = questions.map(({ question, order }, index) => ({
    id: String(question.id),
    n: index + 1,
    catId: Number(question.catId),
    scheme: question.scheme || 'standard',
    question: String(question.question || ''),
    supplement: typeof question.supplement === 'string' ? question.supplement : '',
    options: order.map((optionIndex) => question.options[optionIndex]),
    originalOptions: question.options,
    order
  }));
  if (!items.length || new TextEncoder().encode(JSON.stringify(items)).byteLength > 500 * 1024) {
    throw new HttpError(503, 'The released candidate paper is invalid or too large');
  }
  const issuedAt = Date.now();
  const manifest = { uid, identityKey, sessionId: session.data.sessionId, paperId: control.data.paperId, items, createdAt: issuedAt };
  const updatedSession = {
    ...session.data,
    stage: 'exam',
    paperId: control.data.paperId,
    paperIssuedAt: issuedAt,
    examStartedAt: Number(session.data.examStartedAt) || issuedAt,
    heartbeatAt: issuedAt
  };
  try {
    await commitWrites(env, [
      { path, data: manifest, create: true },
      { path: `sessions/${uid}`, data: updatedSession, updateTime: session.updateTime }
    ]);
  } catch (error) {
    if (error.status !== 409) throw error;
    const raced = await getDocument(env, path);
    if (raced && raced.data.identityKey === identityKey && raced.data.sessionId === session.data.sessionId) {
      return { paper: publicItems(raced.data.items), paperId: raced.data.paperId };
    }
    throw new HttpError(409, 'Paper assignment changed; reload and contact an invigilator');
  }
  return { paper: publicItems(items), paperId: control.data.paperId };
}

async function seal(env, uid, payload) {
  const pack = payload.package;
  const sub = pack && pack.submission;
  const submissionKeys = new Set(['v', 'uid', 'sessionId', 'paperId', 'candidate', 'identityKey', 'reason', 'verdict', 'strikes', 'advisories', 'startedAt', 'sealedAt', 'elapsedSec', 'clockSource', 'resumes', 'total', 'answered', 'unanswered', 'marked', 'modules', 'items', 'salt', 'checksum', 'checksumAlgo']);
  const candidateKeys = new Set(['schoolUid', 'teamId', 'memberId', 'name', 'attemptedBy', 'division', 'schoolName', 'rosterVerified', 'isIndividual', 'consentVersion', 'consentAt']);
  if (!hasOnlyKeys(sub, submissionKeys) || !hasOnlyKeys(sub.candidate, candidateKeys)
    || ![2, 3].includes(sub.v) || sub.uid !== uid || typeof sub.identityKey !== 'string' || !/^[a-f0-9]{40}$/.test(sub.identityKey)
    || !validText(sub.sessionId, 80) || !sub.sessionId || !validText(sub.paperId, 80) || !sub.paperId
    || !validText(sub.reason, 120) || !['firestore', 'http-date', 'local-wallclock'].includes(sub.clockSource)
    || !Number.isFinite(sub.startedAt) || sub.startedAt <= 0 || !Number.isFinite(sub.sealedAt) || sub.sealedAt <= 0
    || !Number.isSafeInteger(sub.elapsedSec) || sub.elapsedSec < 0 || sub.elapsedSec > 86400
    || !Number.isSafeInteger(sub.resumes) || sub.resumes < 0 || sub.resumes > 1000
    || !validText(sub.checksumAlgo, 64) || sub.checksumAlgo !== 'SHA-256(salt|canonicalJSON(body))'
    || !validText(sub.candidate.schoolUid, 80) || !validText(sub.candidate.teamId, 80)
    || !validText(sub.candidate.memberId, 80) || !validText(sub.candidate.name, 200)
    || (sub.candidate.attemptedBy != null && !validText(sub.candidate.attemptedBy, 120))
    || !validText(sub.candidate.division, 24) || !validText(sub.candidate.schoolName, 120)
    || sub.candidate.rosterVerified !== true || typeof sub.candidate.isIndividual !== 'boolean'
    || !validText(sub.candidate.consentVersion, 100) || !Number.isSafeInteger(sub.candidate.consentAt) || sub.candidate.consentAt <= 0
    || !Array.isArray(sub.items) || sub.items.length < 1 || sub.items.length > 200
    || !Number.isSafeInteger(sub.total) || sub.total < 1 || sub.total > 200
    || !Number.isSafeInteger(sub.strikes) || sub.strikes < 0 || sub.strikes > 1000
    || !['CLEAN', 'REVIEW', 'FLAGGED', 'DISQUALIFIED'].includes(sub.verdict)
    || !sub.advisories || typeof sub.advisories !== 'object' || Array.isArray(sub.advisories)
    || Object.keys(sub.advisories).length > 50
    || Object.entries(sub.advisories).some(([key, value]) => !/^[A-Z0-9_]{1,80}$/.test(key) || !Number.isSafeInteger(value) || value < 0 || value > 10000)
    || !Array.isArray(sub.modules) || sub.modules.length < 1 || sub.modules.length > 20
    || !/^[a-f0-9]{64}$/i.test(sub.checksum || '') || !/^[a-f0-9]{32}$/i.test(sub.salt || '')) {
    throw new HttpError(400, 'Invalid submission package');
  }
  if (!(await verifyChecksum(sub))) throw new HttpError(422, 'Submission checksum mismatch');
  const duplicate = await getDocument(env, `submissions/${uid}`);
  if (duplicate) {
    if (duplicate.data.checksum === sub.checksum) return { recorded: true, duplicate: true };
    throw new HttpError(409, 'A different submission has already been sealed');
  }
  const identity = await getDocument(env, `identities/${sub.identityKey}`);
  const sess = await getDocument(env, `sessions/${uid}`);
  if (!identity || identity.data.uid !== uid || identity.data.state !== 'active' || !sess || sess.data.uid !== uid || sess.data.identityKey !== sub.identityKey || sess.data.stage !== 'exam' || sess.data.status === 'submitted') {
    throw new HttpError(403, 'Active exam session required to submit');
  }
  const assignedPaper = await getDocument(env, `candidate_papers/${uid}`);
  if (!assignedPaper || assignedPaper.data.identityKey !== sub.identityKey || assignedPaper.data.sessionId !== sess.data.sessionId || assignedPaper.data.paperId !== sess.data.paperId) {
    throw new HttpError(403, 'No matching server-assigned paper exists for this session');
  }
  if (sub.sessionId !== sess.data.sessionId
    || normal(sub.candidate?.schoolUid) !== normal(identity.data.schoolUid)
    || normal(sub.candidate?.name) !== normal(identity.data.name)
    || ![identity.data.teamId, identity.data.rawTeamId].map(normal).includes(normal(sub.candidate?.teamId))
    || normal(sub.candidate?.division) !== normal(identity.data.division)
    || normal(sub.candidate?.memberId) !== normal(identity.data.memberId)
    || sub.candidate?.rosterVerified !== true
    || Boolean(sub.candidate?.isIndividual) !== Boolean(identity.data.isIndividual)
    || sub.candidate?.consentVersion !== identity.data.consentVersion
    || Number(sub.candidate?.consentAt) !== Number(identity.data.consentAt)) {
    throw new HttpError(403, 'Submission identity does not match the active roster session');
  }
  const control = await getDocument(env, 'exam_control/status');
  const currentTime = Date.now();
  const end = control && control.data.startedAt ? control.data.startedAt + (Number(control.data.durationSeconds) + Number(control.data.extensionSeconds || 0)) * 1000 : 0;
  const started = control && control.data.startedAt;
  const withinWindow = control && control.data.status === 'active' && started && currentTime <= end + 2 * 60 * 1000;
  const forceEndedGrace = control && control.data.status === 'ended' && control.data.updatedAt && currentTime <= control.data.updatedAt + 2 * 60 * 1000;
  if (!withinWindow && !forceEndedGrace) throw new HttpError(403, 'The submission window has closed');
  if (!control || !control.data.paperId) throw new HttpError(403, 'No released paper is configured');
  if (sess.data.paperId !== control.data.paperId) throw new HttpError(403, 'Assigned paper differs from the released paper');
  const purgeState = await stillsPurgeState(env, control.data.startedAt);
  await validatePaper(sub, assignedPaper.data);
  validateSubmissionSummary(sub, assignedPaper.data);
  const receivedAt = Date.now();
  const clientReportedStrikes = Math.max(Number(sess.data.strikes) || 0, Number(sub.strikes) || 0);
  const clientReportedAdvisories = Math.max(Number(sess.data.advisories) || 0, 0);
  const clientReportedVerdict = clientReportedStrikes >= (Number(env.MAX_STRIKES) || 3)
    ? 'DISQUALIFIED'
    : clientReportedStrikes > 0 ? 'FLAGGED' : clientReportedAdvisories > 0 ? 'REVIEW' : 'CLEAN';
  const serverAnswered = sub.items.filter((item) => (sub.v === 2 ? item.original : item.selected).length > 0).length;
  const normalizedItems = sub.v === 3
    ? sub.items.map((item, index) => ({
      ...item,
      original: item.selected.map((displayIndex) => assignedPaper.data.items[index].order[displayIndex])
    }))
    : sub.items;
  const serverMarked = sub.items.filter((item) => item.marked === true).length;
  const finalSubmission = {
    ...sub,
    items: normalizedItems,
    uid,
    clientReportedStrikes,
    clientReportedVerdict,
    serverAnswered,
    serverMarked,
    receivedAt
  };
  const finalSession = { ...sess.data, stage: 'sealed', status: 'submitted', checksum: sub.checksum, heartbeatAt: receivedAt };
  const finalIdentity = { ...identity.data, state: 'sealed', updatedAt: receivedAt };
  const writes = [
    { path: `submissions/${uid}`, data: finalSubmission, create: true },
    { path: `sessions/${uid}`, data: finalSession, updateTime: sess.updateTime },
    { path: `identities/${sub.identityKey}`, data: finalIdentity, updateTime: identity.updateTime },
    { path: `candidate_papers/${uid}`, delete: true, updateTime: assignedPaper.updateTime }
  ];
  const forensic = fitForensics(cleanForensics(pack.forensics, uid, sub.identityKey, sess.data.sessionId, sub.checksum, receivedAt));
  if (purgeState.purged && forensic) {
    if (forensic.baseline) delete forensic.baseline.photo;
    forensic.thumbs = [];
  }
  if (forensic) {
    const fxDoc = await getDocument(env, `forensics/${uid}`);
    writes.push(fxDoc
      ? { path: `forensics/${uid}`, data: forensic, updateTime: fxDoc.updateTime }
      : { path: `forensics/${uid}`, data: forensic, create: true });
    if (!purgeState.purged && (forensic.baseline?.photo || forensic.thumbs.length)) writes.push(purgeState.guard);
  }
  await commitWrites(env, writes);
  return { recorded: true, receivedAt };
}

export async function onRequestOptions({ request, env }) {
  const origin = allowedOrigin(request, env);
  if (origin === false) return json({ error: 'Origin not allowed' }, 403);
  return new Response(null, { status: 204, headers: {
    ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin'
  } });
}

export async function onRequestPost({ request, env }) {
  const origin = allowedOrigin(request, env);
  if (origin === false) return json({ error: 'Origin not allowed' }, 403);
  try {
    enforceIpRateLimit(request.headers.get('CF-Connecting-IP'));
    const length = Number(request.headers.get('content-length') || 0);
    if (length > 600 * 1024) return json({ error: 'Payload too large' }, 413, origin);
    const { uid } = await authenticate(request, env);
    enforceUserRateLimit(uid);
    const raw = await readLimitedBody(request, 600 * 1024);
    if (!jsonDepthWithin(raw)) throw new HttpError(400, 'JSON nesting is too deep');
    let payload;
    try { payload = JSON.parse(raw); } catch (_) { throw new HttpError(400, 'Malformed JSON'); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new HttpError(400, 'Malformed JSON');
    enforceActionRateLimit(uid, payload.action);
    let result;
    if (payload.action === 'claim') result = await claim(env, uid, payload);
    else if (payload.action === 'session') result = await session(env, uid, payload);
    else if (payload.action === 'event') result = await event(env, uid, payload);
    else if (payload.action === 'baseline') result = await baseline(env, uid, payload);
    else if (payload.action === 'paper') result = await paper(env, uid);
    else if (payload.action === 'seal') result = await seal(env, uid, payload);
    else if (payload.action === 'time') result = { server: Date.now() };
    else throw new HttpError(400, 'Unknown candidate action');
    return json(result, 200, origin);
  } catch (error) {
    const status = error.status || 500;
    return json({ error: status >= 500 ? 'Candidate service is temporarily unavailable' : error.message || 'Request failed' }, status, origin);
  }
}
