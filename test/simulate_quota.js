/**
 * Quizzitch Firestore Quota Simulation
 * Simulates 30 candidates across a 60-minute session + 1 invigilator dashboard with 3 reloads.
 * Validates that writes <= 6,000 and reads <= 15,000.
 */

import { trackOp, getFirestoreStats, resetFirestoreStats } from '../scripts/firebase.js';

function simulateEvent() {
  resetFirestoreStats();

  const CANDIDATES = 30;
  const DURATION_MINUTES = 60;
  const QUESTIONS_COUNT = 40;

  // 1. Admin setup: upload questions, answer key, roster
  trackOp('write', 'quizzitch_questions', QUESTIONS_COUNT);
  trackOp('write', 'answer_key', 1);
  trackOp('write', 'roster', CANDIDATES);
  trackOp('write', 'exam_control', 1); // release paper

  // 2. Simulate 30 candidates
  for (let c = 0; c < CANDIDATES; c++) {
    const uid = `candidate_${c}`;
    const identityKey = `key_${c}`;

    // Boot & Sign in
    trackOp('read', 'roster', 1);
    trackOp('read', 'identities', 1);
    trackOp('write', 'identities', 1); // claim
    trackOp('write', 'time_sync', 3);
    trackOp('read', 'time_sync', 3);
    trackOp('read', 'sessions', 1); // check own session
    trackOp('write', 'sessions', 1); // initial session write
    trackOp('write', 'events', 1); // SIGNED_IN event

    // Exam control listener & fetch paper
    trackOp('read', 'exam_control', 1);
    trackOp('read', 'quizzitch_questions', QUESTIONS_COUNT);
    trackOp('write', 'forensics', 1); // baseline
    trackOp('write', 'events', 1); // EXAM_STARTED event
    trackOp('write', 'sessions', 1); // state: in paper

    // 60-minute exam simulation
    for (let m = 1; m <= DURATION_MINUTES; m++) {
      // 60-second heartbeat write
      trackOp('write', 'sessions', 1);

      // Candidate answers question every 3 minutes (changed state)
      if (m % 3 === 0) {
        trackOp('write', 'sessions', 1);
      }

      // Candidate triggers ~3-4 advisories total over 60 mins (buffered and flushed at heartbeat)
      if (m === 15 || m === 35) {
        trackOp('write', 'events', 1); // flushed at heartbeat
      }

      // Candidate triggers 1 occasional strike during exam (~30% of candidates)
      if (c % 3 === 0 && m === 25) {
        trackOp('write', 'events', 1); // immediate strike event
        trackOp('write', 'sessions', 1); // immediate session write
      }
    }

    // Exam Seal / Submission
    trackOp('write', 'forensics', 1);
    trackOp('write', 'submissions', 1);
    trackOp('write', 'sessions', 1);
    trackOp('write', 'identities', 1); // sealed
  }

  // 3. Admin dashboard (1 live session + 3 page reloads)
  const ADMIN_RELOADS = 3;
  for (let r = 0; r < ADMIN_RELOADS; r++) {
    trackOp('read', 'admins', 1);
    trackOp('read', 'exam_control', 1);
    trackOp('read', 'answer_key', 1);
    trackOp('read', 'sessions', CANDIDATES);
    trackOp('read', 'events', 60); // query limit 200, ~60 events present
    trackOp('read', 'submissions', r === 0 ? 0 : r === 1 ? 5 : CANDIDATES);
  }

  // Admin live snapshot listener updates across the 60 minutes
  // Each candidate session write delivers 1 doc change to admin
  // Total candidate session writes = 30 * (~60 heartbeats + ~20 question updates + 2 lifecycle + 0.3 strikes) = ~2,470
  trackOp('read', 'sessions', 2470);
  // Each event write delivers 1 doc change to admin (~3-4 events per candidate = ~100 events)
  trackOp('read', 'events', 105);
  // Each submission delivers 1 doc change to admin (30 total)
  trackOp('read', 'submissions', CANDIDATES);
  // Control extensions/announcements (~3 updates)
  trackOp('read', 'exam_control', 3);

  const stats = getFirestoreStats();

  console.log('====================================================');
  console.log('       QUIZZITCH FIRESTORE QUOTA SIMULATION         ');
  console.log('====================================================');
  console.log(`Candidates: ${CANDIDATES} | Duration: ${DURATION_MINUTES} mins | Admin Reloads: ${ADMIN_RELOADS}`);
  console.log('----------------------------------------------------');
  console.log('TOTAL WRITES: ', stats.totalWrites, ' (Target <= 6,000 | Spark Quota: 20,000)');
  console.log('TOTAL READS:  ', stats.totalReads,  ' (Target <= 15,000 | Spark Quota: 50,000)');
  console.log('----------------------------------------------------');
  console.log('Writes by collection:');
  console.table(stats.writes);
  console.log('Reads by collection:');
  console.table(stats.reads);
  console.log('====================================================');

  if (stats.totalWrites > 6000) {
    throw new Error(`Write target exceeded! ${stats.totalWrites} > 6000`);
  }
  if (stats.totalReads > 15000) {
    throw new Error(`Read target exceeded! ${stats.totalReads} > 15000`);
  }
  console.log('✓ QUOTA BUDGET TEST PASSED: All operations well within limits.');
}

simulateEvent();
