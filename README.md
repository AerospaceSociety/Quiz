# QUIZZITCH — CelesteCon 2026 Screening Platform

**AEROSS · The Aerospace Society · Delhi Public School, R.K. Puram**

Proctored preliminary screening for **In-Pursuit Of Dispute** (IPD, 3-member teams, pooled scores
seed the top 16) and **AEROSS Theatre** (THT). Static front end + Firebase (Firestore + Auth) +
optional Jotform mirror. No build step, no framework, no server of our own.

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
               ├─ proctor.js             camera+mic, MediaPipe Face Landmarker @ ~2.5 FPS, pose, freeze, audio
               ├─ sandbox.js             key lockdown, fullscreen grace, focus/visibility, DevTools tripwire
               │    └─ tripwire.worker.js  `debugger` timing probe, off the main thread
               ├─ timer.js               server-offset handshake, monotonic countdown, anomaly detection
               ├─ submission.js          heartbeat, live events, SHA-256 package, Firebase batch, Jotform, print
               └─ firebase.js            the only module that talks to Firestore/Auth (shared with admin)
admin.html ─ scripts/admin.js ─ firebase.js + util.js
styles/styles.css (theme, workspace, palette, print receipt) · styles/admin.css (command center)
config/settings.json (all tunables) · config/questions.json (bank source — seed it, don't deploy it)
firestore.rules · _headers (Cloudflare/Netlify) · vercel.json (Vercel)
```

### Firestore collections

| Collection | Written by | Read by | Purpose |
|---|---|---|---|
| `exam_control/status` | admin | everyone signed in | `waiting` / `active` / `ended`, server `startedAt`, `durationSeconds`, `extensionSeconds` |
| `quizzitch_questions/{id}` | admin | candidates **only while `active`** | question bank (no answers) |
| `answer_key/current` | admin | admin | `{ "Q101": [0], … }` zero-based original option indices |
| `registrations/{schoolUid}` | admin | candidate (single `get`) | optional roster check |
| `identities/{key}` | candidate (own) | candidate `get` / admin | one live device per candidate; no second sitting |
| `sessions/{uid}` | candidate (own) | admin | heartbeat: stage, status, strikes, answered, current Q, fullscreen |
| `events/{auto}` | candidate (own uid) | admin | live feed: strikes (with 160×120 still), rate-limited advisories, milestones |
| `forensics/{uid}` | candidate until sealed | admin | baseline photo, incident stills, full ledger, device info |
| `submissions/{uid}` | candidate, **create once** | admin | sealed responses + salted SHA-256 checksum |
| `time_sync/{uid}` | candidate (own) | candidate | server-timestamp handshake scratch doc |
| `admins/{uid}` | **console only** | self | invigilator allowlist |

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
8. *(Optional)* **Rosters** — `registrations/CLT-2026-SCH-00042`:
   ```json
   { "schoolName": "Delhi Public School, R.K. Puram",
     "teams": { "IPD-T1-041": { "members": ["Aarav Mehta", "Ishita Rao", "Kabir Sethi"] },
                "THT-T2-007": { "members": ["Meera Iyer"] } } }
   ```
   `settings.registry.rosterCheck`: `off` · `advisory` (default — unverified sign-ins are allowed and
   labelled) · `strict` (name must be on the roster).

---

## 3 · Running a paper

1. Candidates open the site, sign in (School UID, Team ID, full name), calibrate, read the protocol.
   They wait on Stage 3 with “Awaiting invigilator release”.
2. Invigilator presses **Release paper**. The server stamps `startedAt`; every candidate's
   **Enter Examination Workspace** unlocks (a click is required — browsers only allow fullscreen from a gesture).
3. Everyone shares one server-authoritative end time: `startedAt + duration + extensions`. Late joiners
   get the remaining time, not a fresh 45 minutes. **+5 min** extends everyone.
4. **End & force submit** seals every open paper immediately.
5. Results tab: scores, module breakdown, checksum verification, IPD pooled standings, exports
   (candidates CSV, standings CSV, integrity-log CSV, full JSON).
6. Between rounds: delete `sessions`, `events`, `identities` (and archive `submissions`, `forensics`)
   in the console, then **Reset to waiting**.

**Recovery** — a reload or browser crash resumes the same paper (same seeded question/option order,
answers and strikes restored; logged as an advisory). A dead laptop: open the candidate's forensic
record → **Release identity lock**, and they sign in on another machine (their answers stay with the
old device; strikes carry over via the server session). A sealed submission can never be re-sat.
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
| Camera/mic track ended | **Strike** | unplugged or permission revoked |
| Face absent > 3 s | Advisory | |
| Head yaw > 30° or pitch down > 20° for 3 s | Advisory | relative to the baseline pose captured at calibration |
| Sustained speech-level audio (2 s) | Advisory | threshold = max(floor, 6 × calibrated noise) |
| Docked-DevTools resize, blocked serious shortcut, print, back-navigation, reload dialog | Advisory | |
| Clock skew or execution freeze > 5 s | **Seal** (`anomalyAction: "submit"`) or strike | a “Leave site?” dialog is recognised and logged as an advisory instead |

Every 3 advisories of one kind become a strike; **3 strikes seal the paper** (verdict `DISQUALIFIED`).
Verdicts: `CLEAN` · `REVIEW` (advisories only) · `FLAGGED` (strikes) · `DISQUALIFIED`.

### What this can and cannot do — read before relying on it

- **The browser is not a lockdown kiosk.** Alt+Tab, the Windows/⌘ key and OS screenshot tools belong
  to the operating system. In Chromium fullscreen the Keyboard Lock API captures Alt+Tab/Meta/Esc;
  elsewhere those keys still work — but each use fires blur/visibility/fullscreen events, which are strikes.
- **Anything in the page can be inspected by a determined user.** State lives in ES-module scope
  (nothing on `window`), config and the paper are deep-frozen, the state tree is frozen at seal — this
  stops console tampering, not a patched browser. The defences that actually hold are server-side:
  **the answer key never reaches candidates**, questions are unreadable until release, submissions are
  create-once, strikes can only go up, and invigilators re-verify every checksum.
- **The checksum proves the record wasn't altered *after* sealing** (salt + canonical JSON, recomputed
  in the admin deck). It cannot prove the client was honest *before* sealing.
- **Vision flags are evidence for a human reviewer**, not automated verdicts. Lighting, glasses and
  webcam position move the numbers; tune thresholds in `settings.proctoring` after a rehearsal.

### Deliberate departures from the brief

| Brief | Implemented | Why |
|---|---|---|
| IIFE closure + `Proxy.revocable` | ES-module scope + `Object.freeze` / deep-freeze at seal | Modules give the same privacy as an IIFE; a revocable proxy guards a reference the console can't reach anyway. |
| “Encrypted” in-memory ledger | Plain in-memory ledger, sealed under the SHA-256 checksum | The key would sit in the same memory as the data; encryption there adds nothing. |
| Eval-based `debugger` | `debugger` in a Web Worker, timed | Same detection with no `unsafe-eval` in the CSP. |
| Block Alt+Tab / Windows key | Captured via Keyboard Lock in fullscreen; otherwise detected and struck | No web API can block OS shortcuts. |
| DOMPurify | Not needed | There is no `innerHTML` anywhere; all dynamic text is set as text nodes. |

---

## 5 · Free-tier budget (Firestore Spark: 20 000 writes, 50 000 reads per day)

Per candidate per 45-minute paper, at the default 30 s heartbeat: ≈ 90 heartbeats + ≈ 25 other writes
(sign-in, identity, clock handshakes, events, sealing batch) ≈ **115 writes**. Each of those writes is
also **one read per open admin tab**.

| Candidates | Writes | Reads (1 admin tab) | Fits Spark? |
|---|---|---|---|
| 100 | ~11.5 k | ~12 k | Yes |
| 170 | ~19.5 k | ~20 k | Just |
| 300 | ~34.5 k | ~35 k | **No** — writes exceed 20 k |

To stay on the free tier for larger rounds, raise `telemetry.heartbeatSeconds` to 60–90 (≈ 60–70
writes per candidate → ~300 candidates), keep admin tabs to one or two, or split the cohort across
sessions/days. Beyond that, the Blaze plan costs cents per round (≈ $0.18 per 100 k writes) — add a
budget alert if you choose it.

---

## 6 · Configuration (`config/settings.json`)

| Block | Key settings |
|---|---|
| `meta` | `paperId` (also seeds the per-candidate shuffle), `round`, `build` |
| `exam` | `durationSeconds` 2700, `itemsPerModule` 5, shuffles, `questionSource` `firestore`/`local`, `requireRelease` |
| `timer` | `syncSamples` 3, `resyncSeconds` 300, `anomalyThresholdMs` 5000, `anomalyAction` `submit`/`strike` |
| `security` | `maxStrikes` 3, `advisoriesPerStrike` 3, `fullscreenGraceSeconds` 10, `devtoolsTripwire`, `requireFullscreen` |
| `proctoring` | `inferenceIntervalMs` 400 (2.5 FPS), `frameWidth/Height` 320×240, `delegate` `CPU`, all thresholds, CDN URLs, `allowDegradedMode` |
| `telemetry` | `heartbeatSeconds` 30, `advisoryRateLimitSeconds` 60 |
| `schemes` | `standard` / `highstakes` (shown as *Reasoning*): +5 / −1 · `multi`: +5 / 0, exact match only · blank: 0 |
| `modules`, `divisions`, `registry` | module letters/names; IPD/THT with team size & seeds; ID regexes |
| `jotform` | see §7 |

Question format (`config/questions.json`): `{ "id", "catId", "scheme", "question", "supplement", "options": [...] }`,
optional `"divisions": ["IPD"]`. Inline maths: `$\Delta v = \sqrt{\mu/r}$` (KaTeX).

---

## 7 · Jotform mirror (disabled by default)

Firebase is the system of record. To also mirror each submission into Jotform:

1. Run the automated provisioning script with your Jotform API key (Full Access):
   ```bash
   export JOTFORM_API_KEY="your-api-key"
   npm run provision:jotform
   # or: python scripts/provision_jotform.py --api-key="your-api-key"
   ```
   This calls `https://api.jotform.com`, creates all 10 required fields on form `262450769915063`, and updates `config/settings.json` automatically with `fieldMap` and `enabled: true`.

2. Or build the form manually: short-text fields for School UID, Team ID, Candidate Name, Division, Session ID,
   Answered, Verdict, Checksum, and long-text fields for Responses JSON and Summary Text. In the form's source,
   copy each field's `name` (e.g. `q3_schoolUid`) into `jotform.fieldMap`, and set `jotform.enabled: true`.

Jotform sends no CORS headers, so the direct browser submission shows “Dispatched” with an opaque response.

### Secure Webhook Relay (Recommended for proctored screening)
For high-integrity screening, set `jotform.webhookUrl` to your relay endpoint. The client attaches:
- `Authorization: Bearer <Firebase_ID_Token>` (cryptographically verified session JWT)
- Full sealed package including strikes, forensics metadata, and the salted SHA-256 checksum

An indigenous relay is built right into Quizzitch with zero external dependencies:
- **On Vercel**: `api/submit.js` deploys automatically as a serverless function at `/api/submit`. Simply set `"webhookUrl": "/api/submit"` in `config/settings.json`.
- **Local Node.js**: Run `npm run relay` (powered by `scripts/relay.js`).
- **Python**: Run `npm run relay:py` (powered by `scripts/webhook_relay.py`).

It gates every submission through:
1. **Firebase JWT Verification**: Confirms identity and valid anonymous auth session via Google tokeninfo.
2. **Identity Matching**: Confirms the caller UID matches `identityKey`.
3. **Single-Submission Lock**: Prevents duplicate submissions and replay attacks.
4. **Cryptographic Checksum Verification**: Recomputes `SHA-256(salt + "|" + canonicalJSON(body))` to ensure zero tampering in transit.
5. **Private Jotform API Dispatch**: Forwards to `https://api.jotform.com/form/{formID}/submissions` using `JOTFORM_API_KEY`.

To run the relay locally:
```bash
# Set your environment variables (see .env.example)
export JOTFORM_API_KEY="your-api-key"
export FIREBASE_PROJECT_ID="quizzitch-14998"

# Start the indigenous Node relay (port 8080)
npm run relay

# In config/settings.json, set:
# "webhookUrl": "http://localhost:8080/api/submit"
```

---

## 8 · Local development & deployment

```bash
npm install
npm run dev          # http://localhost:8000  (camera needs localhost or HTTPS)
```

Rehearse without Firebase: set `firebase.enabled: false`, `exam.questionSource: "local"` — the portal runs
fully offline and the receipt says “Rehearsal mode — not transmitted”.

- **Cloudflare Pages**: `npm run deploy`. `_headers` applies the security headers; `.assetsignore` keeps
  `config/questions.json`, rules and tooling off the CDN.
- **Vercel**: import the folder, no build command. `vercel.json` sets headers; `.vercelignore` excludes the bank.
- **GitHub Pages**: works (the `<meta>` CSP applies), but it can't set `frame-ancestors`/HSTS headers and
  will publish `config/questions.json` unless you delete it from the published branch.

Browser support: current Chrome / Edge (recommended — Keyboard Lock, best MediaPipe performance),
Firefox. Safari desktop works with reduced shortcut capture. Phones and tablets are not supported.

## 9 · Troubleshooting

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
