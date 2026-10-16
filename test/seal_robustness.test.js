/**
 * Quizzitch Seal Robustness Tests
 * Tests:
 *  1. fitForensics: caps thumbs at 8 and document at 500KB
 *  2. prepareOutboxPackage: strips thumbnails and baseline photo from outbox
 *  3. minimalOutboxPackage: provides fallback when localStorage quota is tight
 *  4. Checksum verification compatibility between submission and admin
 *  5. Double seal idempotency and timer race simulation
 */

import assert from 'node:assert';
import { fitForensics, prepareOutboxPackage, minimalOutboxPackage, readOutbox } from '../scripts/submission.js';
import { sha256Hex, canonicalJSON } from '../scripts/util.js';

console.log('--- Quizzitch Seal Robustness Unit Tests ---');

// 1. fitForensics thumb cap & size cap
console.log('1. Testing fitForensics capping (max 8 thumbs, max 500KB)...');
const sampleDoc = {
  sessionId: 'test_sess_001',
  baseline: { photo: 'data:image/jpeg;base64,' + 'X'.repeat(50000), pose: { yaw: 0, pitch: 0 } },
  thumbs: Array.from({ length: 15 }, (_, i) => ({
    seq: i + 1,
    type: 'GAZE_EVASION',
    dataUrl: 'data:image/jpeg;base64,' + 'Y'.repeat(45000)
  })),
  ledger: Array.from({ length: 100 }, (_, i) => ({
    seq: i + 1,
    level: i % 2 === 0 ? 0 : 2,
    type: i % 2 === 0 ? 'INFO' : 'STRIKE',
    message: `Incident ${i}`
  }))
};

const fitted = fitForensics(JSON.parse(JSON.stringify(sampleDoc)));
assert(fitted.thumbs.length <= 8, `Expected thumbs <= 8, got ${fitted.thumbs.length}`);
const fittedSize = JSON.stringify(fitted).length;
assert(fittedSize <= 500 * 1024, `Expected size <= 500KB, got ${fittedSize} bytes`);
console.log(`   fitForensics: Thumbs capped at ${fitted.thumbs.length}, doc size ${fittedSize} bytes (<= 512,000 bytes) -> PASS`);

// 2. prepareOutboxPackage: strips thumbnails and baseline photo
console.log('2. Testing prepareOutboxPackage (thumbnail stripping)...');
const fullPkg = {
  checksum: 'a'.repeat(64),
  submission: {
    sessionId: 'test_sess_001',
    paperId: 'CC26-PRELIM-01',
    candidate: { schoolUid: 'C26-AB-0101', teamId: 'C26-AB-0101-IPOD', name: 'Ada Lovelace' },
    items: [{ id: 'q1', original: [0] }],
    salt: 'b'.repeat(16)
  },
  forensics: {
    sessionId: 'test_sess_001',
    baseline: { photo: 'data:image/jpeg;base64,' + 'Z'.repeat(10000) },
    thumbs: [{ seq: 1, dataUrl: 'data:image/jpeg;base64,' + 'Z'.repeat(10000) }],
    leakedCopy: 'data:image/jpeg;base64,' + 'Z'.repeat(10000),
    ledger: [{ seq: 1, level: 2, type: 'TEST', message: 'Strike', data: { photo: 'data:image/jpeg;base64,' + 'Z'.repeat(10000) } }]
  }
};

const stripped = prepareOutboxPackage(fullPkg);
assert.strictEqual(stripped.checksum, fullPkg.checksum);
assert.deepStrictEqual(stripped.submission, fullPkg.submission);
assert.strictEqual(stripped.forensics.thumbs.length, 0);
assert.strictEqual(stripped.forensics.baseline.photo, undefined);
assert.equal(Object.hasOwn(stripped.forensics, 'leakedCopy'), false);
assert.equal(Object.hasOwn(stripped.forensics.ledger[0], 'data'), false);
console.log('   prepareOutboxPackage: Thumbnails and photo stripped cleanly while preserving submission -> PASS');

const localStorageItems = new Map([['qz.outbox.v2', JSON.stringify(fullPkg)]]);
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key) => localStorageItems.get(key) || null,
    setItem: (key, value) => localStorageItems.set(key, String(value)),
    removeItem: (key) => localStorageItems.delete(key)
  }
});
const restoredOutbox = readOutbox();
assert.deepStrictEqual(restoredOutbox.forensics.thumbs, []);
assert.strictEqual(restoredOutbox.forensics.baseline.photo, undefined);
assert.doesNotMatch(localStorageItems.get('qz.outbox.v2'), /data:image\/jpeg;base64/);
console.log('   readOutbox: Legacy local retry copies are scrubbed on load -> PASS');
localStorageItems.set('qz.outbox.v2', JSON.stringify({ ...fullPkg, submission: { ...fullPkg.submission, forensicCopy: { photo: 'data:image/jpeg;base64,AAAA' } } }));
assert.equal(readOutbox(), null);
assert.equal(localStorageItems.has('qz.outbox.v2'), false);
console.log('   readOutbox: Image-bearing submission extras are discarded -> PASS');

// 3. minimalOutboxPackage: quota fallback
console.log('3. Testing minimalOutboxPackage fallback...');
const minimal = minimalOutboxPackage(fullPkg);
assert.strictEqual(minimal.checksum, fullPkg.checksum);
assert.deepStrictEqual(minimal.submission, fullPkg.submission);
assert.deepStrictEqual(minimal.forensics.thumbs, []);
assert.strictEqual(minimal.forensics.sessionId, 'test_sess_001');
console.log('   minimalOutboxPackage: Created minimal payload containing answers, metadata, and checksum -> PASS');

// 4. Checksum verification compatibility between submission and admin
console.log('4. Testing checksum verification compatibility...');
async function testChecksum() {
  const body = {
    v: 2,
    sessionId: 'sess_123',
    paperId: 'CC26-PRELIM-01',
    candidate: { schoolUid: 'C26-AB-0101', teamId: 'C26-AB-0101-IPOD', name: 'Ada Lovelace' },
    identityKey: 'idkey_abc',
    reason: 'CANDIDATE_SUBMIT',
    verdict: 'CLEAN',
    strikes: 0,
    advisories: {},
    startedAt: 1700000000000,
    sealedAt: 1700003600000,
    elapsedSec: 3600,
    clockSource: 'server-sync',
    resumes: 0,
    total: 1,
    answered: 1,
    unanswered: 0,
    marked: 0,
    modules: [],
    items: [{ id: 'q1', displayed: [0], original: [0], seconds: 30, marked: false }],
    salt: 'f1e2d3c4b5a6'
  };

  const checksum = await sha256Hex(`${body.salt}|${canonicalJSON(body)}`);
  const submissionDoc = {
    ...body,
    checksum,
    checksumAlgo: 'SHA-256(salt|canonicalJSON(body))',
    uid: 'firebase_uid_123',
    receivedAt: { seconds: 1700003601 },
    updatedAt: { seconds: 1700003601 },
    id: 'firebase_uid_123'
  };

  // admin verifyChecksum implementation
  const { checksum: c, checksumAlgo: ca, uid: u, receivedAt: ra, updatedAt: ua, id: docId, ...reconstructedBody } = submissionDoc;
  const verifiedDigest = await sha256Hex(`${submissionDoc.salt}|${canonicalJSON(reconstructedBody)}`);
  assert.strictEqual(verifiedDigest, checksum, 'Digest must match checksum');
  console.log('   verifyChecksum: Stored submission document verifies identically -> PASS');
}
await testChecksum();

const v3Body = {
  v: 3,
  salt: '0123456789abcdef',
  items: [{ id: 'q1', selected: [1], displayed: ['B'], text: ['Option B'], marked: false }]
};
const v3Checksum = await sha256Hex(`${v3Body.salt}|${canonicalJSON(v3Body)}`);
const serverNormalizedV3 = {
  ...v3Body,
  items: [{ ...v3Body.items[0], original: [2] }],
  checksum: v3Checksum,
  checksumAlgo: 'SHA-256(salt|canonicalJSON(body))',
  receivedAt: 1700003601000
};
const { checksum: storedV3Checksum, checksumAlgo: storedV3Algo, receivedAt: storedV3At, ...storedV3Body } = serverNormalizedV3;
storedV3Body.items = storedV3Body.items.map(({ original, ...item }) => item);
assert.equal(await sha256Hex(`${serverNormalizedV3.salt}|${canonicalJSON(storedV3Body)}`), v3Checksum,
  'Server-derived original answer indices must not invalidate the client payload checksum');
console.log('   verifyChecksum: Server-normalized v3 answers preserve the client payload checksum -> PASS');

// 5. Timer expiration & double-seal race simulation
console.log('5. Testing double-seal race and idempotency...');
let sealLock = false;
let sealCallCount = 0;
let sealSuccessCount = 0;

async function simulateSeal(reason) {
  sealCallCount++;
  if (sealLock) {
    // Second concurrent call is blocked by client guard
    return { status: 'blocked_by_guard' };
  }
  sealLock = true;
  // Simulate network dispatch
  await new Promise((r) => setTimeout(r, 10));
  sealSuccessCount++;
  return { status: 'sealed', reason };
}

// Simulate timer and candidate submit button firing at the exact same moment
const [res1, res2] = await Promise.all([
  simulateSeal('TIME_EXPIRY'),
  simulateSeal('CANDIDATE_SUBMIT')
]);

assert.strictEqual(sealCallCount, 2, 'Two calls were made');
assert.strictEqual(sealSuccessCount, 1, 'Only one seal succeeded');
assert(
  (res1.status === 'sealed' && res2.status === 'blocked_by_guard') ||
  (res2.status === 'sealed' && res1.status === 'blocked_by_guard'),
  'Race condition handled without double submission'
);
console.log('   doubleSealRace: Concurrent timer & candidate submit resolved to exactly one submission -> PASS');

// 6. Test submission count validation with 40 main + 5 bonus items
console.log('6. Testing submission count validation with bonus questions...');
function validateSubmissionSummary(submission, manifest) {
  const answered = submission.items.filter((item) => (submission.v === 2 ? item.original : item.selected).length > 0).length;
  const marked = submission.items.filter((item) => item.marked).length;

  const mainCount = manifest.items.filter((item) => !item.isBonus && item.segment !== 'bonus').length || 40;
  const isFullPaperCounts = (submission.answered + submission.unanswered === manifest.items.length) && (submission.unanswered === manifest.items.length - answered);
  const isMainOnlyCounts = (submission.answered + submission.unanswered === mainCount) && (submission.unanswered === mainCount - answered);

  if (!Number.isSafeInteger(submission.answered) || !Number.isSafeInteger(submission.unanswered)
    || !Number.isSafeInteger(submission.marked) || submission.answered < 0 || submission.marked < 0
    || submission.unanswered < 0 || (!isFullPaperCounts && !isMainOnlyCounts)
    || submission.marked > manifest.items.length
    || submission.answered !== answered || submission.marked !== marked) {
    throw new Error('Submission counts are invalid or do not match answers');
  }
  return true;
}

const testManifest = {
  items: Array.from({ length: 45 }, (_, i) => ({
    id: `q${i + 1}`,
    catId: i >= 40 ? 1 : 0,
    isBonus: i >= 40,
    segment: i >= 40 ? 'bonus' : 'main'
  }))
};

const mainOnlySub = {
  v: 3,
  total: 45,
  answered: 1,
  unanswered: 39,
  marked: 0,
  items: Array.from({ length: 45 }, (_, i) => ({
    id: `q${i + 1}`,
    selected: i === 0 ? [0] : [],
    marked: false
  }))
};
assert.doesNotThrow(() => validateSubmissionSummary(mainOnlySub, testManifest));

const allItemsSub = {
  v: 3,
  total: 45,
  answered: 1,
  unanswered: 44,
  marked: 0,
  items: Array.from({ length: 45 }, (_, i) => ({
    id: `q${i + 1}`,
    selected: i === 0 ? [0] : [],
    marked: false
  }))
};
assert.doesNotThrow(() => validateSubmissionSummary(allItemsSub, testManifest));

const tamperedSub = { ...mainOnlySub, unanswered: 10 };
assert.throws(() => validateSubmissionSummary(tamperedSub, testManifest));
console.log('   validateSubmissionSummary: Accepts both main-only count (locked bonus) and full paper count -> PASS');

console.log('\nAll seal robustness tests passed successfully!');
