# Staging readiness checklist (Phase 2A.1)

Goal: a Preview deployment that can run the new payment code with **test money and test data only**, so that
write-capable endpoints can be exercised without touching Production. Nothing here is activated by merging.

Run `node scripts/staging-readiness.js` inside the Preview build/runtime. It prints PASS or BLOCKED, never prints
secret values or the Firebase project id, and exits non-zero when BLOCKED. PASS covers automated checks only.

## A. Dedicated staging Firebase project
1. Create a NEW Firebase project (suggested id `voltix-staging-<random>`). Do not reuse Production.
2. Enable Firestore (Native mode) and Authentication > Sign-in method > Anonymous.
3. Authentication > Settings > Authorized domains: add the stable staging/preview domain.
4. Deploy the current `firestore.rules` to the staging project (not Production).
5. Create a TTL policy: collection `rateLimits`, field `ttlAt`.
6. Create a service account key for the staging project only. Store it only in Vercel (Section C).
7. Seed only fake data: one test `admins/{uid}` document, `gameSettings/main` with test prize text, no real customers.

## B. Preview web configuration targeting staging  (**currently a BLOCKER**)
The Firebase web config is hard-coded in the page files (`chat.html`, `sneaker.html`, and, from earlier reads,
`foosball.html`, `damii.html`, `kaisa.html`, `ludo.html`, plus the store scripts). A Preview deployment of those pages
would therefore talk to the PRODUCTION Firebase project from the browser. Likewise `pk_live_...` is hard-coded in the
payment pages. The readiness check lists the files and returns BLOCKED until this is solved.
Proposed fix (needs approval, touches the pages): one `firebase-config.js` that every page loads and that selects the
staging web config and the Paystack TEST public key when `location.hostname` is a Preview/staging host, and the
production values otherwise. Production behaviour must remain byte-for-byte the same.

## C. Preview-only environment variables (per project)
Create these with target **Preview only** (optionally restricted to the branch `phase2a/staging-gates`):

| Variable | Value |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | staging project service-account JSON |
| `STAGING_FIREBASE_PROJECT_ID` | the staging project id (the check requires it to match the credential) |
| `PAYSTACK_SECRET_KEY` | Paystack **test** secret key (`sk_test_...`) |
| `AUDIT_PEPPER` | random secret, 32+ characters (keeps stored network hashes unreadable) |

Projects: `voltix-pro-gh`, `spin-backend`, `voltix-pro-game`.

## D. Production credentials excluded from Preview
Today the existing `FIREBASE_SERVICE_ACCOUNT` and `PAYSTACK_SECRET_KEY` records on `spin-backend` and
`voltix-pro-game` are a single record each targeting **both Production and Preview**. Edit each record so its target
is **Production only**, then add the Preview-only records from Section C. Never delete the Production values.
`voltix-pro-gh` already has Production-only records.

## E. Separate test-mode webhook
Paystack Dashboard > Settings > API Keys & Webhooks, with the **Test mode** switch on: set the Test Webhook URL to
`https://<staging-or-preview-host>/api/paystack-webhook` (spin-backend). The live webhook URL stays untouched.
Preview URLs are behind Vercel sign-in, which blocks Paystack. Use a stable staging alias without that protection, or
Vercel's Protection Bypass for Automation. Paystack signs test events with the test secret, so signature checks are real.

## F. Fresh preview deployments
Vercel applies variables only to builds created after the change. After Sections C and D, redeploy the branch
(do not promote anything to Production) and confirm each project's latest Preview deployment is newer than its
newest variable.

## Evidence required to call staging isolated
1. `node scripts/staging-readiness.js` output = PASS, captured from the Preview deployment (not a laptop).
2. Vercel env screenshot or API listing (names + targets only) showing the four Preview-only variables and the
   Production-only targets on the original records, for all three projects.
3. Firebase console showing the staging project id differs from Production, with no production data.
4. Paystack dashboard in Test mode showing the test webhook URL.
5. Timestamps: latest Preview deployment is newer than the newest variable on each project.
6. A read-only probe: on staging, a quote or catalogue call writes only into the staging project (check the staging
   console, and confirm the production console shows no new `paymentIntents`/`rateLimits`).
