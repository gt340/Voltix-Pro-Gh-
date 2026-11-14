# Legacy Shopper Wallet Recovery

## Policy

A legacy wallet is a phone-keyed `wallets/{phone}` document with no valid `ownerUid`. It is locked from shopper reads and writes until ownership is established. The API must not infer ownership from a matching phone number alone.

**Do not build an automatic self-service claim endpoint.** A verified phone proves current control of a number, not necessarily historical ownership; Ghanaian mobile numbers can be reassigned.

## Evidence required before migration

An administrator must establish all of the following:

1. The claimant has a currently verified Firebase phone identity. The canonical phone derived from the verified Firebase ID token exactly matches the wallet document ID.
2. There is independent historical evidence linking the claimant to the old wallet, preferably a historical purchase record with a trusted `shopperUid` matching the current Firebase UID. A Paystack reference/receipt can support investigation, but a phone number or screenshot alone is not sufficient.
3. No conflicting Firebase UID, payment record, support case, or prior recovery exists for the same phone/wallet.
4. The wallet balance and relevant purchase/referral history have been reviewed before any ownership field is changed.

If the historical identity cannot be established, do not transfer the wallet. Escalate for manual support review and leave the wallet locked.

## Controlled admin migration

This is an operational procedure, not a public API:

1. Verify the claimant through the normal Firebase phone-auth flow.
2. Review the evidence above using trusted server-side/admin access. Never ask the claimant to send an ID token or service-account credential to support.
3. Record an audit entry in a restricted admin/audit collection containing: wallet phone, old owner state (missing), new Firebase UID, reviewer UID, evidence reference(s), reason, timestamp, and a unique recovery case ID. Do not store OTPs, ID tokens, passwords, or full payment credentials.
4. In one Firestore transaction, re-read the wallet and verify that `ownerUid` is still absent. If it is already set, stop and investigate; never overwrite an existing UID. Set only `ownerUid` and the recovery metadata. Preserve coins, spend totals, starter-claim flags, and other wallet fields unchanged.
5. For each legacy referral code, verify that its code document points to the same phone and the recovered wallet. Only then set the missing code `ownerUid` to the recovered UID. Never change a code that already has a different owner UID.
6. Re-run wallet lookup and referral-code checks using the recovered Firebase account. Verify that another UID receives 409 from the API and is denied direct Firestore reads.
7. Keep the audit record and close the case only after verification.

## Legacy purchases

A purchase without `shopperUid` must not be automatically credited, even if the Paystack customer phone matches. Investigate the payment reference and historical account evidence separately. Do not modify a confirmed purchase or replay a payment just to attach an owner. If ownership remains uncertain, leave the purchase unresolved and do not credit coins.

## Referral rewards

Legacy referral codes or referrer wallets without a verified matching `ownerUid` are not eligible for automatic referral rewards. Recovery may restore future eligibility only after the wallet and code ownership checks above. Do not back-pay historical referral bonuses automatically.

## Safety requirements

- No public or client-callable ownership-transfer endpoint.
- No UID overwrite or reassignment.
- No balance changes during ownership migration.
- Every migration must be auditable and idempotent.
- If any evidence conflicts, stop; do not guess.
