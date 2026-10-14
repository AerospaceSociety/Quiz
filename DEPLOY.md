# Cloudflare & Firebase Deployment Guide — Quizzitch

This document outlines deployment on **Cloudflare Pages** (Free Tier) and configuration of **Firebase** (Spark Free Plan) for the live screening event.

---

## 1. Cloudflare Pages Deployment

### Prerequisites
- Cloudflare account (Free plan)
- Node.js 18+ and `npm`

### Deploy via Wrangler CLI
1. Log in to Cloudflare:
   ```bash
   npx wrangler login
   ```
2. Set the private Jotform API key as an encrypted secret in Cloudflare Pages:
   ```bash
   npx wrangler pages secret put JOTFORM_API_KEY
   # Enter your Jotform API key when prompted
   ```
3. Deploy the application:
   ```bash
   npm run deploy
   # Or: npx wrangler pages deploy .
   ```
   Note your production URL: `https://quizzitch-portal.pages.dev` (or your custom domain).

### Deploy via GitHub Integration (Alternative)
1. In Cloudflare Dashboard $\to$ **Compute (Workers & Pages)** $\to$ **Create application** $\to$ **Pages** $\to$ **Connect to Git**.
2. Select repository `Quizzitch`.
3. Build Settings:
   - Framework preset: `None`
   - Build command: *(leave empty)*
   - Build output directory: `.`
4. Environment variables:
   - Add `JOTFORM_API_KEY` under **Settings** $\to$ **Environment variables** (Encrypt).

---

## 2. Firebase Console Configuration (Project `quizzitch-14998`)

### Step 1: Authorise Cloudflare Domain for Auth
1. Go to **Firebase Console** $\to$ **Authentication** $\to$ **Settings** $\to$ **Authorized domains**.
2. Click **Add domain**.
3. Add your Cloudflare Pages domain (e.g. `quizzitch-portal.pages.dev`) and any custom domains used.

### Step 2: Restrict Firebase Web API Key (Google Cloud Console)
1. Go to [Google Cloud Console Credentials](https://console.cloud.google.com/apis/credentials) for project `quizzitch-14998`.
2. Locate the Browser API Key matching `FIREBASE_API_KEY_PLACEHOLDER`.
3. Under **Application restrictions**, select **Websites** (HTTP referrers).
4. Add website restrictions:
   - `https://quizzitch-portal.pages.dev/*`
   - `https://*.pages.dev/*` (if using preview deployments)
   - `http://localhost:*` (for local development/testing)
5. Under **API restrictions**, restrict key to:
   - Identity Toolkit API
   - Cloud Firestore API
   - Token Service API

### Step 3: Deploy Firestore Security Rules
Deploy the hardened rules from the repository:
```bash
npx firebase-tools deploy --only firestore:rules --project quizzitch-14998
```
Or paste the contents of `firestore.rules` into **Firestore** $\to$ **Rules** in the Firebase Console and click **Publish**.

### Step 4: Rehearsal Environment
- **DO NOT** conduct large student rehearsals on the production Firebase project on event day, as the Spark plan has a strict 20,000 writes/day quota.
- For rehearsals, create a separate free Firebase project (e.g. `quizzitch-rehearsal`), enable Anonymous Auth and Firestore, and swap `settings.json` $\to$ `firebase` block.
- Alternatively, run local rehearsals with `settings.json` $\to$ `exam.questionSource: "local"` and `firebase.enabled: false`.

---

## 3. Public Asset Verification

When deployed, Cloudflare Pages will serve only:
- Static HTML (`index.html`, `admin.html`)
- Static assets (`styles/*`, `scripts/*.js`)
- Public config (`config/settings.json`)
- Media assets and favicon

The following are strictly blocked by `.assetsignore` and **never** served:
- `config/questions.json` (Seed questions via Admin dashboard; never publish bank file)
- `functions/*` (Runs as Cloudflare Pages serverless runtime)
- `firestore.rules`, `.env.example`, `DEPLOY.md`, `README.md`
- Tooling scripts (`scripts/*.py`)
