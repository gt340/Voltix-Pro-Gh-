# Phase 2B.1B — Sneaker Sink Write-Path Audit

Status: AUDIT COMPLETE / IMPLEMENTATION BLOCKED ON SERVER-AUTHORITATIVE GAMEPLAY DESIGN

Scope: `phase2b/firestore-hardening` only. No merge, deployment, Production configuration change, or Production Firestore write was performed.

## Verified client write paths in `sneaker.html`

| Operation | Current client behavior | Security assessment |
|---|---|---|
| User bootstrap | Anonymous sign-in; creates a user document with initial profile fields | Must remain compatible with least-privilege user creation rules |
| Spend solo drop coin | Locally decrements `U.sinkCoins`, then calls Firestore `update({sinkCoins: increment(-1)})` without awaiting confirmation | Not atomic with the game attempt; can desynchronize UI and persisted state |
| Score / prize points | Computes hit and points in browser, then writes `sinkPts`, `sinkGems`, and `sinkTotal` directly | Browser is attacker-controlled; submitted score/reward cannot be trusted |
| Upgrade Power / Aim | Browser computes cost and directly writes `sinkGems`, `sinkPower`, or `sinkAim` | Cost and upgrade caps are enforced only in client code; fields need a trusted transaction |
| Solo leaderboard | Browser writes arbitrary point increments to `sinkLeaderboard/{uid}` | Users can inflate leaderboard entries unless writes move behind trusted server logic |
| Prize claim | Browser creates a `winners` record using its own displayed score and prize setting, then resets `sinkPts` | Score threshold, prize selection, and duplicate claims are not server-verified |
| Online score / drops | Each participant writes their own `hostScore/hostDrops` or `guestScore/guestDrops` | Field ownership helps prevent impersonating the other player, but values and increments remain client-controlled |
| Race join fee | Client first joins the match, then separately decrements the joining user's coins | Match join and fee deduction are not atomic; retries/races can create inconsistent outcomes |
| Race loss fee / win credit | Client decides winner from match values, then locally updates coins or leaderboard | Client can manipulate outcomes or reward side effects; server must settle once |
| Race completion | Host writes `status: finished` and `winner` | Host is a client and can submit a false result |

## Required implementation design

1. Verify Firebase ID tokens on every privileged API request. Derive the UID from the verified token; never trust a request-body UID.
2. Use Firestore transactions and server-generated operation IDs to make spending, upgrades, settlement, and claims atomic and idempotent.
3. Move coin spending and upgrade calculation to the server. Enforce nonnegative balances and server-owned upgrade caps/costs.
4. Do not add an endpoint that accepts a client-supplied score, hit type, winner, prize, or gem award as truth. That would move the trust boundary without fixing the vulnerability.
5. For solo Sneaker Sink, define a reproducible shot protocol and server-side outcome calculation (including bounded input, power/aim, coin type, drift/random seed, and deterministic simulation). The browser must render the server-authoritative result. Until parity and anti-replay tests exist, score/reward writes must remain blocked rather than relaxed in Firestore rules.
6. For multiplayer, settle a match once from server-validated actions/state. Per-player field ownership alone is not sufficient validation. A client must not determine the winner, deduct the loser fee, or award leaderboard points.
7. Restrict winner submissions so a browser cannot invent a win or prize. Separate a verified eligibility/claim record from fulfillment contact details.
8. Add emulator and unit tests for forged score, unauthorized UID, duplicate request/replay, concurrent spending, insufficient balance, upgrade caps/costs, duplicate prize claim, and conflicting match settlement.

## Release gates

- Unit tests and Firestore emulator tests green on both repositories.
- Client write paths no longer mutate protected economy, score, leaderboard, winner, or match-result fields.
- Negative tests demonstrate forged values and duplicate requests are rejected.
- Manual mobile test on a non-production/staging Firebase project.
- Commander review of exact diff and evidence.

## Current conclusion

The existing rules are materially safer than the original rules, but Sneaker Sink is not release-ready. The safe next implementation is a coordinated server-authoritative game-state change, not a permissive rules exception and not an API that trusts client-reported outcomes.

## Implementation progress — 2026-10-16

- Added an authenticated `POST /api/sneaker-action` endpoint. It verifies the Firebase ID token and uses the token UID rather than a body-supplied UID.
- Added transactional, idempotent server actions for `spendDrop`, `upgradePower`, and `upgradeAim`. Costs and caps are calculated server-side.
- Rewired the primary `sneaker.html` client to use the endpoint for solo coin spending and upgrades. The request retries with the same operation ID after a network failure.
- Tightened both repositories' Firestore rules: clients cannot change `sinkPts`, `sinkGems`, `sinkPower`, `sinkAim`, or `sinkTotal`; cannot seed new user documents with forged initial values for those fields; cannot write `sinkLeaderboard`; and cannot create `winners` documents.
- Blocked client score/drop writes for Sneaker Sink online match documents. Online races and prize/scoring persistence are temporarily disabled in the primary client until trusted shot simulation and settlement are implemented.
- Added unit and emulator tests for action transactions, replay protection, upgrade costs/caps, forged score/economy writes, prize forgery, and Sneaker Sink match score forgery.

CI for the latest commits is still running; do not call these changes test-passed until the latest workflow runs finish green. This is not release-ready: shot simulation, score/gem awards, leaderboard updates, prize eligibility/claims, and authoritative multiplayer settlement remain unfinished. No merge or deployment was performed.

## Cross-game win-counter hardening

A further audit found that Foosball, Ludo, Damii and Kaisa clients increment user win counters and leaderboard documents directly. Since browser-computed results are not authoritative, the isolated rules now also deny client writes to `wins`, `ludoWins`, `damiiWins`, `kaisaWins`, and the public scoreboards. New user documents cannot seed those counters with non-zero values. Emulator coverage was expanded to test owner-side forgery attempts. Until server-side result validation is implemented, persistent win/leaderboard credit is intentionally fail-closed; this may mean current clients display a local win but cannot persist the leaderboard result.

## Remaining release blockers after the latest audit pass

- Multiplayer match documents for Foosball, Kaisa, Damii and Ludo still permit participants to submit their own score/drop fields. Field ownership is not proof of a valid match result; those games need trusted result settlement and duplicate-settlement protection before release.
- Spin & Win calls the separately hosted `spin-backend-delta.vercel.app` service. Its backend source is not in this repository, so this branch's rules audit does not establish that spin outcomes, wallet credits, referral bonuses, or prize fulfillment are safe. Audit that backend separately before claiming Spin & Win is secured.
- Server-authoritative solo Sneaker Sink shot simulation and prize eligibility remain unfinished. Current scoring persistence is intentionally disabled.

## Multiplayer score path now fail-closed

The latest rules revision denies browser writes to all match score/drop/winner/finalization fields for every game, not only Sneaker Sink. Match creation requires a waiting room with an empty guest seat and zero-valued initial scores/drops; guests may claim an open seat; hosts may cancel. Trusted server-side result settlement is not yet implemented.

To avoid presenting broken online play as available, the primary repository's Foosball, Ludo, Damii, and Kaisa create/join handlers now show a temporary pause notice. AI/local gameplay remains available, but leaderboard credit and prize submissions remain paused where they depend on unverified client results. This is a deliberate security/availability tradeoff on the isolated branch only.

The newest emulator/static test runs for both repositories are in progress. Do not treat this revision as verified until both finish green. No merge, deployment, Production settings change, or Production Firestore write was performed.

## Client-side game reward writes removed

The Ludo, Damii and Kaisa clients no longer attempt to increment persistent win counters or leaderboard documents after a local win. Their prize-submit handlers now stop locally with a clear paused notice and do not send phone numbers or create prize requests. Foosball's prize-submit handler follows the same behavior in the primary repository. Static regression tests cover these UI paths.

This does not restore win credit or prize claims. Those functions remain unavailable until server-side game outcome validation and idempotent settlement are implemented. Latest CI runs for these newest changes are still pending.
