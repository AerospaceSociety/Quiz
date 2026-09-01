# QUIZZITCH — Secure Assessment Portal

**CelesteCon 2026 · Round 1 Online Qualifier**
AEROSS — The Aerospace Society, Delhi Public School R.K. Puram

A dependency-free, single-page examination portal with pre-flight device
calibration, on-device optical proctoring, an input sandbox, a strike ledger
and a printable audit dossier. No build step, no framework, no backend — plain
ES modules, four stylesheets and two JSON files you edit by hand.

---

## 1 · Quick start

The portal loads its configuration over `fetch()` and its code as ES modules,
so it **must be served over HTTP** — opening `index.html` from the filesystem
(`file://`) will show a configuration-error panel with this same instruction.

Pick any static server:

```bash
# Python (bundled with macOS and most Linux distros)
cd quizzitch-portal
python3 -m http.server 8000
# → http://localhost:8000

# Node
npx serve quizzitch-portal
npx http-server quizzitch-portal -p 8000

# VS Code
# Install the "Live Server" extension, right-click index.html → "Open with Live Server"
```

Then open the address in **Chrome, Edge or Firefox on a desktop or laptop**.
Camera access requires a *secure context*: `localhost` counts as secure, and so
does any HTTPS origin. Plain HTTP on a LAN address (`http://192.168.x.x`) does
**not** — the browser will refuse `getUserMedia` there.

---

## 2 · Project layout

```
quizzitch-portal/
├── index.html                  Semantic root layout and mount containers
├── config/
│   ├── settings.json           Timing, strike limits, proctoring, schemes, modules
│   └── questions.json          The question bank — the file you edit most
├── styles/
│   ├── base.css                Design tokens, reset, typography
│   ├── layout.css              Top HUD, grids, split-view workspace, print rules
│   ├── components.css          Panels, buttons, options, badges, modals, toasts
│   └── proctor.css             Camera viewports, bounding boxes, meters, log
├── scripts/
│   ├── core/
│   │   ├── app.js              Bootstrapper, diagnostics, stage router, wiring
│   │   └── state.js            Reactive store, event bus, session vault, log
│   ├── quiz/
│   │   ├── engine.js           Marking, navigation, clock listener, sealing
│   │   └── render.js           All DOM rendering (questions, matrix, dossier)
│   ├── security/
│   │   ├── proctor.js          WebRTC camera, baseline capture, canvas analyser
│   │   ├── sandbox.js          Clipboard, context menu, keystroke interceptors
│   │   └── monitor.js          Blur, visibility, fullscreen enforcement
│   └── utils/
│       ├── timer.js            Countdown clock and time formatters
│       └── export.js           JSON dossier and print / PDF pipeline
└── README.md
```

### Architecture in one paragraph

`state.js` owns the session and publishes events on a small bus. `render.js` is
the only module that writes to the DOM; it subscribes to those events and
repaints, and republishes user gestures as *intents*. `engine.js` consumes those
intents, mutates state and announces the change. The three `security/` modules
are independent layers that log, flag and strike. `app.js` loads the config,
installs everything and routes between the three stages. Because the import
graph is acyclic and the DOM writes are centralised, you can replace any single
file without touching the others.

---

## 3 · Editing the question bank

`config/questions.json` is a flat JSON array. Each item:

```json
{
  "id": 1,
  "catId": 0,
  "scheme": "standard",
  "question": "Placeholder Question Text: Replace with the actual technical prompt.",
  "supplement": "Optional supplementary formula, note, or diagram reference.",
  "options": [
    "Placeholder Option A",
    "Placeholder Option B",
    "Placeholder Option C",
    "Placeholder Option D"
  ],
  "correct": [0]
}
```

| Field        | Type       | Notes |
|--------------|------------|-------|
| `id`         | number     | Display/reference id. Keep it unique. |
| `catId`      | number     | Module id — must match an `id` in `settings.modules` (0–3 by default). |
| `scheme`     | string     | `standard`, `highstakes` or `multi` — must exist in `settings.schemes`. |
| `question`   | string     | The prompt. Rendered as plain text (safely escaped). |
| `supplement` | string     | Optional formula / note shown in a callout. Use `""` for none. |
| `options`    | string[]   | Two or more. Labelled A, B, C… automatically. |
| `correct`    | number[]   | **Zero-based** option indices. `[0]` = option A. Multi-select items list every correct index, e.g. `[0, 2, 3]`. |

**The `correct` array is zero-based.** `[0]` is option A, `[3]` is option D.
This is the single most common authoring mistake.

The portal validates the whole bank at boot. A bad `catId`, an unknown scheme,
an out-of-range `correct` index or a missing field stops the launch and prints
the exact item number and problem on screen — so a typo is caught before a
candidate ever sees it, not during the paper.

### Adding, removing and reordering

* Items are presented in **file order**. The question matrix groups them by
  `catId`, so keep each module's items contiguous for a sensible matrix.
* Add or delete items freely — the totals, the matrix, the progress meters and
  the maximum score all derive from the file. Nothing else needs updating.
* The default bank is 24 items × 4 modules = **56 marks**
  (3 × standard `+2`, 2 × high-stakes `+2`, 1 × multi `+4` per module).

### Marking schemes

| Scheme       | Correct | Incorrect | Unattempted | Selection |
|--------------|---------|-----------|-------------|-----------|
| `standard`   | **+2**  | 0         | 0           | single    |
| `highstakes` | **+2**  | **−1**    | 0           | single    |
| `multi`      | **+4**  | **−2**    | 0           | multiple  |

A `multi` item scores `+4` only for an *exact* set match. A partial selection
(missing a correct option) or an excess selection (including a wrong one) both
score `−2`. Leaving it blank scores 0.

Schemes live in `settings.schemes` — change the numbers there, or add your own
scheme key and reference it from a question. Each scheme carries a `note` that
is shown as the item callout when the question has no `supplement` of its own.

---

## 4 · Editing `config/settings.json`

### `exam`

| Key | Default | Meaning |
|-----|---------|---------|
| `durationSeconds` | `2700` | Total paper length (45 minutes). |
| `warnAtSeconds` | `600` | Clock turns amber and an advisory toast fires. |
| `criticalAtSeconds` | `300` | Clock turns red and pulses. |
| `clockTickMs` | `250` | UI refresh rate. The countdown is anchored to wall-clock time, so it cannot drift if the tab is throttled. |
| `autoSubmitOnExpiry` | `true` | Force-submit at T‑00:00. |

### `security`

| Key | Default | Meaning |
|-----|---------|---------|
| `maxStrikes` | `3` | Strikes before lockout and forced submission. |
| `redockSeconds` | `10` | Grace window to re-enter fullscreen before a strike. |
| `focusAckSeconds` | `15` | Time to acknowledge a focus-breach alarm before a further strike. |
| `focusDedupeMs` | `1500` | `blur` and `visibilitychange` fire together on a tab switch; this collapses them into one incident. |
| `requireFullscreen` | `true` | Set `false` to run without display containment (rehearsals, projector demos). |
| `blockContextMenu` / `blockClipboard` / `blockSelection` / `blockDrag` / `blockDevtoolsKeys` / `blockReloadKeys` / `blockPrintKeys` | `true` | Individual sandbox switches. |
| `warnOnUnload` | `true` | Native "leave site?" prompt while a paper is live. |
| `logDomCap` | `260` | Log lines kept in the DOM. The full ledger is always retained in memory and exported. |

### `proctoring`

| Key | Default | Meaning |
|-----|---------|---------|
| `enabled` | `true` | Master switch for the analyser. |
| `allowDegradedMode` | `true` | Offer "proceed without optical link" if the camera is refused. The dossier is permanently marked unproctored. |
| `requireBaselineSnapshot` | `true` | Baseline still required before the paper can arm. |
| `sampleIntervalMs` | `250` | Analyser period (~4 Hz). Raise it on low-powered machines. |
| `absenceFrames` | `16` | Consecutive frames without a subject before an absence flag (~4 s). |
| `multiFaceFrames` | `14` | Consecutive frames with a second profile (~3.5 s). |
| `gadgetFrames` | `8` | Consecutive frames with a device-glare signature (~2 s). |
| `flagCooldownMs` | `20000` | Minimum gap between two flags of the same class. |
| `flagsPerStrike` | `3` | Flags of one class before it escalates to a strike. |

### `modules`, `registry`, `briefing`, `meta`

* `modules` — the four subject areas. `id` must match the `catId` used in
  `questions.json`. `code`, `short` and `name` drive the badges, matrix tabs and
  dossier rows.
* `registry` — `idPattern` is a JavaScript regular expression (matched
  case-insensitively) used to validate the registration ID; `idPlaceholder`
  drives both the field placeholder and the format hint. `grades` fills the
  grade dropdown. `defaultSchool` pre-fills the school field.
* `briefing` — the numbered rules on Gate 04. These strings are rendered as
  HTML so `<b>` works; treat the file as trusted content.
* `meta` — event name, round, organiser and build stamp shown across the portal
  and written into every exported dossier.

---

## 5 · The four stages

**Stage 0 — Pre-flight.** Seven diagnostic probes (runtime, display geometry,
`getUserMedia` availability + secure context, fullscreen support, canvas
readback, session storage, network latency), the candidate registry, optical
calibration with a baseline capture, and the protocol briefing. Four gates must
all turn green before the launch button unlocks. A hard capability failure
prints an actionable remedy instead of just failing.

**Stage 1/2 — Live paper.** Sticky mission HUD with countdown, candidate badge
and strike ledger. Left rail: live camera with a subject bounding box, status
chips (subject lock, optical stability, gadget scan), six telemetry meters, the
colour-coded question matrix and the running incident log. Centre: one question
per card with its module, scheme and marks badges.

Keyboard shortcuts during the paper: `←` `→` navigate, `1`–`9` select an
option, `F` toggles the review flag.

**Stage 3 — Audit dossier.** Aggregate score, accuracy, time consumed and
incident count; a module-by-module breakdown; item-level review with the
response, the key, the result and the dwell time for every question; the
baseline snapshot alongside the proctoring statistics; and the complete
timestamped incident log. Export as JSON, print to PDF, or start a new session.

---

## 6 · The audit dossier

**Export JSON dossier** writes
`QUIZZITCH_DOSSIER_<registrationId>_<sessionId>.json` containing `meta`
(including a two-part FNV-1a integrity hash), `candidate`, `result`, `modules`,
`items`, `proctoring`, `diagnostics` and the full `incidents` ledger. This is
the file to collect from candidates and process in bulk.

**Print / Save PDF** opens the browser print dialog against a light,
print-optimised stylesheet — choose "Save as PDF" as the destination. The
document title is temporarily swapped so the suggested filename matches the
JSON export.

Nothing is transmitted anywhere. Both artefacts are produced on the candidate's
own machine, and the portal has no network calls beyond the Google Fonts
stylesheet and one latency probe.

---

## 7 · Deployment

Any static host works — there is no server-side component.

**GitHub Pages**

```bash
git init && git add . && git commit -m "Quizzitch portal"
git branch -M main && git remote add origin <your-repo-url> && git push -u origin main
# Repository → Settings → Pages → Source: main, folder: / (root)
```

If the repo root is the *parent* of `quizzitch-portal/`, the portal is served at
`https://<user>.github.io/<repo>/quizzitch-portal/`. Publishing the contents of
`quizzitch-portal/` as the repo root gives a cleaner URL. All asset paths are
relative, so either arrangement works.

**Vercel** — `vercel deploy` from inside `quizzitch-portal/`, or import the repo
and set the root directory to `quizzitch-portal`. No build command, no output
directory.

**Netlify** — drag `quizzitch-portal/` onto the deploy pane, or set publish
directory to `quizzitch-portal` with no build command.

**Local invigilation on a LAN** — serve over HTTPS, not plain HTTP, or the
camera gate will fail on every machine except the one running the server.

---

## 8 · Browser support and honest limits

Requires a desktop-class browser with `getUserMedia`, the Fullscreen API and
canvas `getImageData`: current Chrome, Edge or Firefox. Safari works but is
stricter about autoplay and fires `afterprint` unreliably. **iPad and iPhone are
not supported** — mobile Safari cannot lock an element to fullscreen, so the
display-containment gate can never be satisfied; the diagnostic sweep says so
explicitly rather than failing silently mid-paper.

Two limits worth stating plainly to anyone relying on this:

**The sandbox is deterrence plus an audit trail, not a lockdown.** A browser
page cannot override the operating system. Alt-Tab, the Windows/Command key,
screenshot hotkeys, a second physical machine and a phone off-camera all remain
outside its reach. What the portal *does* guarantee is that every focus loss,
fullscreen exit and blocked shortcut is timestamped in a ledger the invigilation
panel can read afterwards.

**The optical analyser is a heuristic, not face recognition.** It measures
skin-chromaticity mass, horizontal blob separation, frame-to-frame motion energy
and bright-region geometry. Strong backlighting, unusual lighting, very dark
rooms and busy backgrounds all move its numbers. Flags are advisory signals for
a human reviewer; three flags of one class escalate to a strike, so tune
`flagsPerStrike` and `flagCooldownMs` to the tolerance your panel wants before
running a real round.

---

## 9 · Troubleshooting

| Symptom | Cause and fix |
|---------|---------------|
| "The portal could not load its configuration files" | Opened over `file://`. Serve over HTTP (§1). |
| "The portal failed to start" with a stack trace | A JSON syntax error or an invalid item; the detail names the file and item. |
| Optical device API · **Insecure origin · FAIL** | Serving over plain HTTP on a non-localhost address. Use HTTPS or `localhost`. |
| Fullscreen containment · **Unsupported · FAIL** | Mobile Safari. Use a desktop browser. |
| Session storage · **Volatile fallback · WARN** | Storage is blocked (private mode / hardened settings). Harmless — the baseline lives in memory instead. |
| Network latency · **No probe · local mode** | Offline or the font CDN is blocked. Harmless — the portal runs fully offline; only the web fonts fall back to system faces. |
| Camera engages but presence stays at 0% | Too dark, heavy backlighting, or a virtual camera with no skin tones. Improve the lighting or raise the frontal exposure. |
| Launch button stays disabled | One gate is still grey. Registration ID must match `CC26-QZ-XXXX`, name ≥ 3 characters, grade selected, baseline captured (or the link explicitly waived), acknowledgement ticked. |

---

## 10 · Running a round — checklist

1. Replace every placeholder in `config/questions.json`; verify each `correct`
   array is zero-based.
2. Set `meta.round` and `meta.build` in `config/settings.json`.
3. Serve over HTTPS and load the URL once yourself — the boot panel catches any
   config error immediately.
4. Send candidates the URL plus the browser requirement and the note that a
   working webcam is mandatory.
5. Collect the exported JSON dossiers; the `proctoring` and `incidents` blocks
   are what the panel reviews.

---

Built for AEROSS · Delhi Public School R.K. Puram · CelesteCon 2026
