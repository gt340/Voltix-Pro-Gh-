# Voltix Pro GH — Arkesel OTP rollout notes

## Safety state

- The server exposes Arkesel OTP endpoints only when `OTP_AUTH_ENABLED=true` is set in that deployment environment.
- Keep `OTP_AUTH_ENABLED=false` in Preview and Production until the owner separately approves a controlled SMS test.
- Arkesel OTP generation is a live, billable operation. Automated tests use mocked HTTP responses and do not contact Arkesel.
- Firebase Phone Authentication / Firebase SMS is not part of the Arkesel flow. Do not restore it as a fallback.
- The browser receives a Firebase custom token only after the server verifies the Arkesel challenge.
- Shopper sign-in on the designated Vercel Preview host uses the staging Firebase Auth project; store/admin/referrer services remain on their existing Firebase app.
- Preview CORS is restricted to `OTP_ALLOWED_ORIGIN`; set it to the stable frontend branch alias, not a temporary deployment URL.
- The Arkesel API key and OTP rate-limit secret must never be added to frontend files or committed to Git.

## Required server-side environment variables

| Variable | Purpose |
| --- | --- |
| `OTP_AUTH_ENABLED` | Explicit activation gate; keep `false` until live SMS is separately approved |
| `ARKESEL_API_KEY` | Arkesel main API key; server-side only |
| `ARKESEL_SENDER_ID` | Approved sender ID (1–11 characters) |
| `OTP_RATE_LIMIT_SECRET` | Random secret of at least 32 characters used to HMAC-hash phone/IP rate-limit keys |
| `OTP_DAILY_GLOBAL_LIMIT` | Maximum generated OTP requests per UTC day; defaults to 250 |
| `OTP_ALLOWED_ORIGIN` | Exact HTTPS origin of the frontend Preview branch alias; required for browser API calls |

The Arkesel API key already reported as Preview-only is not sufficient by itself. The sender ID and rate-limit secret must also exist in Preview before the OTP service can initialize. Do not paste any secret into chat.

## Firebase custom-token signing

Preview uses the dedicated staging service account:
`voltix-staging-backend@voltix-pro-gh-staging.iam.gserviceaccount.com`.

The Firebase Admin SDK is configured with this explicit `serviceAccountId` so custom tokens use Google-managed signing rather than a downloaded private key. The WIF identity must have `iam.serviceAccounts.signBlob` permission on that service account (normally via `roles/iam.serviceAccountTokenCreator`). The service account also needs Firebase Authentication permissions for user lookup/create and custom-claim updates (normally `roles/firebaseauth.admin`). Neither grant has been applied by this code change; verify and explicitly approve the exact IAM bindings before token-signing or Auth mutation tests. Do not create or upload a service-account JSON key.

## OTP lifecycle and limits

- OTP expiry: 5 minutes.
- Resend cooldown: 60 seconds per phone.
- Per-phone generation limit: 5 per hour.
- Per-IP generation limit: 20 per hour.
- Global generation budget: 250 per UTC day by default.
- Verification attempts: maximum 5 per challenge.
- Challenge IDs are random UUIDs; OTP values are not stored in Firestore.
- A consumed challenge cannot be replayed.
- If Arkesel verification succeeds but Firebase token issuance fails, the challenge is retained as provider-verified so token issuance can be retried without re-verifying the consumed OTP.

The service writes `otpChallenges` with an `expireAt` timestamp 24 hours after creation and `otpRateLimits` with an `expireAt` timestamp 48 hours after the last update. Configure Firestore TTL policies for the `expireAt` field on both collection groups before live activation. Until then, expired records remain stored even though application-level expiry checks still apply.

The current default global cap is 250 generated OTPs per UTC day. At the previously quoted GH₵0.035 per request, that would represent a nominal maximum of GH₵8.75 per day. Confirm current Arkesel pricing and account balance before enabling live requests; failed delivery attempts may still be charged.

## Identity and wallet ownership

- Arkesel verifies possession of the submitted Ghana phone number.
- After successful verification, the backend looks up the Firebase Auth user by canonical E.164 phone number and reuses that user's UID. It creates a user only when no account exists for that phone.
- The backend persists the `shopperPhoneVerified=true` custom claim on the Firebase Auth user (preserving unrelated claims), then issues a custom token. This ensures the claim survives ID-token refresh.
- Wallet routes require both the standard Firebase `phone_number` claim and the server-issued `shopperPhoneVerified` claim, then enforce the existing `ownerUid` match.
- Existing wallet records are never migrated, reassigned, or rewritten by the OTP flow.

Phone-only OTP does not prove continuity of ownership if a carrier recycles a phone number. Accounts with material wallet balances or purchase history may need an additional recovery factor or manual recovery process before production rollout.

## Remaining rollout gates

1. Confirm the staging Firebase Web App configuration and configure the Preview frontend to use the staging Firebase project, not the production project.
2. Confirm the stable Preview branch aliases and set `OTP_ALLOWED_ORIGIN` to the frontend alias; CORS must not use a wildcard.
3. Verify the WIF service account can call IAM `signBlob` and has Firebase Authentication user-management/custom-claims permissions; no IAM role changes are included in this branch.
4. Keep `OTP_AUTH_ENABLED=false` while reviewing Preview build and automated test results.
5. Run a mocked end-to-end flow and verify the resulting Firebase ID token contains the correct `phone_number` and `shopperPhoneVerified` claims.
6. Obtain separate approval before enabling billable OTP requests or sending a real-user SMS.
7. Do not merge or promote to Production without separate approval.
