# Voltix Pro GH — Arkesel OTP rollout notes

## Current safety state

- `OTP_AUTH_ENABLED` defaults to disabled unless explicitly set to `true`.
- The frontend Arkesel path is separately opt-in through `window.VOLTIX_USE_ARKESEL_OTP === true`; Firebase Phone Auth remains the fallback and is not removed.
- Do not enable it in Production until the owner approves live SMS activation.
- Arkesel OTP generation is a live, billable operation. No test or sandbox request is made by this code.
- The browser receives only a Firebase custom token after server-side Arkesel verification. The Arkesel API key and rate-limit secret must never be added to frontend files.

## Server-side environment variables

Configure these only on the intended Vercel environment:

| Variable | Purpose |
| --- | --- |
| `OTP_AUTH_ENABLED` | Set to `false` until live OTP activation is separately approved |
| `ARKESEL_API_KEY` | Arkesel API key; server-side only |
| `ARKESEL_SENDER_ID` | Approved sender ID |
| `OTP_RATE_LIMIT_SECRET` | Random secret of at least 32 characters for HMAC-hashing phone/IP rate-limit keys |
| `OTP_DAILY_GLOBAL_LIMIT` | Maximum generated OTP requests per UTC day; defaults to 250 |

The default global cap is 250 requests per UTC day. At the quoted GH₵0.035 per OTP generation, that is a nominal ceiling of GH₵8.75 per day before any provider-specific billing differences. Failed delivery attempts may still be charged, according to Arkesel support.

## Firestore retention

The service writes:
- `otpChallenges` with an `expireAt` timestamp 24 hours after creation.
- `otpRateLimits` with an `expireAt` timestamp 48 hours after the last update.

Before live activation, configure Firestore TTL policies on the `expireAt` field for both collection groups. OTP codes are not stored in Firestore; Arkesel generates and verifies them.

## Rollout gates

1. The current branch preview frontend is `https://voltix-pro-gh-git-phase3-ark-abacb9-nekarakodiya-7935s-projects.vercel.app` and its paired backend branch alias is `https://spin-backend-git-phase3-arke-127ac8-nekarakodiya-7935s-projects.vercel.app`. The frontend selects this backend only on that exact preview hostname; other hosts use the Production backend alias. Keep `window.VOLTIX_USE_ARKESEL_OTP` unset/false until the backend preview is READY and its environment is checked. Do not enable OTP in Production.
2. Keep `OTP_AUTH_ENABLED=false` while reviewing the preview build and CI test results.
3. Obtain separate approval before enabling billable OTP requests, including any real-user SMS trial.
4. Verify the resulting Firebase ID token contains the standard `phone_number` claim and the `shopperPhoneVerified` custom claim. The frontend fails closed if either check is absent.
5. Test existing Firebase phone users retain their UID. Do not delete or recreate users to force migration.
6. Do not merge or promote to Production without separate approval.

## Recovery considerations

Phone OTP proves current control of a number; it does not prove continuity of ownership. If a mobile number has been recycled, a new holder could resolve to the old Firebase user by phone and inherit that UID. UID-bound wallet checks do not prevent that specific recycled-number takeover. Before enabling this for accounts with material wallet balances or purchase history, decide on a second factor or a manual recovery step for existing accounts. Do not describe phone-only OTP as protection against recycled-number account takeover.

If Arkesel verification succeeds but Firebase token issuance fails, the challenge is retained in a provider-verified state so token issuance can be retried without re-verifying the already-consumed OTP. A consumed challenge cannot be replayed.
