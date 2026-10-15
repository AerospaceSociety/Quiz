import assert from 'node:assert/strict';
import { trackOp, getFirestoreStats, resetFirestoreStats } from '../scripts/firebase.js';

const candidates = 30;
const durationMinutes = 60;
const questions = 40;
const eventsPerCandidate = 4;
const adminReloads = 3;
const reads = (collection, count = 1) => trackOp('read', collection, count);
const writes = (collection, count = 1) => trackOp('write', collection, count);

resetFirestoreStats();

writes('quizzitch_questions', questions);
writes('answer_key');
writes('roster', candidates);
writes('exam_control', 3);
reads('exam_control', 3);
reads('submissions', 1);
reads('quizzitch_questions', questions);

for (let candidate = 0; candidate < candidates; candidate++) {
  reads('roster');
  reads('submissions');
  reads('candidate_claims');
  reads('identities');
  writes('identities');
  writes('candidate_claims');
  reads('sessions');

  reads('identities', 3);
  reads('sessions', 3);
  reads('exam_control', 3);
  writes('sessions');

  reads('identities');
  reads('sessions');
  reads('exam_control');
  reads('forensics');
  reads('privacy_controls', 2);
  writes('privacy_controls');
  writes('forensics');

  reads('candidate_claims');
  reads('identities');
  reads('sessions');
  reads('exam_control');
  reads('candidate_papers');
  reads('quizzitch_questions', questions);
  writes('candidate_papers');
  writes('sessions');

  for (let minute = 0; minute < durationMinutes; minute++) {
    reads('identities');
    reads('sessions');
    reads('exam_control');
    writes('sessions');
    if (minute > 0 && minute % 3 === 0) {
      reads('identities');
      reads('sessions');
      reads('exam_control');
      writes('sessions');
    }
  }

  for (let event = 0; event < eventsPerCandidate; event++) {
    reads('identities');
    reads('sessions');
    reads('exam_control');
    reads('privacy_controls');
    reads('events');
    writes('events');
    writes('sessions');
    writes('privacy_controls');
  }

  reads('submissions');
  reads('identities');
  reads('sessions');
  reads('candidate_papers');
  reads('exam_control');
  reads('privacy_controls');
  reads('forensics');
  writes('submissions');
  writes('sessions');
  writes('identities');
  writes('candidate_papers');
  writes('forensics');
  writes('privacy_controls');
}

reads('privacy_controls', candidates);
reads('privacy_controls', candidates);
reads('privacy_controls', adminReloads + 1);
writes('privacy_controls');

const eventDocuments = candidates * eventsPerCandidate;
for (let reload = 0; reload < adminReloads; reload++) {
  reads('admins');
  reads('exam_control');
  reads('answer_key');
  reads('quizzitch_questions', questions);
  reads('sessions', candidates);
  reads('events', eventDocuments);
  reads('submissions', candidates);
}

reads('sessions', candidates * (1 + durationMinutes + Math.floor((durationMinutes - 1) / 3) + eventsPerCandidate + 1));
reads('events', eventDocuments);
reads('submissions', candidates);
reads('exam_control', 3);

reads('forensics', candidates);
reads('events', eventDocuments);
reads('exam_control');
writes('forensics', candidates);
writes('events', eventDocuments);
writes('privacy_controls', 2);

reads('exam_control');
reads('privacy_controls', 2);
reads('sessions', candidates);
reads('submissions', candidates);
reads('forensics', candidates);
reads('events', eventDocuments);
writes('forensics', candidates);
writes('events', eventDocuments);
writes('exam_control');
writes('privacy_controls', 2);

const stats = getFirestoreStats();
const readBudget = 15000;
const writeBudget = 6000;

console.log('Firestore REST/API operation estimate');
console.log(`Candidates: ${candidates} | Duration: ${durationMinutes} minutes | Admin reloads: ${adminReloads}`);
console.log(`Operations include API validation reads, heartbeats, paper fetch, seal, admin listeners, manual purge, and scheduled purge.`);
console.log(`Estimated reads: ${stats.totalReads} / ${readBudget}`);
console.log(`Estimated writes: ${stats.totalWrites} / ${writeBudget}`);
console.table({ reads: stats.reads, writes: stats.writes });
console.log('Estimate only; production usage depends on real event traffic and Firestore billing semantics.');

assert.ok(stats.totalReads <= readBudget, `Read target exceeded: ${stats.totalReads} > ${readBudget}`);
assert.ok(stats.totalWrites <= writeBudget, `Write target exceeded: ${stats.totalWrites} > ${writeBudget}`);
