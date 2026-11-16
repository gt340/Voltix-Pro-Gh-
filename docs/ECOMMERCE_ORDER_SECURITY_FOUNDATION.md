# Voltix Pro GH — Ecommerce Order Security Foundation

Status: approved implementation baseline
Branch: feature/ecommerce-order-security-foundation
Base: main (read-only snapshot at implementation start)

## Approved business policies

1. Inventory: reserve stock temporarily at order creation. Default reservation TTL is 15 minutes. Confirm the reservation after successful payment; release expired or failed reservations. COD orders reserve stock under an explicit pending-confirmation state and must not be represented as paid.
2. Referral balance: allow both full and partial application. The backend must atomically validate and debit the available balance with order creation, record immutable ledger entries, and support deterministic reversal on failed/expired checkout.
3. Guest checkout: remain enabled. Generate a cryptographically secure, high-entropy order-access secret; persist only a strong hash; require proof of the secret for private guest lookup. An order reference or phone number alone is not authorization.

## Security invariants

- The backend is authoritative for product prices, variants, stock, delivery fees, discounts, referral balance, order totals, payment state, and fulfilment state.
- Never trust browser-submitted totals, Paystack callback success, localStorage, order references, or customer phone numbers as proof of payment or order ownership.
- Paystack initialization and verification are server-side. Webhooks must be signature-verified against the raw request body and processed idempotently.
- Separate paymentStatus from fulfilmentStatus. COD remains unpaid until collection is confirmed.
- Client Firestore access to private orders, payment attempts, order-access credentials, inventory reservations, referral ledger entries, coupon redemptions, and audit events must be denied. Admin access is mediated by verified backend authorization.
- Do not weaken unrelated game-wallet security or merge existing draft PRs as a shortcut for ecommerce work.

## Work packages

1. Catalogue and inventory model: authoritative product/variant validation, stock-on-hand, reserved quantity, reservation TTL and expiry/release.
2. Order API: server-side validation and pricing, immutable item price snapshots, unpredictable order references, idempotency.
3. Referral accounting: immutable credit/debit/reversal ledger; full and partial payment; concurrency-safe balance checks.
4. Paystack: server-side initialization and verification, raw-body webhook signature verification, durable inbox, idempotent reconciliation.
5. Guest tracking: hashed high-entropy access secret, rate-limited lookup, no reference-only or phone-only access.
6. Admin APIs: verified admin authorization, audited order status transitions, no privileged browser writes.
7. Frontend migration: checkout, success page, order history and tracking consume authoritative APIs; browser state is display cache only.
8. Firestore rules: deny direct client reads/writes to private financial/order records; preserve only explicitly required public catalogue reads.
9. Staging acceptance: emulator, concurrency, tampering, duplicate request/webhook, payment interruption, expiry, refund/reversal, and admin authorization tests.

## Required acceptance tests

- Competing reservations for the final unit: at most one succeeds.
- Expired reservation: inventory becomes available exactly once.
- Client price/quantity/delivery/coupon tampering: backend rejects or recalculates from trusted data.
- Duplicate checkout with the same idempotency key: one logical order and one set of financial effects.
- Full referral coverage: no Paystack charge; partial coverage: only remaining amount is initialized with Paystack.
- Concurrent referral debits: balance never becomes negative and no debit is duplicated.
- Failed/expired order: referral debit and stock reservation are reversed exactly once.
- Forged browser callback: payment remains unverified.
- Duplicate/out-of-order Paystack webhooks: no duplicate payment or fulfilment.
- Guest reference guessing or phone-only lookup: denied.
- Shopper A attempting to access Shopper B's order: denied.
- COD order: unpaid until collected.
- Admin status change: authenticated, validated transition with an audit record.

## Release boundaries

This branch is isolated from main. No merge, production deployment, production Firestore migration, live Paystack transaction, or real customer SMS is authorized by this approval. Staging operations that contact external payment or messaging providers require a separate explicit approval before execution.

Implementation must proceed in small reviewable commits. Each work package must include tests and a Commander Report identifying changed files, exact commit SHA, test evidence, remaining risks, and any staging requirements.
