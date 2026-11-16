# Phase 2B.2 — Spin Backend Security Hardening

## Scope and release state

Changes are isolated to branch `phase2b2/spin-backend-hardening`. No production deployment, Vercel configuration, secret rotation, Firestore production write, or merge was performed.

## Implemented on this branch

- Starter-coin claim now checks and sets `claimedFreeSpin` inside one Firestore transaction, preventing concurrent duplicate claims for the same wallet document.
- Spin balance deduction, daily cap counter, and spin-record creation now happen in one Firestore transaction. The daily counter is stored on the wallet by UTC day and fails closed when the transaction fails; the previous query failure path that reset the daily count to zero is removed.
- Winner fulfillment now requires a valid Firebase ID token whose UID has a document in `admins`; the winner ID is validated and failures return bounded error responses.
- The recorded spin prize is resolved after earpod eligibility is checked, so the persisted spin record matches the result returned to the client.
- Added static regression tests and a package test script.

## Critical blocker not resolved

The current shopper identity model in `spin.html` relies on `currentUser` read from browser `localStorage` in `app.js`; it does not establish a Firebase Auth identity for normal shoppers. The spin backend's `/api/wallet`, `/api/spin`, `/api/claim-free-spin`, and `/api/spin-referral-code` still accept a caller-supplied phone number. Therefore a caller can potentially impersonate a phone-number wallet. Input validation and transactional updates do **not** prove ownership of that phone number.

Do not deploy this branch as a complete security fix. The next required design decision is to establish a server-verifiable user identity (for example, verified Firebase phone authentication, or a server-issued session following OTP verification), then bind wallet operations to the verified identity rather than a request-body/query phone number. The browser must be migrated consistently before requiring ID tokens on these routes; simply turning on token enforcement now would break current shoppers.

## Additional release blockers

- `/api/spin-referral-code` still accepts a phone number without proof of ownership; referral code creation should be tied to the authenticated UID and created transactionally.
- Spin reward delivery to Reloadly and fulfillment queue writes occur after the coin deduction transaction. A provider or Firestore failure can leave a charged spin with a failed reward; this needs an idempotent reward/outbox workflow and reconciliation.
- `sendReloadlyData` still contains placeholder pricing and does not select a real data-plan ID. Do not treat data prizes as production-ready until operator/product mapping and real provider responses are verified.
- Admin ID-token authorization is implemented for winner fulfillment, but the actual admin UI call path and credentials must be verified in staging.
- No real Paystack or Reloadly calls, production Firestore writes, or live prizes were tested.

## Validation required

Run `npm test` and `node --check server.js` from `spin-backend/`, inspect CI, then test against an isolated Firebase project and Paystack/Reloadly sandbox credentials. Keep the branch unmerged until the phone-ownership architecture and reward outbox are addressed.
