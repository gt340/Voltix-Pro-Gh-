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
