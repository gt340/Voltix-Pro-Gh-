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

## Paid purchases blocked by wallet ownership

A Paystack charge may succeed after checkout preflight but before the wallet is credited. If the wallet is then found to be legacy or owned by a different Firebase UID, the backend must not mark the payment as an ordinary failed attempt and must not retry automatic credit indefinitely.

The payment processor records all three records atomically:

- `coinPurchases/{reference}`: `status: recovery_required` and the ownership failure code.
- `paymentEvents/{reference}`: `status: RECOVERY_REQUIRED`; automated workers must not reclaim this event.
- `paymentRecoveryCases/{reference}`: `status: OPEN`, payment reference, reason, phone, shopper UID, and package metadata.

The signed Paystack webhook may return HTTP 200 only after this durable recovery case is committed. If the transaction cannot commit or the worker loses its lease, return a retryable response instead. Repeated webhooks and browser verification attempts must not credit coins, clear the case, or silently convert it to success.

### Support resolution procedure

1. Locate the open case by the exact Paystack reference. Confirm the Paystack transaction is successful, in GHS, and the amount matches a server-defined coin package. Check for duplicate refunds, credits, or prior resolution.
2. Establish whether the purchaser's Firebase UID is the rightful owner of the wallet using the wallet-recovery evidence rules above. A matching phone number or receipt alone does not authorize transferring an existing wallet.
3. If ownership is proven, complete the controlled wallet recovery first. Then use a restricted, audited server-side operation to credit the exact package once and atomically mark the purchase, payment event, and recovery case resolved. The operation must re-read all records in one Firestore transaction, require case status OPEN, require the recovered wallet owner UID to equal the purchase shopper UID, and use a unique resolution ID to prevent duplicate credit.
4. If ownership cannot be established or conflicts remain, do not transfer the wallet or credit coins. Escalate for a refund through the payment provider using the normal finance approval process. Record the refund reference and outcome in the recovery case.
5. Close the case only after the credit or refund is independently verified. Preserve the audit trail.

**Important:** This PR creates the durable recovery queue and customer-facing reference retention. It does not implement the restricted admin credit/refund resolution operation. Until that operation and its audit controls exist, recovery cases require manual investigation and no automated coin credit.

## Referral rewards

Legacy referral codes or referrer wallets without a verified matching `ownerUid` are not eligible for automatic referral rewards. Recovery may restore future eligibility only after the wallet and code ownership checks above. Do not back-pay historical referral bonuses automatically.

## Safety requirements

- No public or client-callable ownership-transfer endpoint.
- No UID overwrite or reassignment.
- No balance changes during ownership migration.
- Every migration must be auditable and idempotent.
- If any evidence conflicts, stop; do not guess.
