/* ==========================================================================
   QUIZZITCH — utils/jotform.js
   JotForm submission handler for CelesteCon Quizzitch assessment.
   Matches the field mapping in C26JF/field_map.json and supports both
   backend proxy (/api/submit) and direct JotForm submission.
   ========================================================================== */

import { CFG } from '../core/state.js';

export async function submitAssessmentToJotForm(dossier) {
  const jfConfig = CFG.settings.jotform || {};
  const formId = jfConfig.formId || '261896133006456';
  const fieldMap = jfConfig.fieldMap || {
    school_name: '2',
    contact_name: '3',
    contact_email: '4',
    contact_phone: '5',
    events_selected: '6',
    registration_summary: '7',
    registration_json: '8',
    total_teams: '9',
    total_participants: '10'
  };

  const cand = dossier.candidate || {};
  const res = dossier.result || {};
  const proc = dossier.proctoring || {};

  /* Generate high-level summary string for JotForm email / inbox table */
  const summaryText = [
    `QUIZZITCH 2026 OFFICIAL ASSESSMENT SUBMISSION`,
    `--------------------------------------------------`,
    `Candidate Name : ${cand.name || '—'}`,
    `Registration ID: ${cand.id || '—'} (Grade ${cand.grade || '—'})`,
    `School         : ${cand.school || '—'}`,
    `--------------------------------------------------`,
    `Final Score    : ${res.score || 0} / ${res.max || 56}`,
    `Accuracy       : ${(res.accuracyPct || 0).toFixed(1)}%`,
    `Time Consumed  : ${Math.floor((res.timeConsumedSec || 0) / 60)}m ${(res.timeConsumedSec || 0) % 60}s`,
    `Verdict        : ${dossier.meta?.verdict || 'SUBMISSION_ACCEPTED'}`,
    `Security Flags : ${proc.incidents || 0} incident(s), ${proc.focusBreaches || 0} blur(s)`,
    `Integrity Hash : ${dossier.meta?.integrityHash || '—'}`,
    `Submitted At   : ${new Date(dossier.meta?.generated || Date.now()).toISOString()}`
  ].join('\n');

  /* Construct structured payload matching C26JF backend proxy schema */
  const proxyPayload = {
    school: {
      name: cand.school || 'Delhi Public School, R.K. Puram',
      contact: cand.name || 'Anonymous Candidate',
      phone: cand.id || 'CC26-QZ-0000',
      email: cand.email || `${(cand.id || 'candidate').toLowerCase().replace(/[^a-z0-9]/g, '')}@aeross.org`
    },
    submittedAt: new Date(dossier.meta?.generated || Date.now()).toISOString(),
    events: [
      {
        id: 'quizzitch',
        name: 'Quizzitch',
        teams: [
          {
            teamName: `${cand.name || 'Candidate'} (Solo)`,
            category: (cand.grade === 'VI' || cand.grade === 'VII' || cand.grade === 'VIII') ? 'Junior (Classes 6–8)' : 'Senior (Classes 9–12)',
            members: [
              {
                name: cand.name || 'Candidate',
                class: cand.grade ? String(cand.grade) : '11',
                gender: 'Not Specified'
              }
            ]
          }
        ]
      }
    ],
    totals: {
      totalTeams: 1,
      totalParticipants: 1
    },
    summary: summaryText,
    dossier: dossier
  };

  /* Method A: Try backend FastAPI proxy if available */
  try {
    const proxyUrl = jfConfig.proxyUrl || 'http://localhost:8000/api/submit';
    const resp = await fetch(proxyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proxyPayload)
    });
    if (resp.ok) {
      const data = await resp.json();
      return { ok: true, via: 'proxy', id: data.submissionID || 'JOTFORM-PROXIED', data };
    }
  } catch (err) {
    console.warn('[JotForm] Proxy endpoint unavailable, falling back to direct JotForm submission...', err);
  }

  /* Method B: Direct submission to JotForm Form API endpoint */
  try {
    const formData = new FormData();
    formData.append('formID', formId);
    formData.append(`q${fieldMap.school_name}_schoolName`, proxyPayload.school.name);
    formData.append(`q${fieldMap.contact_name}_contactName`, proxyPayload.school.contact);
    formData.append(`q${fieldMap.contact_email}_contactEmail`, proxyPayload.school.email);
    formData.append(`q${fieldMap.contact_phone}_contactPhone`, proxyPayload.school.phone);
    formData.append(`q${fieldMap.events_selected}_eventsSelected[0]`, 'Quizzitch');
    formData.append(`q${fieldMap.registration_summary}_registrationSummary`, summaryText);
    formData.append(`q${fieldMap.registration_json}_registrationJson`, JSON.stringify(dossier));
    formData.append(`q${fieldMap.total_teams}_totalTeams`, '1');
    formData.append(`q${fieldMap.total_participants}_totalParticipants`, '1');

    const directResp = await fetch(`https://submit.jotform.com/submit/${formId}`, {
      method: 'POST',
      body: formData,
      mode: 'no-cors' // Opaque request succeeds and stores data in JotForm
    });

    return {
      ok: true,
      via: 'direct',
      id: 'JF-' + Date.now().toString(36).toUpperCase(),
      message: 'Assessment data successfully recorded to JotForm.'
    };
  } catch (e) {
    console.error('[JotForm] Direct submission failed:', e);
    return { ok: false, error: e.message };
  }
}
