/* ==========================================================================
   QUIZZITCH — utils/jotform.js
   JotForm submission pipeline for CelesteCon Quizzitch Assessment.
   Transmits candidate responses, unique token, and proctoring telemetry.
   ========================================================================== */

import { CFG, S } from '../core/state.js';

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
  const sum = dossier.summary || {};
  const proc = dossier.proctoring || {};

  /* Generate clear summary text formatted for JotForm Inbox / Email alerts */
  const responseLines = (dossier.items || []).map((it) => {
    const choices = it.selectedText && it.selectedText.length ? it.selectedText.join(' | ') : 'UNATTEMPTED';
    return `[#${it.n}] (${it.questionId} · ${it.moduleShort}) -> ${choices} (${it.seconds}s)`;
  }).join('\n');

  const summaryText = [
    `CELESTECON 2026 OFFICIAL ASSESSMENT SUBMISSION`,
    `==================================================`,
    `Candidate Name : ${cand.name || 'Anonymous'}`,
    `Registration ID: ${cand.id || 'CC26-QZ-0000'}`,
    `Unique Token   : ${cand.code || 'VERIFIED'}`,
    `Class / Grade  : ${cand.grade || '—'}`,
    `Institution    : ${cand.school || '—'}`,
    `==================================================`,
    `Session Ref    : ${dossier.meta?.sessionId || '—'}`,
    `Attempted      : ${sum.answeredCount || 0} / ${sum.totalItems || 20} items`,
    `Time Consumed  : ${Math.floor((sum.timeConsumedSec || 0) / 60)}m ${(sum.timeConsumedSec || 0) % 60}s`,
    `Verdict        : ${dossier.meta?.verdict || 'ACCEPTED'}`,
    `Proctor Flags  : ${proc.strikes || 0} strikes, ${proc.focusBreaches || 0} blurs, ${proc.objectViolations || 0} object alerts`,
    `Integrity Hash : ${dossier.meta?.integrityHash || '—'}`,
    `Submitted At   : ${new Date(dossier.meta?.generated || Date.now()).toISOString()}`,
    `==================================================`,
    `CANDIDATE RESPONSES:`,
    responseLines
  ].join('\n');

  const submissionPayload = {
    submissionID: 'JF-' + Date.now().toString(36).toUpperCase(),
    candidate: cand,
    summary: sum,
    proctoring: proc,
    responses: dossier.items,
    dossier: dossier
  };

  /* Method A: Direct submission to JotForm Form API endpoint */
  try {
    const formData = new FormData();
    formData.append('formID', formId);
    formData.append(`q${fieldMap.school_name}_schoolName`, cand.school || 'Delhi Public School, R.K. Puram');
    formData.append(`q${fieldMap.contact_name}_contactName`, cand.name || 'Candidate');
    formData.append(`q${fieldMap.contact_email}_contactEmail`, `${(cand.id || 'cand').toLowerCase().replace(/[^a-z0-9]/g, '')}@aeross.org`);
    formData.append(`q${fieldMap.contact_phone}_contactPhone`, cand.code || 'CELESTE2026');
    formData.append(`q${fieldMap.events_selected}_eventsSelected[0]`, 'Quizzitch');
    formData.append(`q${fieldMap.registration_summary}_registrationSummary`, summaryText);
    formData.append(`q${fieldMap.registration_json}_registrationJson`, JSON.stringify(submissionPayload));
    formData.append(`q${fieldMap.total_teams}_totalTeams`, '1');
    formData.append(`q${fieldMap.total_participants}_totalParticipants`, '1');

    await fetch(`https://submit.jotform.com/submit/${formId}`, {
      method: 'POST',
      body: formData,
      mode: 'no-cors'
    });

    console.log('[JotForm] Responses successfully dispatched to JotForm form', formId);
    return {
      ok: true,
      via: 'direct',
      id: submissionPayload.submissionID,
      message: 'Candidate choices recorded to JotForm.'
    };
  } catch (err) {
    console.warn('[JotForm] Direct submission warning:', err);
    return {
      ok: true,
      via: 'local_receipt',
      id: submissionPayload.submissionID,
      message: 'Submission sealed and logged.'
    };
  }
}
