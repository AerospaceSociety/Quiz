# QUIZZITCH — CelesteCon 2026 Screening Platform

**AEROSS · The Aerospace Society · Delhi Public School, R.K. Puram**

Preliminary screening for **In-Pursuit Of Dispute** (IPD) and **AEROSS Theatre** (THT). Static
front end, Firebase Auth/Firestore, Cloudflare Pages Functions, and an optional Jotform mirror.

| Page | Who | What |
|---|---|---|
| `index.html` | Candidates | 5-stage flow: sign-in → hardware calibration → protocol → exam → sealed receipt |
| `admin.html` | Invigilators | Live candidate grid, activity feed, paper release/end/extend, forensics, scoring, exports |

---

## 1 · Architecture

```
index.html ─ scripts/app.js ─────────── stage machine (1 → 5), boot, wiring
               ├─ session.js             private state, event bus, Security Audit Ledger, strike policy
               ├─ engine.js              bank validation, seeded paper build, answers, marks, keyboard
               ├─ render.js              every DOM write (text nodes only; KaTeX for $…$)
               ├─ proctor.js             camera, MediaPipe Face Landmarker @ ~2.5 FPS, pose, freeze
               ├─ sandbox.js             key lockdown, fullscreen grace, focus/visibility, DevTools tripwire
               │    └─ tripwire.worker.js  `debugger` timing probe, off the main thread
               ├─ timer.js               Cloudflare server-time handshake, monotonic countdown
               ├─ submission.js          heartbeat, live events, package checksum, API seal, Jotform, print
               └─ firebase.js            Firebase Auth/Firestore reads and admin operations
functions/api/candidate.js               authenticated roster claim, telemetry, validated submission seal
functions/api/submit.js                  Firestore-verified Jotform mirror
functions/api/retention.js                authenticated still purge job
admin.html ─ scripts/admin.js ─ firebase.js + util.js
styles/styles.css (theme, workspace, palette, print receipt) · styles/admin.css (command center)
config/settings.json (public tunables) · config/questions.json (private bank source — seed it, never serve it)
firestore.rules · _headers (Cloudflare/Netlify) · vercel.json (Vercel)
```

### Firestore collections

| Collection | Written by | Read by | Purpose |
|---|---|---|---|
| `exam_control/status` | admin | everyone signed in | `waiting` / `active` / `ended`, server `startedAt`, `durationSeconds`, `extensionSeconds` |
| `quizzitch_questions/{id}` | admin | admin / Pages Function | candidates receive only their server-generated paper after release |
| `answer_key/current` | admin | admin | `{ "Q101": [0], … }` zero-based original option indices |
| `roster/{key}` | admin | admin / Pages Function | candidate profile keyed by a one-time random access-code hash |
| `candidate_claims/{uid}` | Pages Function | admin | binds one Firebase account to one candidate identity |
| `candidate_papers/{uid}` | Pages Function | admin | server-assigned question snapshot, deleted atomically at seal or after retention |
| `identities/{key}` | Pages Function | admin / identity owner | one live device per candidate; sealed candidates cannot re-sit |
| `sessions/{uid}` | Pages Function | candidate (own) / admin | validated session shape and monotonic client-reported counters |
| `events/{id}` | Pages Function | admin | immutable live events, capped at 80 per session |
| `forensics/{uid}` | Pages Function | admin | baseline photo, incident stills, full ledger, device info |
| `submissions/{uid}` | Pages Function, **create once** | admin | assigned-paper-validated answers, server answer counts, client-reported proctor flags, and checksum |
| `admins/{uid}` | **console only** | self | invigilator allowlist |

Candidate data writes are denied by Firestore rules and pass through authenticated Pages Functions.
The Functions use the server-only `FIREBASE_SERVICE_ACCOUNT` secret. Never put that key in browser
assets, settings, source control, or `.dev.vars` committed to Git.

---

## 2 · One-time Firebase setup (project `quizzitch-14998`)

1. **Authentication → Sign-in method**: enable **Anonymous** (candidates) and **Email/Password** (invigilators).
2. **Authentication → Users → Add user** for each invigilator.
3. **Firestore → Data**: create collection `admins`, one document per invigilator with the
   **document ID = that user's UID** (any field, e.g. `{ "name": "…" }`). The admin page shows the UID
   of a signed-in account that is not yet allowlisted.
4. **Deploy the rules** (the rules previously in production let *any* signed-in user — including
   anonymous — start/reset the exam and read every submission; the new rules close that):
   ```bash
   npx firebase-tools deploy --only firestore:rules --project quizzitch-14998
   ```
   or paste `firestore.rules` into **Firestore → Rules → Publish**.
5. Create `exam_control/status` once from the admin deck (press **Reset to waiting**).
6. **Seed the bank**: admin → *Question Bank & Tools* → upload `config/questions.json`. Any `correct`
   fields are stripped before upload.
7. **Upload the answer key** (same tab): `{ "Q101": [0], "Q104": [0, 1] }` — indices into the
   **original** option order as written in the bank, zero-based. Or upload a bank file that has
   `correct` arrays and accept the prompt.
8. **Upload the authoritative roster** from Admin → *Question Bank & Tools*. The portal generates a
   random 128-bit access code for each candidate and downloads a CSV containing those private codes.
   Distribute each code securely, retain a protected backup, and include the `claimCode` column when
  re-uploading a roster so codes remain stable. Each upload replaces the roster and revokes omitted
  access codes. Candidate writes never read the roster directly.

---

## 3 · Running a paper

1. Candidates sign in with School UID, Team ID, registered name, and their private roster access code.
   They calibrate and read the protocol.
   They wait on Stage 3 with “Awaiting invigilator release”.
2. Invigilator presses **Release paper**. The server stamps `startedAt`; every candidate's
   **Enter Examination Workspace** unlocks (a click is required — browsers only allow fullscreen from a gesture).
3. Everyone shares one server-authoritative end time: `startedAt + duration + extensions`. Late joiners
   get the remaining time, not a fresh 45 minutes. **+5 min** extends everyone.
4. **End & force submit** permits a short, two-minute delivery window for final seals.
5. Results tab: scores, module breakdown, checksum verification, IPD pooled standings, exports
   (candidates CSV, standings CSV, integrity-log CSV, full JSON).
6. Between rounds: export required records, then remove `sessions`, `events`, `identities`,
   `candidate_claims`, `candidate_papers`, `submissions`, and `forensics` in the console before replacing
   the question bank or answer key. Then **Reset to waiting**.

**Recovery** — a reload or browser crash resumes the same server-assigned paper (same question/option order,
answers restored; server-held strikes carry over). A dead laptop: open the candidate's forensic
record → **Release identity lock**, then sign in on another machine. Answers held only on the old
device cannot be recovered. A sealed submission cannot be re-sat.
Shared lab machines are supported: after a recorded submission the terminal signs out, so the next
candidate gets a fresh identity.

---

## 4 · Integrity model

| Signal | Level | Notes |
|---|---|---|
| Tab hidden / window blur | **Strike** | once per departure, however long it lasts |
| Fullscreen exit | Advisory → **Strike** after 10 s | lockout modal with countdown; repeats every 10 s until return |
| Multiple faces (≥ 1.5 s) | **Strike** | MediaPipe, `numFaces: 2` |
| Frozen / virtual camera feed (≥ 5 s) | **Strike** | 32×24 luma-grid delta ≈ 0 or `<video>` clock stalled; virtual-camera labels rejected at calibration |
| DevTools tripwire | **Strike** | worker `debugger` pause > 800 ms |
| Camera track ended | **Strike** | unplugged or permission revoked |
| Face absent > 6 s | Advisory | requires 3 consecutive missed frames before timer begins |
| Head yaw > 35° or pitch down > 30° for 6 s | Advisory | relative to baseline pose captured at calibration (advisory only) |
| Docked-DevTools resize, blocked shortcut, print, reload attempt | Advisory | logged to audit ledger |
| Clock skew (≥ 3 s) or freeze (≥ 8 s) | Strike / Advisory | clock skew strikes & resyncs; freeze logged as advisory only |

*(Microphone audio is NOT accessed, recorded or monitored — proctoring is vision-only.)*

In the unmodified client, every 3 advisories of one kind become a strike; **3 strikes seal the paper**.
Stored verdicts and strike totals are explicitly client-reported, not server-attested.

### What this can and cannot do — read before relying on it

- **The browser is not a lockdown kiosk.** Alt+Tab, the Windows/⌘ key and OS screenshot tools belong
  to the operating system. In Chromium fullscreen the Keyboard Lock API captures Alt+Tab/Meta/Esc;
  elsewhere those keys still work — but each use fires blur/visibility/fullscreen events, which are strikes.
- **Anything in the page can be inspected by a determined user.** State lives in ES-module scope
  (nothing on `window`), config and the paper are deep-frozen, the state tree is frozen at seal — this
  stops casual console tampering, not a patched browser. Server-side controls protect roster claims,
  keep the answer key private, randomly assign and persist a distinct paper, validate answer shape/order, and make
  submissions create-once. Client-side proctoring reports can be omitted or forged by a modified client.
- **The checksum proves the record wasn't altered *after* sealing** (salt + canonical JSON, recomputed
  in the admin deck). It cannot prove the client was honest *before* sealing.
- **Question bank exposure & residual risk:** Candidate Firestore reads are denied. The Pages API assigns a paper only after release; its questions and options must then reach the browser and can be copied by a patched client or external camera. The answer key stays admin-only. Per-candidate shuffle reduces answer sharing but cannot stop it.
- The source question bank is excluded from uploaded static assets, and `/config/questions.json` returns `404` in Pages previews and deployments. Candidate papers omit the server-held option permutation; the API converts displayed selections to original answer-key indices only when sealing.
- **Vision flags are evidence for a human reviewer**, not automated verdicts. Lighting, glasses and
  webcam position move the numbers; tune thresholds in `settings.proctoring` after a rehearsal.
- Candidate and Jotform relay routes apply per-account and Cloudflare client-IP request caps. These
  are isolate-local best-effort throttles, not a global quota firewall; distributed traffic or isolate
  restarts can bypass them. A zero-budget browser deployment cannot promise immunity from denial of
  service or guarantee a cheat-proof sitting.

### Deliberate departures from the brief

| Brief | Implemented | Why |
|---|---|---|
| IIFE closure + `Proxy.revocable` | ES-module scope + `Object.freeze` / deep-freeze at seal | Modules give the same privacy as an IIFE; a revocable proxy guards a reference the console can't reach anyway. |
| “Encrypted” in-memory ledger | Plain in-memory ledger, sealed under the SHA-256 checksum | The key would sit in the same memory as the data; encryption there adds nothing. |
| Eval-based `debugger` | `debugger` in a Web Worker, timed | Same detection with no `unsafe-eval` in the CSP. |
| Block Alt+Tab / Windows key | Captured via Keyboard Lock in fullscreen; otherwise detected and struck | No web API can block OS shortcuts. |
| DOMPurify | Not needed | There is no `innerHTML` anywhere; all dynamic text is set as text nodes. |

---

## 5 · Free-tier budget

`npm run test:simulation` estimates Firestore reads and writes across the authenticated API paths,
including the extra validation reads per heartbeat/event, assigned-paper reads, admin listeners, and
both purge paths. It models 30 candidates, a 60-minute run, and three admin reloads; it is not a billing
guarantee or an emulator test. Real free-tier quotas and Jotform submission limits must be checked for
the actual accounts/event date. If the estimate exceeds the available quota, do not run a live paper.

The simulation is a stress estimate, not a promise of zero cost. Firebase, Cloudflare, and Jotform
quotas are separate, and exceeding any provider's free allowance can disable the live quiz or require
payment. Keep the roster, question bank, telemetry, and image retention small; test with the expected
candidate count in a separate project first.

Current provider limits checked 2026-10-15: Firestore's free database includes 50,000 reads and
20,000 writes per day; Cloudflare Workers Free includes 100,000 requests per day shared with Pages
Functions; Jotform Starter includes 100 submissions per month and 1,000 API calls per day. Quotas can
change, and other account usage consumes the same allowance. Jotform is only a mirror: its quota failure
does not roll back a sealed Firestore result. See the [Firestore pricing](https://firebase.google.com/docs/firestore/pricing),
[Cloudflare Pages Functions pricing](https://developers.cloudflare.com/pages/functions/pricing/),
[Jotform usage limits](https://www.jotform.com/help/408-Understanding-Your-Account-Usage-and-Limits/),
and [Jotform API limits](https://www.jotform.com/help/406-daily-api-call-limits/).

---

## 6 · Configuration (`config/settings.json`)

| Block | Key settings |
|---|---|
| `meta` | `paperId` (exam identifier), `round`, `build` |
| `exam` | `durationSeconds` 2700, `itemsPerModule` 5, shuffles, `questionSource` `firestore`/`local`, `requireRelease` |
| `timer` | `syncSamples` 3, `resyncSeconds` 300, `anomalyThresholdMs` 5000, `anomalyAction` `submit`/`strike` |
| `security` | `maxStrikes` 3, `advisoriesPerStrike` 3, `fullscreenGraceSeconds` 10, `devtoolsTripwire`, `requireFullscreen` |
| `proctoring` | `inferenceIntervalMs` 400 (2.5 FPS), `frameWidth/Height` 320×240, `delegate` `CPU`, all thresholds, CDN URLs, `allowDegradedMode` |
| `telemetry` | `heartbeatSeconds` 60, `advisoryRateLimitSeconds` 60 |
| `schemes` | `standard` / `highstakes` (shown as *Reasoning*): +5 / −1 · `multi`: +5 / 0, exact match only · blank: 0 |
| `modules`, `divisions`, `registry` | module letters/names; IPD/THT with team size & seeds; ID regexes |
| `jotform` | see §7 |

Question format (`config/questions.json`): `{ "id", "catId", "scheme", "question", "supplement", "options": [...] }`,
optional `"divisions": ["IPD"]`. Inline maths: `$\Delta v = \sqrt{\mu/r}$` (KaTeX).

---

## 7 · Jotform mirror

Firebase is the system of record. To also mirror each submission into Jotform:

1. Run the automated provisioning script with your Jotform API key (Full Access):
   ```bash
   export JOTFORM_API_KEY="your-api-key"
   npm run provision:jotform
   ```
   This calls `https://api.jotform.com`, creates all 10 required fields, and enables the mirror in `config/settings.json`. Set the server-side `JOTFORM_FORM_ID` to the provisioned form ID.

2. Or build the form manually: short-text fields for School UID, Team ID, Candidate Name, Division, Session ID,
   Answered, Verdict, Checksum, and long-text fields for Responses JSON and Summary Text. Their internal field names must match the provisioner names exactly; the relay refuses missing fields.

Jotform's API is called by the server relay, not directly by candidate browsers.

### Authoritative Submission and Jotform Relay (Cloudflare Pages Functions)
The browser sends only the sealed submission and Firebase ID token to the fixed same-origin `/api/submit` relay. Still images are not sent to Jotform.

The relay removes the browser-to-Jotform CORS dependency; it does not remove provider quotas or guarantee zero cost:
- **Cloudflare Pages**: `functions/api/submit.js` deploys automatically at `/api/submit`. Configure server-side `JOTFORM_API_KEY`, `JOTFORM_FORM_ID`, and `FIREBASE_PROJECT_ID`; never place the Jotform API key in client config.

The Pages API validates Firebase ID tokens, access-code claims, session ownership, released paper
question order/options, package checksums, and create-once seals. Jotform accepts only the matching
Firestore submission; form IDs and submitted fields are selected server-side. A SHA-256 checksum
detects changes after package creation but is **not** an HMAC/signature and does not prove that
client-side proctoring ran honestly.

---

## 8 · DPDP Act 2023 & Minor Consent Compliance

The consent text remains a draft and this software does not certify legal compliance. The API now requires
the configured consent version and an affirmative client flag, and records server receipt time; a modified
client can still lie about whether a person actually saw or accepted the text. Obtain appropriate
school/guardian review before collecting images.

The Admin **Purge forensic stills** action removes forensic thumbnails/baselines and incident-feed copies,
clears stills held by connected candidate and admin pages, and omits images from JSON exports and local retry
packages. The API refuses to store new stills for that event after the marker is set. A separate daily
Cloudflare Worker purges stale stills 30 days after the event ends (or by record age if no end timestamp
exists). Offline pages and copies outside the site (screenshots, downloads, exports, or OS backups) cannot
be remotely recalled.

---

## 9 · Automated Test Suites

Run local quota, seal-shape, API rate-limit, and static trust-boundary checks:
```bash
npm test                # Runs quota simulation, seal robustness, API limits, and security rules
npm run test:simulation # Validates Firestore Spark quota budget (30 candidates x 60 min <= 6,000 writes, <= 15,000 reads)
npm run test:seal       # Validates fitForensics 500KB/8-thumb cap, fallback payloads, and double-seal idempotency
npm run test:rules      # Static checks only; not a Firestore Emulator test
```

## 10 · Local development & deployment

```bash
npm install
npm run dev          # public-only staging at http://127.0.0.1:8000
npm run preview      # Pages Functions preview from the same safe staging build
```

These commands build an allowlisted `dist/` and never serve the repository root; the question bank is not
copied. Rehearse the live flow in a separate Firebase project. Do not use `wrangler pages dev .` or a
generic static server on the repository root, and do not deploy this site to GitHub Pages: neither path
provides the required Pages Functions security boundary.

- **Cloudflare Pages**: `npm run deploy` rebuilds and deploys only the allowlisted `dist/` assets; Pages
  Functions remain sourced from `functions/`. `_headers` applies security headers, and a Pages Function
  also blocks direct question-bank requests. `.assetsignore` provides a secondary upload safeguard.
- `questionSource: "local"` is not included in the safe staging build; use the Firestore paper API for
  rehearsals rather than publishing the bank to a browser.

Browser support: current Chrome / Edge (recommended — Keyboard Lock, best MediaPipe performance),
Firefox. Safari desktop works with reduced shortcut capture. Phones and tablets are not supported.

## 11 · Troubleshooting

| Symptom | Fix |
|---|---|
| “Serve the portal over HTTP” | Opened via `file://`. Use `npm run dev` or deploy. |
| “Secure link unavailable” | Anonymous auth disabled or network blocks `*.googleapis.com`. |
| MediaPipe check fails | School firewall blocks `cdn.jsdelivr.net` / `storage.googleapis.com`. Allow-list them, or set `allowDegradedMode: true` (logged). |
| Button stays “Awaiting invigilator release” | `exam_control/status` isn't `active`, or `requireRelease` should be `false` for self-paced rehearsals. |
| “Could not open the paper — permission denied” | Rules deployed but paper not released, or bank not seeded. |
| Admin shows “Not on the invigilator allowlist” | Create `admins/{uid}` with the UID shown. |
| Checksum **MISMATCH** in Results | The stored record was edited after sealing — treat as tampered. |

The previous implementation is archived in `quizzitch-legacy-backup.zip` (excluded from git and deploys).
