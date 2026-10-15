# Cloudflare Pages and Firebase Deployment

Quizzitch now requires server-only Firebase credentials for candidate claims, telemetry, submission sealing, Jotform verification, and scheduled privacy purges. Do not deploy the old client-write Firestore rules or run a live quiz until all steps below are complete.

## 1. Firebase setup

1. Enable Firebase Anonymous Auth for candidates and Email/Password Auth for invigilators.
2. Create the `admins/{uid}` allowlist documents for invigilators.
3. Create a Google Cloud service account for the Pages Functions. Grant only the Firestore data role needed to read/write this project’s Firestore database. Download its JSON key locally; never commit it or put it in browser config.
4. Immediately deploy `firestore.rules`:
   ```powershell
   npx firebase-tools deploy --only firestore:rules --project quizzitch-14998
   ```
   The rules deny all candidate writes to identities, sessions, events, forensics, and submissions; those writes must pass through the authenticated Pages API.
5. Seed the question bank and admin-only answer key from the Admin page. The source bank is excluded from static uploads, and `/config/questions.json` is explicitly blocked by a Pages Function. Candidate paper responses omit the server-held option permutation.
6. Before making the quiz live, remove any legacy `updatedBy` field from `/exam_control/status`; candidates can read the public control document. Future control writes remove that field automatically.

## 2. Pages configuration

### Step 1: Cloudflare Dashboard Build Settings
In Cloudflare Dashboard $\to$ **Workers & Pages** $\to$ **quiz** $\to$ **Settings** $\to$ **Builds & deployments**:
- **Build command**: `npm run build` (or `npm run build:static`)
- **Build output directory**: `dist`

### Step 2: Cloudflare Environment Variables
In **Settings** $\to$ **Variables and Secrets** $\to$ **Environment variables**, set these for Production and Preview (these are dynamically injected into `/config/settings.json` at build and runtime without ever committing them to Git):

| Variable | Example |
|---|---|
| `FIREBASE_PROJECT_ID` | `your_firebase_project_id` |
| `FIREBASE_API_KEY` | `your_firebase_api_key` (Web API key, injected during static build) |
| `FIREBASE_AUTH_DOMAIN` | `your_project.firebaseapp.com` |
| `FIREBASE_STORAGE_BUCKET` | `your_project.firebasestorage.app` |
| `FIREBASE_MESSAGING_SENDER_ID` | `your_messaging_sender_id` |
| `FIREBASE_APP_ID` | `your_firebase_web_app_id` |
| `FIREBASE_MEASUREMENT_ID` | `your_measurement_id` |
| `ALLOWED_ORIGINS` | `https://quiz.pages.dev,https://your-custom-domain.example` |
| `JOTFORM_FORM_ID` | `262450769915063` |
| `QUIZ_ITEMS_PER_MODULE` | `5` (must match `settings.json`) |
| `QUIZ_MODULE_IDS` | `0,1,2,3` (must match `settings.modules[].id`) |
| `QUIZ_SHUFFLE_QUESTIONS` | `true` |
| `QUIZ_SHUFFLE_OPTIONS` | `true` |
| `MAX_STRIKES` | `3` |
| `RETENTION_DAYS` | `30` |
| `CONSENT_VERSION` | `2026.1-DPDP-DRAFT` (must match `settings.security.consentVersion`) |

Set these as encrypted Pages secrets (CLI prompts for each value):

```powershell
npx wrangler pages secret put FIREBASE_SERVICE_ACCOUNT --project-name quiz
npx wrangler pages secret put JOTFORM_API_KEY --project-name quiz
npx wrangler pages secret put RETENTION_PURGE_TOKEN --project-name quiz
```

Paste the complete service-account JSON into the first prompt. Set `RETENTION_PURGE_TOKEN` to a long random secret; the same value is required by the scheduled Worker in the next section. For local Pages development, put only local values in the ignored `.dev.vars` file and include the exact development origin (for example `http://localhost:8788`) in `ALLOWED_ORIGINS`.

Deploy Pages after configuring the variables and secrets:

```powershell
npm run deploy
```

Confirm the production hostname and add it to Firebase Auth’s authorized domains. Restrict the Firebase browser API key to the production/custom domains and the required Firebase APIs. Do not allow broad `*.pages.dev` production origins unless preview access is intentionally needed.

## 3. Candidate roster migration

1. In Admin → *Question Bank & Tools*, upload a roster CSV/JSON containing `schoolUid`, `teamId`, and `name` (optional `memberId`, `division`).
2. The browser generates a random 128-bit code per candidate, stores only the code-derived identity key in Firestore, and downloads a CSV containing the codes.
3. Distribute each code through a private channel and retain the CSV in access-controlled storage. Never post it with the public quiz link.
4. Preserve the `claimCode` column when re-uploading. Every upload replaces the authoritative roster and deletes omitted access-code records; re-uploading without codes intentionally creates new credentials and identity keys. A candidate whose old code was already used may still have an identity lock, which an invigilator must release.
5. Existing deterministic roster/identity records are not migrated automatically. Deploy the rules first, then upload the new code-based roster and review/delete obsolete roster and identity records in the Firebase Console after the event data is backed up.

## 4. Scheduled still deletion

The Admin **Purge forensic stills** button first records a purge marker, then clears baseline/reference photos and incident thumbnails from `forensics` and `events`. Connected candidate and admin pages clear their app-held stills, and the candidate API refuses to store new stills for that event. Browser storage is scrubbed on retry/outbox reads. The scheduled Worker applies the same marker before purging stale stills after the retention period. Copies previously exported, photographed, or retained outside the site cannot be recalled.

Update `RETENTION_ENDPOINT` in `wrangler.retention.toml` if the Pages hostname is not `https://quiz.pages.dev`, then deploy the scheduler:

```powershell
npx wrangler login
npx wrangler deploy --config wrangler.retention.toml
npx wrangler secret put RETENTION_PURGE_TOKEN --config wrangler.retention.toml
```

Set the exact same token in the Pages secret and Worker secret. Verify the Cron Trigger is active in Cloudflare and inspect Worker logs after a scheduled run. Connected pages clear app-held stills; offline pages and screenshots, downloads, browser/OS backups, or records already exported elsewhere cannot be recalled.

## 5. Verify before the live event

Run local checks and a complete rehearsal in a separate Firebase project:

```powershell
npm test
npm run preview -- --port 8788
```

The preview command stages only public files in `dist/`; it does not serve the repository root or the source question bank.

Test correct and incorrect access codes, cross-account claim races, reload/resume, rejected direct Firestore writes, release/end/extension, normal and forced submission, Jotform failure/retry, event thumbnail purge, and the scheduled retention route. The repository tests include static policy checks; they are not a substitute for testing the deployed Firestore rules and Pages secrets against the Firebase Emulator or a rehearsal project.

The browser-based MediaPipe/focus/fullscreen checks remain bypassable by a technically capable candidate, external devices, modified browser code, or virtual camera tools. The server validates identity, assigned-paper shape/order, one-time sealing, timing window, and telemetry bounds, but strike/verdict reports still originate in the candidate's browser and can be omitted or forged. Treat flags as review evidence, not proof of misconduct. Cloudflare, Firebase, and Jotform have separate quotas; verify current limits and expected usage before the event. Browser-only monitoring cannot guarantee a cheat-proof exam.

The candidate and mirror APIs also apply per-user and `CF-Connecting-IP` rate caps in Worker memory. They are useful against accidental loops and basic single-source abuse, but are isolate-local and can reset or be bypassed by distributed traffic. They are not a hard global quota limit or a substitute for Cloudflare edge protections; rehearse peak concurrent use from the actual school network before the event.

As checked 2026-10-15, free-tier reference quotas are 50,000 Firestore reads and 20,000 writes/day, 100,000 Cloudflare Workers/Pages Function requests/day, and 100 Jotform Starter submissions/month. The relay makes two Jotform API calls for each successful mirrored submission (field lookup and submission), but the monthly submission limit is likely the binding limit. These values can change and are shared with other account usage; confirm them in each account before a live event. Firestore remains authoritative if Jotform rejects a mirror.
