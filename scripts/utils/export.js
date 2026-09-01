/* ==========================================================================
   QUIZZITCH — utils/export.js
   Audit-dossier output: a machine-readable JSON record for the invigilation
   panel, and a print pipeline that produces the same dossier as a PDF through
   the browser's own "Save as PDF" target.
   ========================================================================== */

import { S, logEvent, toast } from '../core/state.js';

/* --- 01 · FILENAME -------------------------------------------------------- */
/** Builds a stable, filesystem-safe name: QUIZZITCH_DOSSIER_<id>_<session>. */
export function dossierFilename(extension) {
  const id = (S.candidate.id || 'UNREG').replace(/[^A-Za-z0-9_-]/g, '');
  const session = (S.sessionId || 'SESSION').replace(/[^A-Za-z0-9_-]/g, '');
  return `QUIZZITCH_DOSSIER_${id}_${session}.${extension}`;
}

/* --- 02 · JSON EXPORT ----------------------------------------------------- */
/**
 * Writes the dossier to the candidate's downloads as pretty-printed JSON.
 * @param {object} dossier payload from quiz/engine.js buildDossier()
 */
export function exportJSON(dossier) {
  if (!dossier) {
    toast('Nothing to export', 'The dossier has not been generated yet.', 'warn');
    return;
  }

  const filename = dossierFilename('json');
  const blob = new Blob([JSON.stringify(dossier, null, 2)], { type: 'application/json' });
  triggerDownload(blob, filename);

  logEvent('info', 'EXPORT', `JSON dossier exported as ${filename}`);
  toast('Dossier exported', 'JSON audit record written to your downloads.', 'accent');
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/* --- 03 · PRINT / SAVE AS PDF -------------------------------------------- */
/**
 * Opens the browser print dialog against the dossier print stylesheet
 * (styles/layout.css → @media print). Choosing "Save as PDF" as the print
 * destination produces the paper dossier; the document title becomes the
 * suggested filename, so it is swapped for the duration of the dialog.
 */
export function printDossier() {
  const original = document.title;
  document.title = dossierFilename('pdf').replace(/\.pdf$/, '');

  const restore = () => {
    document.title = original;
    window.removeEventListener('afterprint', restore);
  };
  window.addEventListener('afterprint', restore);
  // Safari never fires afterprint reliably — restore on a timer as well.
  setTimeout(restore, 8000);

  logEvent('info', 'EXPORT', 'Print / Save-as-PDF dialog opened for the audit dossier');
  window.print();
}

/* --- 04 · CLIPBOARD SUMMARY (optional convenience) ----------------------- */
/**
 * Copies a one-line result summary. Used by nothing in the default build —
 * kept because invigilators frequently want a paste-able line for a sheet.
 */
export async function copySummary(dossier) {
  if (!dossier) return false;
  const d = dossier;
  const line = [
    d.candidate.id || 'UNREG',
    d.candidate.name || '—',
    d.candidate.grade || '—',
    `${d.result.score}/${d.result.max}`,
    `${d.result.accuracyPct.toFixed(1)}%`,
    `${d.proctoring.strikes} strikes`,
    d.meta.verdict
  ].join('\t');

  try {
    await navigator.clipboard.writeText(line);
    toast('Summary copied', 'A tab-separated result line is on your clipboard.', 'accent');
    return true;
  } catch (_) {
    toast('Copy blocked', 'The browser refused clipboard access.', 'warn');
    return false;
  }
}
