# QUIZZITCH Candidate Examination Manual & Guidelines
### CelesteCon 2026 — Preliminary Screening
**Organised by AEROSS — The Aerospace Society, Delhi Public School R.K. Puram**  
**Examination Portal:** [https://quiz-ewy.pages.dev](https://quiz-ewy.pages.dev)  
**Document Classification:** Official Candidate Briefing (Public)

---

## 1. Executive Summary & Event Overview

Welcome to **Quizzitch — CelesteCon 2026 Preliminary Screening**, powered by the proprietary Quizzitch Examination Platform. The platform provides a secure, synchronized, and tamper-resistant testing environment equipped with automated AI-assisted invigilation, client-side cryptographic sealing, and offline fault-tolerance.

Please read this document carefully before the examination day. Compliance with all technical and conduct guidelines is mandatory for your score to be valid.

### Key Examination Specifications

| Parameter | Detail |
| :--- | :--- |
| **Event & Edition** | CelesteCon 2026 — 6th Edition |
| **Paper Code** | `CC26-PRELIM-01` |
| **Exam Duration** | **45 Minutes** (2,700 seconds) |
| **Start Buffer** | **+45 Seconds** automatically credited on server start |
| **Total Questions** | **45 Questions** (40 Main Segment + 5 Bonus Segment) |
| **Question Format** | Multiple Choice Questions (Single-choice & Reasoning) |
| **Marking Scheme** | **+3** for Correct · **-1** for Incorrect · **0** for Unattempted |
| **Bonus Segment** | Unlocked *only* if the main paper is submitted early before time expires |
| **Supported Devices** | Desktop or Laptop only (Windows, macOS, Linux, ChromeOS) |
| **Proctoring Standard** | Automated AI Facial Tracking & Browser Lockdown Protocol |

---

## 2. What to Keep Handy (Pre-Exam Checklist)

To ensure an uninterrupted examination, please verify each item in this checklist at least **30 minutes before** your scheduled commencement time:

### A. Hardware & Power
- [ ] **Laptop or Desktop PC:** Mobile phones, iPads, Android tablets, and foldable devices are **strictly prohibited** and will fail hardware calibration.
- [ ] **Working Webcam:** Built-in laptop camera or a functional USB webcam. The camera must be front-facing and unobstructed.
- [ ] **Continuous Power Supply:** Connect your laptop to a live AC power adapter. Do not attempt the exam on battery power alone.
- [ ] **Single Display Only:** Disconnect all external monitors, TV screens, projectors, or HDMI splitters. Multi-monitor setups will trigger immediate security advisories and disqualification.
- [ ] **Functional Keyboard & Mouse/Trackpad:** Ensure all keys (specifically `A`–`D`, `1`–`4`, `M`, and Arrow keys) are responsive.

### B. Operating System & Software Environment
- [ ] **Recommended Web Browser:** Latest version of **Google Chrome** (v115+) or **Microsoft Edge** (v115+).
- [ ] **Close ALL Background Applications:** Completely exit:
  - Communication tools: Discord, WhatsApp Web/Desktop, Telegram, Slack, Skype, Zoom, Teams, Google Meet.
  - Screen recording / streaming software: OBS Studio, Streamlabs, Bandicam, ShadowPlay, GeForce Experience.
  - Virtual camera utilities: ManyCam, DroidCam, EpocCam, Iriun, CamTwist, vCam.
  - Remote desktop software: AnyDesk, TeamViewer, Chrome Remote Desktop, Parsec.
- [ ] **Turn Off Notifications:** Enable **Do Not Disturb** or **Focus Assist** on your operating system to prevent pop-up banners from stealing window focus.
- [ ] **Disable Browser Extensions:** Disable ad-blockers, translation add-ons, auto-copy tools, password manager overlays, and developer extensions, as they can interfere with examination scripts.

### C. Network Connection
- [ ] **High-Speed Internet:** A broadband Wi-Fi or wired Ethernet connection with at least **2–5 Mbps** upload and download speeds.
- [ ] **Emergency Mobile Hotspot:** Keep your phone's mobile hotspot pre-configured on your laptop as a fallback in case your primary broadband router loses power.

### D. Credentials & Verification
- [ ] **School UID:** Provided by your school coordinator or AEROSS (e.g., `CLT-2026-SCH-0101` or `C26-DL-0101`).
- [ ] **Team ID:** Your registered team identifier (e.g., `C26-DL-0101-IPOD` or `CLT-2026-SCH-0101-DISP-T1`).
- [ ] **Candidate Full Name:** As registered in the team roster.
- [ ] **32-Character Access Code:** Your secret candidate claim code issued by the organizing committee.
- [ ] **Student Identity Card:** Keep your school-issued photo ID card on your desk for verification.

---

## 3. Step-by-Step Platform Walkthrough

The Quizzitch portal operates across 6 distinct stages:

```
[ Stage 1: Identification ]
           ↓
[ Stage 2: Hardware & Camera Setup ]
           ↓
[ Stage 3: Synchronized Waiting Lobby ]
           ↓
[ Stage 4: Active Examination Workspace ]
           ↓
[ Stage 5: Submitting Response (DO NOT REFRESH) ]
           ↓
[ Stage 6: Sealed Cryptographic Receipt ]
```

### Stage 1: Identification & Sign-In
1. Navigate to the examination URL: **`https://quiz-ewy.pages.dev`**.
2. Enter your **School UID**, **Team ID**, **Candidate Full Name**, and **32-Character Access Code**.
3. Carefully review the **Academic Integrity & Digital Proctoring Consent** declaration.
4. Check the consent box and click **Proceed to Calibration**.

> [!NOTE]
> **Single Device Lock:** Your credentials can only be active on **one device** at any time. Do not attempt to log in across multiple tabs or computers simultaneously.

---

### Stage 2: Hardware & Camera Calibration
1. Your browser will prompt: *"quiz-ewy.pages.dev wants to Use your camera"*. Click **Allow**.
2. **Lighting & Framing Check:** Position your face directly in front of the lens. Ensure the room is well-lit from the front. Avoid strong backlighting (such as sitting directly in front of an open sunny window).
3. The integrated MediaPipe AI vision engine will verify your video stream. Once your facial geometry is acquired and lighting conditions meet threshold standards, the calibration status will turn green.
4. Click **Enter Kiosk Fullscreen Mode**. The browser will transition into an exclusive fullscreen lockdown view.

> [!CAUTION]
> **Virtual Cameras Prohibited:** The platform automatically inspects video driver descriptors. Any attempt to route feeds through OBS, ManyCam, DroidCam, or virtual video loopers will fail calibration and be logged as an integrity violation.

---

### Stage 3: Synchronized Waiting Lobby
- If you arrive before the official commencement time, you will enter the waiting lobby.
- A live countdown will synchronize with the central examination clock.
- When the invigilation team broadcasts the **Start Exam** release, your paper will instantly load.
- **Server Start Buffer:** A complimentary **45-second grace buffer** is appended on the server so that no student loses time while loading initial question assets.

---

### Stage 4: Active Examination Workspace

Once the test begins, the screen displays:

1. **Top Status Bar:**
   - **Remaining Time:** Visual digital clock. Warns in **amber** at 10 minutes remaining, and pulses **red** with audible ticks during the final 5 minutes.
   - **Candidate Badge:** Displays your name, Team ID, and School UID.
   - **Integrity Status Indicator:** Shows active camera connectivity and current security strike count (0/3).
2. **Module Navigation Tabs:**
   - **General Examination:** Contains 40 core questions.
   - **Bonus Segment (5 Questions):** Locked during normal progression.
3. **Question Canvas:**
   - Question sequence number, question prompt, and any accompanying high-resolution charts, astrophotographs, or scientific schematics.
   - Radio buttons for options **A, B, C, D**.
4. **Action Controls:**
   - **Save & Next (`→`):** Records selection and advances to next item.
   - **Previous (`←`):** Returns to previous item.
   - **Mark for Review (`M`):** Flags question in purple for later revisit.
   - **Clear Selection (`Backspace`):** Deselects the current choice so it remains unattempted (avoiding negative marking).
5. **Question Matrix / Palette:**
   - **Grey:** Unvisited question.
   - **Red / Amber:** Visited but unanswered.
   - **Green:** Answered and saved.
   - **Purple / Flagged:** Marked for review.
   - **Blue Outline:** Currently active question.

---

### Stage 5: Submitting Your Responses

When you have reviewed your answers (or when the clock expires):
1. Click the **Submit Examination** button located in the review panel.
2. A confirmation modal will display your summary: Total Answered, Unanswered, and Marked for Review.
3. Confirm submission.
4. **THE SUBMITTING SCREEN (CRITICAL!):**
   The screen will darken and display:
   > ### Submitting Examination Responses
   > **DO NOT REFRESH OR CLOSE THIS TAB**  
   > *Your answers are being cryptographically sealed and synchronized with the examination server. Please wait...*

   During this window, the client engine:
   - Compiles all recorded responses.
   - Calculates a cryptographic **SHA-256 seal hash**.
   - Transmits the payload to the Cloudflare Functions / Firebase persistence layer.

> [!WARNING]
> **NEVER close the tab or press F5 / Ctrl+R while "Submitting Examination Responses" is visible.** Refreshing during this brief sealing window will interrupt cloud verification. Wait 3–5 seconds until Stage 6 loads automatically.

---

### Stage 6: Sealed Cryptographic Receipt
Upon successful cloud receipt, the portal transitions to the **Exam Sealed** confirmation page displaying:
- **Status:** Officially Received & Authenticated
- **Submission ID:** Unique alphanumeric transaction token
- **Cryptographic Seal Hash:** SHA-256 integrity signature
- **Timestamp:** Precise server-verified UTC/IST submission time
- **Download Confirmation Slip:** Click this button to save or print your official PDF/HTML receipt for your personal records.

---

## 4. Keyboard Shortcuts for Maximum Speed

You can navigate the entire paper rapidly using keyboard shortcuts:

| Key Binding | Function | Note |
| :---: | :--- | :--- |
| **`1` / `2` / `3` / `4`** | Select Option A, B, C, or D | Quick single-key selection |
| **`A` / `B` / `C` / `D`** | Select Option A, B, C, or D | Case-insensitive |
| **`Backspace` / `Delete`** | Clear Selected Option | Reverts question to unattempted |
| **`M`** | Toggle Mark for Review | Flags/unflags current question |
| **`ArrowRight` (`→`)** | Next Question | Advances forward |
| **`ArrowLeft` (`←`)** | Previous Question | Moves backward |

*(Note: The `C` key selects option C; to clear your response, use the `Backspace` or `Delete` key).*

---

## 5. Bonus Segment Mechanics

1. The examination features **40 Core Questions** and **5 Bonus Questions**.
2. The 5 Bonus Questions are an elite tie-breaker tier designed for rapid, high-accuracy solvers.
3. **Unlock Condition:** If you complete and seal the primary 40 questions **before time runs out**, you may unlock the 5 Bonus Questions for the remaining minutes.
4. Bonus questions carry standard scoring (+3 / -1) and are appended to your final score dossier.

---

## 6. Proctoring Protocol & Anti-Cheat Strike Policy

The Quizzitch portal utilizes a strict, multi-layered integrity enforcement system:

```
+-------------------------------------------------------------+
|                     STRIKE SYSTEM RULES                     |
|                                                             |
|   1 Advisory = Minor irregularity noted in audit log        |
|   3 Advisories = 1 Security Strike                          |
|   3 Security Strikes = IMMEDIATE DISQUALIFICATION & SEAL    |
+-------------------------------------------------------------+
```

### Prohibited Actions That Trigger Immediate Strikes or Advisories

#### 1. Tab Switching & Window Minimization (Immediate Strike)
- Switching to another browser tab, opening a new window, or minimizing the browser window triggers an **instant strike with zero grace period**.
- The examination screen will immediately blur under a security privacy shield.

#### 2. Loss of Window Focus / Clicking Outside (5-Second Grace)
- Clicking on desktop icons, system tray notifications, taskbar icons, or secondary software causes the browser to lose focus.
- A **5-second countdown** will appear on screen. If focus is not restored within 5 seconds, a **Strike** is recorded.
- **Cumulative Blur Limit:** If your total cumulative off-focus time exceeds **20 seconds** across the entire exam, or if blur occurs more than **4 times**, an automated strike is issued.

#### 3. Exiting Fullscreen (10-Second Grace)
- Pressing `Esc` or exiting fullscreen mode triggers a full-screen red warning banner with a 10-second countdown.
- You must click **"Re-enter Fullscreen"** before the 10-second timer hits zero, or a Strike will be registered.

#### 4. Blocked Keyboard Hotkeys
The following keys and combinations are blocked and logged:
- **Developer Tools:** `F12`, `Ctrl+Shift+I`, `Ctrl+Shift+J`, `Ctrl+Shift+C`, `Cmd+Option+I`, `Ctrl+U`.
- **Clipboard Actions:** `Ctrl+C`, `Ctrl+V`, `Ctrl+X`, `Ctrl+A`.
- **Page Reloads:** `F5`, `Ctrl+R`, `Cmd+R`.
- **Operating System Keys:** `Alt+Tab`, Windows Key (`Meta`), Mac Command Key, `PrintScreen` (Screenshots).
- **Context Menus:** Right-clicking and text dragging/selection are disabled.

#### 5. AI Facial & Visual Monitoring Rules
- **Absence Flag:** If the candidate's face leaves the camera frame for more than **6 consecutive seconds**, an incident is flagged.
- **Multiple Faces Detected:** If an additional person enters the frame for more than **1.5 seconds**, an incident is flagged.
- **Excessive Gaze Deviation:** Turning your head sideways (yaw > 35°) or looking down away from the screen (pitch > 30°) continuously for more than **6 seconds** triggers an integrity advisory.
- **Feed Freeze Detection:** If your webcam transmits a static, repeating, or frozen image for over 5 seconds, an anomaly is logged.

---

## 7. Troubleshooting & Emergency Procedures

### Scenario 1: "Identity Lock: Credentials Already Active on Another Device"
- **Cause:** You closed your browser without submitting, experienced a sudden reboot, or attempted to sign in on two devices.
- **Solution:**
  1. Do **not** panic. Your attempted responses and timestamps are stored securely.
  2. Contact the **AEROSS Exam Helpdesk** immediately via Discord or WhatsApp.
  3. Provide your **School UID**, **Team ID**, and **Candidate Name**.
  4. The invigilator will verify your identity on the administrator console and trigger an **Identity Lock Release**.
  5. Once released, simply refresh your sign-in page, enter your credentials, and resume your test.

---

### Scenario 2: Camera Calibration Fails or "Camera Permission Denied"
- **Solution:**
  1. Look at the left side of your browser URL bar (near `https://quiz-ewy.pages.dev`). Click the **padlock** or **tune/settings** icon.
  2. Ensure **Camera** is set to **"Allow"** (not "Block" or "Ask").
  3. Ensure no background program (such as Zoom, Microsoft Teams, Skype, or Discord) is currently using your camera. Close those programs via Task Manager or Activity Monitor.
  4. Reload the page (`Ctrl+F5`) and try again.

---

### Scenario 3: Internet Connection Drops or Fluctuation Occurs
- **Solution:**
  1. **Do NOT close or refresh your browser tab.**
  2. Quizzitch is engineered with an **offline-first local outbox**. Every answer you click is cached locally in browser state immediately.
  3. Keep the tab open. As soon as your internet reconnects, the engine will automatically flush the outbox and sync with the database.
  4. If your home broadband fails, immediately switch your laptop Wi-Fi to your phone's mobile hotspot.

---

### Scenario 4: Accidental Fullscreen Exit or Accidental Click Outside
- **Solution:**
  1. A large recovery overlay will appear with a countdown.
  2. Simply click the large **"Re-enter Fullscreen"** or **"Return to Examination"** button immediately before the grace period expires.

---

### Scenario 5: Browser Crash, Laptop Freeze, or Power Outage
- **Solution:**
  1. Quickly restart your computer or reopen your browser.
  2. Navigate back to `https://quiz-ewy.pages.dev`.
  3. If the portal displays *"Session already active on another device"*, immediately notify the helpdesk for an instantaneous lock release.
  4. Once released, sign back in. All previously saved responses will reload seamlessly.

---

### Scenario 6: The "Submitting Examination Responses" Screen Remains Visible
- **Solution:**
  1. **DO NOT PRESS REFRESH OR CLOSE THE TAB.**
  2. The platform performs exponential-backoff retries if there is server latency.
  3. Allow 15–30 seconds for the cloud handshake to finalize.
  4. If a network timeout occurs, an on-screen **"Retry Cloud Synchronization"** button will appear. Click it to re-attempt delivery without losing your answers.

---

## 8. Summary Rules of Conduct

1. **Independent Effort:** All work must be exclusively your own. Any communication with outside individuals, use of secondary devices, or unauthorized reference materials is strictly prohibited.
2. **Audio/Video Hygiene:** Ensure your testing space is quiet, isolated, and well-lit. No other individuals are permitted in the room during the 45-minute window.
3. **Earphones / Headphones:** Wearing headphones, Bluetooth earbuds, or headsets is strictly disallowed unless prior written clearance has been granted by AEROSS for medical reasons.
4. **Finality of Decision:** All telemetry logs, strike reports, and video incident timestamps generated by the platform are audited by the AEROSS Scientific Committee. Their determination on any integrity violation is final and binding.

---

## 9. Official Invigilation Helpdesk Contacts

If you encounter any platform difficulty before or during the examination window, reach out immediately through the official support channels:

- **Helpdesk Email:** `aeross@dpsrkp.net`
- **Official CelesteCon Discord:** `#quizzitch-support` channel
- **Event Lead Coordinator:** Contact details shared in your team briefing packet

---
*AEROSS — The Aerospace Society, Delhi Public School R.K. Puram*  
*CelesteCon 2026 Organizing Directorate · All Rights Reserved.*
