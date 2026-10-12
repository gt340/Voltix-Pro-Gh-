# Staging readiness and configuration isolation (Phase 2A.2)

Goal: Preview deployments use a dedicated **staging Firebase project** and **Paystack TEST** configuration, while
Production keeps exactly the configuration it has today. Nothing activates until this branch is merged.

## How the isolation works (nothing to change in the game pages)
1. **Build time (`vercel-build` -> `scripts/apply-env-config.js`)**, in both repositories:
   - `VERCEL_ENV=production`: no file is changed. If any `STAGING_*` variable is attached to Production the build FAILS.
   - `VERCEL_ENV=preview`: every deployable `.html/.js/.json` file is rewritten: Production Firebase web config ->
     `STAGING_FIREBASE_WEB_CONFIG`, `pk_live_...` -> `STAGING_PAYSTACK_PUBLIC_KEY`, the Production spin backend host ->
     `STAGING_SPIN_BACKEND_URL`. The build FAILS (nothing is deployed) if any staging input is missing/malformed, any
     page initialises Firebase from an unrecognised source, any page uses Paystack without a recognisable key,
     any Production-only host appears, any Production value would survive, or the server-side staging variables below
     are not approved. Anything else (unknown `VERCEL_ENV`) FAILS.
   - The build log prints per-file coverage (file names and counts only, never values).
2. **Run time (`lib/env-guard.js`)**: `api/verify-payment.js`, the new `/api/*` routes and `spin-backend/server.js`
   answer **503** and never initialise Firebase or Paystack unless the environment is Production (unchanged) or an
   approved staging setup (staging service account declared in `STAGING_FIREBASE_PROJECT_ID`, `sk_test_` secret,
   `AUDIT_PEPPER`). So a Preview that still carries Production credentials cannot write to Production even if built.
3. Duplicate copies: the same script and config file exist in `Voltix-Pro-Gh-` and `voltix-pro-game`; the offline tests
   check that identical pages receive identical treatment.

## Dashboard setup (all values are entered by the project owner; never paste them into chat, tickets or commits)
### A. Staging Firebase project
1. Firebase console > Add project (suggested id `voltix-staging-<random>`). Do not reuse Production.
2. Build > Firestore Database > Create (Native mode). Build > Authentication > Sign-in method > enable **Anonymous**.
3. Authentication > Settings > Authorized domains: add the staging/preview host(s).
4. Firestore > Rules: paste the repository's `firestore.rules` into the **staging** project only.
5. Firestore > TTL: create a policy for collection `rateLimits`, field `ttlAt`.
6. Project settings > General > Your apps > add a **Web app**; copy its config object (used in section C).
7. Project settings > Service accounts > Generate new private key (staging project). Keep the JSON private.
8. Seed fake data only (one test `admins/{uid}` doc, `gameSettings/main` with test prize text).

### B. Paystack test mode
1. Paystack dashboard > toggle **Test mode** > Settings > API Keys & Webhooks: copy the **test** public key (`pk_test_...`) and
   **test** secret key (`sk_test_...`).
2. Same page, Test mode still on: set **Test Webhook URL** to `https://<staging spin-backend host>/api/paystack-webhook`.
   The live webhook URL is untouched. Preview URLs sit behind Vercel sign-in and Paystack cannot reach them: use a stable
   staging alias without that protection, or Vercel "Protection Bypass for Automation".

### C. Preview-only environment variables (set for each project below, target **Preview** only)
| Variable | Value | `voltix-pro-gh` | `voltix-pro-game` | `spin-backend` |
|---|---|---|---|---|
| `STAGING_FIREBASE_WEB_CONFIG` | JSON of the staging web app config: `apiKey, authDomain, projectId, storageBucket, messagingSenderId, appId[, measurementId]` | yes | yes | no |
| `STAGING_FIREBASE_PROJECT_ID` | the staging project id | yes | yes | yes |
| `STAGING_PAYSTACK_PUBLIC_KEY` | `pk_test_...` | yes | yes | no |
| `STAGING_SPIN_BACKEND_URL` | `https://<staging spin-backend host>` (no path) | yes | yes | no |
| `FIREBASE_SERVICE_ACCOUNT` | staging service-account JSON | yes | yes | yes |
| `PAYSTACK_SECRET_KEY` | `sk_test_...` | yes | yes | yes |
| `AUDIT_PEPPER` | random secret, 32+ characters | yes | yes | yes |
Mark the secret ones Sensitive.

### D. Remove Production credentials from Preview
On `spin-backend` and `voltix-pro-game`, the existing `FIREBASE_SERVICE_ACCOUNT` and `PAYSTACK_SECRET_KEY` are one record each
targeting **Production and Preview**. Edit each record and untick **Preview** (keep Production). Create the Preview-only
records from section C. `voltix-pro-gh` already has Production-only records. **Never** attach any `STAGING_*` variable to Production.

### E. Staging spin backend
Deploy `spin-backend` to a stable staging alias (a Preview deployment with a fixed alias). Its Preview-only variables are
the three rows marked for `spin-backend` above; the guard refuses to serve until they are all valid.

### F. Fresh deployments
Variables apply only to builds created after the change. After C-E, redeploy the branch
(`phase2a/staging-gates`) in every project. Do not promote anything to Production.

## Verification (evidence to collect before calling staging isolated)
1. Build logs of each project's latest **Preview** deployment: `[COVERAGE]` lines list every page (including all six
   games) and end with `[CONFIG] Preview build: staging configuration applied ... no Production value remains.`
2. `node scripts/staging-readiness.js` (run in the Preview build/runtime) prints `STAGING READINESS: PASS`.
3. Vercel Environment Variables listing (names and targets only) for the three projects matching sections C and D.
4. Firebase console: the staging project id differs from Production and holds no production data.
5. Paystack dashboard in Test mode showing the test webhook URL.
6. Timestamps: latest Preview deployment is newer than the newest variable in each project.
7. Read-only probe: `GET <staging host>/api/catalog` (writes nothing). Then a staging-only write test: the new document
   appears in the **staging** Firestore and not in Production.
A PASS from offline tests or from the readiness script alone does not prove isolation; items 3-7 are dashboard evidence.

## Known preconditions and risks
- The build hook requires Vercel to serve the project root after `vercel-build` (framework "Other", no Output Directory
  override). This is verified by the first successful staging build; if Vercel reports a missing Output Directory, set it
  to `.` in the project settings before merging.
- Preview builds FAIL on purpose until sections A-D are complete. That is the fail-closed state.
