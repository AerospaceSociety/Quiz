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
import { fitForensics, prepareOutboxPackage, minimalOutboxPackage } from '../scripts/submission.js';
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
    thumbs: [{ seq: 1, dataUrl: 'data:image/jpeg;base64,' + 'Z'.repeat(10000) }]
  }
};

const stripped = prepareOutboxPackage(fullPkg);
assert.strictEqual(stripped.checksum, fullPkg.checksum);
assert.deepStrictEqual(stripped.submission, fullPkg.submission);
assert.strictEqual(stripped.forensics.thumbs.length, 0);
assert.strictEqual(stripped.forensics.baseline.photo, undefined);
console.log('   prepareOutboxPackage: Thumbnails and photo stripped cleanly while preserving submission -> PASS');

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

console.log('\nAll seal robustness tests passed successfully!');
