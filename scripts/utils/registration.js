/* ==========================================================================
   QUIZZITCH — utils/registration.js
   Production Registration & Contingent Access Logic.
   Fetches registration by Team ID or UID, extracts Quizzitch roster,
   and provides data for selecting candidate name and details.
   ========================================================================== */

import { getFirestoreDb } from './firebase.js';

export function normalizeUid(uid) {
  if (!uid) return '';
  return String(uid).trim().toUpperCase();
}

export function getLocalRegistrations() {
  try {
    const raw = localStorage.getItem('c26_registrations');
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

/**
 * Searches Firestore, local storage, and remote API for registration matching Team ID or UID.
 */
export async function lookupRegistration(queryId) {
  const clean = normalizeUid(queryId);
  if (!clean) return null;

  // 1. Check Firestore "registrations" if initialized
  const db = getFirestoreDb();
  if (db) {
    try {
      const { doc, getDoc, collection, query, where, getDocs } = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js');
      // Direct doc lookup by clean UID
      const docSnap = await getDoc(doc(db, 'registrations', clean));
      if (docSnap.exists()) {
        return { ...docSnap.data(), queryMatchedId: clean };
      }

      // Query by teamId or schoolUID
      const q = query(collection(db, 'registrations'), where('teamId', '==', clean));
      const qSnap = await getDocs(q);
      if (!qSnap.empty) {
        return { ...qSnap.docs[0].data(), queryMatchedId: clean };
      }
    } catch (_) {
      // Fall through to local/proxy lookup
    }
  }

  // 2. Check LocalStorage (c26_registrations)
  const localStore = getLocalRegistrations();
  if (localStore[clean]) {
    return { ...localStore[clean], queryMatchedId: clean };
  }

  for (const [key, reg] of Object.entries(localStore)) {
    if (!reg) continue;
    if (key === clean || (reg.uid && normalizeUid(reg.uid) === clean) || (reg.schoolUID && normalizeUid(reg.schoolUID) === clean)) {
      return { ...reg, queryMatchedId: clean };
    }
    // Search inside events -> teams
    if (Array.isArray(reg.events)) {
      for (const ev of reg.events) {
        if (Array.isArray(ev.teams)) {
          for (const team of ev.teams) {
            if (team.teamId && normalizeUid(team.teamId) === clean) {
              return { ...reg, queryMatchedId: clean, matchedTeam: team };
            }
            if (Array.isArray(team.members)) {
              for (const m of team.members) {
                if (m.memberId && normalizeUid(m.memberId) === clean) {
                  return { ...reg, queryMatchedId: clean, matchedTeam: team, matchedMember: m };
                }
              }
            }
          }
        }
      }
    }
  }

  // 3. Try Remote Proxy API (/api/registration/:uid)
  try {
    const res = await fetch(`/api/registration/${encodeURIComponent(clean)}`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });
    if (res.ok) {
      const data = await res.json();
      if (data && (data.uid || data.school)) {
        return { ...data, queryMatchedId: clean };
      }
    }
  } catch (_) {
    // offline or proxy not running
  }

  return null;
}

/**
 * Extracts the Quizzitch team and members from a verified registration record
 */
export function extractQuizzitchTeam(registration, queryId = '') {
  if (!registration) return null;

  const cleanQuery = normalizeUid(queryId);
  const events = registration.events || [];

  // Find Quizzitch event
  const quizEvent = events.find((e) => {
    const id = String(e.id || '').toLowerCase();
    const name = String(e.name || '').toLowerCase();
    return id === 'quizzitch' || id === 'quiz' || name.includes('quizzitch') || name.includes('quiz');
  }) || events[0];

  if (!quizEvent || !quizEvent.teams || !quizEvent.teams.length) {
    if (registration.teams && registration.teams.length) {
      const t = registration.teams[0];
      return {
        schoolName: registration.school?.name || registration.schoolName || 'Participant Institution',
        teamId: t.teamId || cleanQuery || registration.uid,
        teamName: t.teamName || 'Quizzitch Team',
        category: t.category || 'Senior (Classes 9-12)',
        members: t.members || []
      };
    }
    return {
      schoolName: registration.school?.name || registration.schoolName || 'Participant Institution',
      teamId: cleanQuery || registration.uid || 'CLT-2026-QUIZ-T1',
      teamName: registration.school?.name ? `${registration.school.name} Quizzitch Team` : 'Quizzitch Team',
      category: 'Senior (Classes 9-12)',
      members: [
        {
          name: registration.school?.contact || registration.contactName || 'Candidate',
          class: '11',
          email: registration.school?.email || registration.contactEmail || '',
          memberId: `${cleanQuery || registration.uid}-M1`
        }
      ]
    };
  }

  // Find matching team by teamId if provided
  let selectedTeam = quizEvent.teams.find((t) => {
    return t.teamId && normalizeUid(t.teamId) === cleanQuery;
  });

  // If query didn't match teamId, check if it matches a memberId
  if (!selectedTeam) {
    selectedTeam = quizEvent.teams.find((t) => {
      return (t.members || []).some((m) => m.memberId && normalizeUid(m.memberId) === cleanQuery);
    });
  }

  // Default to first team
  if (!selectedTeam) {
    selectedTeam = quizEvent.teams[0];
  }

  return {
    schoolName: registration.school?.name || registration.schoolName || 'Participant Institution',
    teamId: selectedTeam.teamId || `${registration.uid || 'CLT-2026'}-QUIZ-T1`,
    teamName: selectedTeam.teamName || `${quizEvent.name || 'Quizzitch'} Team`,
    category: selectedTeam.category || 'Senior (Classes 9-12)',
    members: selectedTeam.members || []
  };
}
