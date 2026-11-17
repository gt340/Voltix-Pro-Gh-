# Voltix Pro GH Ecommerce Checkout Security

Status: implementation baseline  
Branch: feature/ecommerce-checkout-security  
Base: main  
Scope: ecommerce checkout, order ownership, inventory reservation, referral accounting, Paystack confirmation, guest tracking, and admin order operations.

## Approved business policies

1. Inventory is reserved temporarily when an order is created. The initial reservation TTL is 15 minutes and must be configurable server-side. Expiry releases only the stock reserved by that order. A successful verified payment converts the reservation into a committed stock deduction. COD orders use an explicit reservation/confirmation policy and do not become paid merely because an order exists.
2. Referral balance can cover all or part of an order. The backend calculates the applied amount and atomically records the debit with order creation. Failed or expired checkout must have a deterministic reversal path. Every credit and debit is represented by an immutable ledger entry; balances are derived/maintained transactionally and cannot be edited by the browser.
3. Guest checkout remains available. Each guest order receives a cryptographically random access secret with sufficient entropy. Only a one-way hash is stored. Order reference, phone number, email, and localStorage are not authentication credentials.

## Non-negotiable trust boundaries

- Browser values are untrusted, including item prices, totals, delivery fees, discounts, coupon status, referral balance, payment status, order status, and Paystack callback data.
- The backend reads authoritative product, variant, stock, coupon, and referral records and calculates all monetary amounts.
- All money is represented as integer pesewas (GHS minor units) at API and persistence boundaries. Floating-point browser arithmetic is never authoritative.
- Paystack success is established only by server-to-server verification and/or a valid signed webhook, with amount, currency, reference, and order binding checked.
- Webhook processing and checkout requests are idempotent. Duplicate callbacks, retries, and concurrent requests must not double-charge, double-debit, double-credit, or double-deduct stock.
- Payment state and fulfilment state are separate state machines. COD remains unpaid until collection is confirmed.
- Private order, payment, access-secret, referral-ledger, and audit data are never exposed through broad client Firestore reads.
- Admin operations require server-verified Firebase identity plus the server-side admin allowlist. Client-side admin UI checks are not authorization.

## Target data model

- Inventory WP1 now preserves the existing catalogue fields: product-level `stock`, `lowStockThreshold`, and per-variant `stock`. The backend-only inventory module adds `reservedStock` counters at the same product/variant level. Available stock is `stock - reservedStock`; reservation does not decrement physical stock, while verified commit decrements stock and reservedStock together. Products with missing/unconfigured stock or malformed existing reserved-stock counters fail closed for reservation. Existing legacy catalogue documents are not automatically assigned stock values.
- `orders/{orderId}`: schemaVersion, orderRef, customer delivery snapshot, shopper UID when authenticated, item price snapshots, subtotal/delivery/discount/referral/total amounts in pesewas, currency, paymentMethod, paymentStatus, fulfilmentStatus, timestamps, reservation expiry, and idempotency key.
- `orderAccess/{orderId}`: hash of guest access secret, creation/expiry metadata, and revocation metadata. Never store the raw secret.
- `inventoryReservations/{reservationId}`: order ID, product/variant quantities, status, expiry, and idempotency metadata.
- `orderPayments/{paymentId}`: order ID, provider reference, expected amount/currency, verification state, provider metadata minimised to what is required, and timestamps.
- `referralLedger/{entryId}`: referrer UID, order ID, immutable debit/credit amount, currency, reason, idempotency key, and timestamp.
- `couponRedemptions/{redemptionId}`: coupon/order binding, discount snapshot, and idempotency key.
- `orderEvents/{eventId}`: append-only state transition/audit events.
- `orderIdempotency/{key}`: request hash, order ID, and result state.
- `adminAuditLogs/{eventId}`: actor UID, action, target, reason, and timestamp.

The exact schema and collection names must be reconciled with existing production data before migration. Do not rename or repurpose legacy collections blindly.

## Target API surface

- `POST /api/orders`: validate cart, delivery, coupon and referral use; reserve stock; create pending order; return order reference and guest access secret once.
- `POST /api/orders/:orderId/paystack/initialize`: initialize Paystack server-side for the outstanding amount.
- `POST /api/orders/:orderId/payments/verify`: verify a reference server-to-server; idempotently transition payment state.
- `POST /api/webhooks/paystack`: verify signature against raw body, persist receipt durably, and process idempotently.
- `POST /api/orders/lookup`: verify guest secret or authenticated ownership before returning limited order information.
- `PATCH /api/admin/orders/:orderId/status`: verify admin identity, validate allowed fulfilment transition, and append audit event.
- Internal reservation expiry/reconciliation worker: release expired holds and reconcile interrupted payment/referral operations. It must be safe under duplicate execution.

`POST /api/orders`, Paystack initialization, payment verification, and the shared signed Paystack webhook dispatcher are implemented on the feature branch. The secure guest/authenticated lookup API and core admin order APIs are implemented; the expiry/reconciliation worker and frontend migration remain outstanding.

## State and transaction rules

- Order creation must atomically validate and reserve stock, apply referral debit if selected, and create the order/idempotency records. If a required write cannot commit, none of those effects may partially persist.
- External Paystack calls cannot be included in a Firestore transaction. Use explicit pending/initializing/verification states and retryable reconciliation.
- Verified payment converts a valid reservation to committed stock exactly once.
- Expired unpaid orders release stock and reverse any referral debit exactly once, subject to an auditable policy for orders with uncertain provider status.
- Refunds and cancellations use compensating ledger/events; never rewrite or delete financial history.
- COD orders are created with paymentStatus=PENDING or UNPAID and fulfilmentStatus=AWAITING_CONFIRMATION (exact enum names to be finalised in implementation).

## Migration and release constraints

- Preserve current main and all existing PR branches; this feature branch is isolated.
- Back up and classify legacy orders, payments, coupons, referrers, balances, and inventory before migration.
- Do not infer historical payment success from a browser order record or WhatsApp message.
- Do not automatically assign legacy orders to a shopper solely by matching a phone number.
- Do not lock down client Firestore access until all required storefront/admin flows have moved to trusted APIs and emulator tests prove the migration.
- Use staging Firebase/Paystack credentials and staging data for integration tests. No production writes, live payment attempts, live SMS, production rule deployment, merge, or production deployment without separate explicit approval.

## Required acceptance tests

1. Concurrent reservation attempts for the final unit: exactly one succeeds.
2. Reservation expiry: only the expired order's held quantity is released; repeated expiry processing is harmless.
3. Browser price/quantity/delivery/coupon/referral tampering: backend recalculates or rejects.
4. Duplicate order submission with same idempotency key: one logical order and one reservation.
5. Full referral payment: no Paystack initialization; exactly one ledger debit.
6. Partial referral payment: Paystack receives only the remaining amount; exactly one ledger debit.
7. Concurrent referral spending: balance never goes negative.
8. Failed/expired payment: referral reversal and stock release occur at most once.
9. Forged Paystack callback: order remains unpaid.
10. Duplicate and out-of-order webhooks: no duplicate payment or inventory effects.
11. Cross-shopper order lookup and Firestore reads: denied.
12. Guest order lookup without valid secret: denied; secret hash never returned.
13. COD order: remains unpaid until collection confirmation.
14. Admin status update: non-admin denied; admin action audited.
15. Interrupted worker/reconciler: retry converges without duplicate financial effects.

## WP1 implementation status

- Added `spin-backend/ecommerce/inventory.js` with transactional reserve, release-after-expiry, and commit operations.
- Added `tests/ecommerce-inventory.test.js` covering concurrent final-unit reservation, idempotency, variant stock, unconfigured stock, expiry release, commit, and invalid transition timing.
- Added the inventory regression file to the root `npm test` script.
- This module is not yet wired into checkout APIs or an expiry worker. It must not be called directly by browsers. The tests also cover malformed reserved-stock counters and invalid product document paths. They are validated by GitHub Actions run 43964450571 (63/63 total regression tests passed on the latest feature-branch commit).

## WP2 implementation status

- Added `spin-backend/ecommerce/orders.js` and exposed `POST /api/orders` from the existing Express backend.
- The API accepts product IDs, optional variant IDs, quantities, customer delivery details, payment method, delivery method, coupon code, and an idempotency key. It does not accept client prices or totals as authoritative inputs.
- Product and variant prices are read from Firestore and converted to integer pesewas. Standard delivery is configured as free; express delivery is GHS 35 and is restricted to Accra city, matching the existing storefront's stated policy. These constants preserve the existing storefront policy and must remain server-controlled.
- Inventory counters, the reservation record, order, guest access hash, coupon-capacity hold, and idempotency record are now written in one Firestore transaction. Product prices and stock are read in that same transaction; failed transactions leave no partial reservation or order.
- Idempotency records prevent duplicate logical orders and reject a reused key with a changed request. Guest orders must provide a client-generated canonical 256-bit base64url access secret with the idempotency key; only its SHA-256 hash is persisted. Retrying with the same key and secret returns the same secret in the response without persisting plaintext. Authenticated requests may provide a Firebase ID token and are associated with its verified UID.
- Coupon validation is performed against the server-side coupon document. Capacity is reserved through `reservedUses`, not counted as a completed redemption. A later verified-payment transition must convert the reservation to `usedCount`, and expiry/cancellation processing must release it. That transition and worker are not implemented yet.
- New orders are explicitly `UNPAID`. COD orders use `AWAITING_CONFIRMATION`; online payments use `AWAITING_PAYMENT`. `POST /api/orders` does not initialize or confirm payment; the separate ecommerce payment module owns those transitions.
- Added `tests/ecommerce-orders.test.js` for server-side pricing, guest-secret hashing, idempotency, coupon capacity and malformed coupon metadata, stock shortage, COD and express-delivery rules, concurrent final-unit order creation, and variant-specific pricing/stock. WP1 tests cover reservation lifecycle, concurrent final-unit reservations, immediate cancellation, malformed reserved-stock counters, and invalid product document paths.
- Added `.github/workflows/ecommerce-security-tests.yml` to run the root regression suite on pushes to this feature branch and pull requests. The suite has executed successfully on commit `9587a4e504dd72883cc578774afde5b0f31c1a81`: 63 tests passed, 0 failed (GitHub Actions run 43964450571).

WP2 backend regression tests are passing, but WP2 remains **partially implemented** until the checkout frontend is migrated to this API and the real Firestore transaction behavior is validated in a staging emulator/project. Paystack initialization/verification and coupon-hold commit are implemented in WP4. Coupon-hold release on expired or cancelled orders remains assigned to the expiry/reconciliation worker.

## Delivery order

WP1 inventory/data model; WP2 trusted order API and idempotency; WP3 referral ledger and atomic debit; WP4 Paystack initialization/verification/webhook integration; WP5 guest tracking; WP6 admin APIs; WP7 frontend migration; WP8 Firestore rules lockdown and legacy migration; WP9 staging acceptance and release report.

Each work package must include code review, automated tests, and a rollback/recovery note before it is considered complete.


## WP2 source audit and implementation reconciliation

### Existing checkout contract confirmed
- Browser cart line shape is `id`, optional `variantId`, `qty`, plus display-only `name`, `price`, `image`, and `lineId`.
- The authoritative catalogue is Firestore `products/{productId}`. Existing client code reads `product.price` and, for variants, `variant.price`; the cart's `price` is therefore not authoritative.
- Variant selection is represented by `variantId`; the checkout request must send product ID, variant ID, and quantity only for pricing/inventory decisions.
- Existing delivery options are `standard` (GHS 0) and `express` (GHS 35, Accra only). These must be revalidated server-side; the browser's stored `voltixCheckoutSummary` is untrusted.
- Existing coupon fields used by the UI are `code`, `active`, `expiresAt`, `maxUses`, `usedCount`, `minOrder`, `type` (`fixed` or percentage), and `value`. The backend must re-read the coupon and calculate the discount; browser `discount` and `total` are untrusted.
- Existing referral balance records are `referrers/{uid}` with `code` and `balance`. The checkout currently looks up by code and debits in a separate browser transaction. WP3 must replace that path with an authenticated UID-bound atomic ledger operation.
- Existing checkout directly creates a browser Paystack reference, passes a browser-calculated amount, and treats the inline success callback as payment confirmation. This path must be removed during WP4 frontend migration, not merely wrapped with a new order API.
- Existing order writes are browser-side `VDB.saveOrder`; admin order listing subscribes to the whole `orders` collection. Both require migration before WP8 rules lockdown.

### WP2 implementation gates
- Catalogue stock values are not provisioned/validated by this source audit. The WP1 inventory module intentionally fails closed when product or selected variant stock is absent. Before enabling checkout integration, run a read-only inventory data audit and classify products with missing, malformed, or negative stock.
- The admin product editor writes `active` and `out-of-stock` status values; the backend rejects non-empty status values other than `active`. A read-only catalogue audit is still required to detect legacy or unexpected status values before rollout.
- The backend order API must use the Firebase Admin SDK already initialized in `spin-backend/server.js`, but route handlers must be isolated for unit testing and must not perform provider calls inside Firestore transactions.
- Existing coupon redemption rules are insufficient as an authority boundary: public reads and anonymous increments are allowed in Firestore. Backend validation and transactional redemption must replace browser writes before rule lockdown.
- The feature-branch `POST /api/orders` endpoint is implemented but not yet wired into the storefront. No live checkout, Paystack payment, production data, or Firestore rules have been changed.

## WP3 referral ledger implementation status

- `POST /api/orders` now accepts `referralCreditPesewas` as an integer minor-unit request. Referral balance use is rejected for guests and is bound to the verified Firebase UID; the browser cannot select another referrer's account.
- The server reads `referrers/{uid}` inside the same Firestore transaction that creates the order, reserves inventory/coupon capacity, and writes idempotency state. It validates available balance and that the requested credit does not exceed the pre-referral order total.
- The requested referral debit reduces the server-calculated amount due and the referrer's GHS balance atomically. A deterministic `referralLedger/{orderId}_debit` entry records the amount in pesewas, UID, idempotency key, and post-debit balance. Retries return the original order and do not debit again.
- Added `reverseReferralDebit` as a trusted backend primitive. It restores the original debit once, writes a deterministic `_reversal` ledger entry, and records reversal metadata on the order. It is not exposed as a public route and must only be called by a trusted cancellation/refund/expiry workflow after that workflow has established that reversal is authorized.
- Added tests for authenticated debit, guest rejection, UID ownership, insufficient balance, idempotency, concurrent spending, reversal, and duplicate reversal. GitHub Actions run 43964450571 passed 63/63 tests.
- WP3 is **partially implemented**, not end-to-end complete: the expiry/reconciliation worker and verified-payment/cancellation workflow do not yet invoke the reversal primitive; ledger Firestore rules and staging Firestore transaction validation remain outstanding. The current storefront still performs its legacy client-side referral debit and has not been migrated.

## WP4 Paystack integration status

- Added `spin-backend/ecommerce/payments.js` and routes `POST /api/orders/:orderId/paystack/initialize` and `POST /api/orders/:orderId/payments/verify`.
- Initialization reads the server-created order, requires a valid email for provider-funded balances, uses the order's remaining integer-pesewa amount and GHS currency, and generates the Paystack reference on the server. The browser cannot choose the amount or reference. Initialization is lease/idempotency guarded per order.
- Guest initialization and verification require the original 256-bit guest access secret; the backend compares its SHA-256 hash with `orderAccess/{orderId}` using a timing-safe comparison. Authenticated orders require the matching verified Firebase UID.
- Verification calls Paystack server-to-server and binds the returned reference, successful status, amount, currency, and metadata (`orderId` plus purpose) to the stored order payment record. It commits the inventory reservation only after verification, then transitions payment and coupon reservation state transactionally.
- Full referral-credit coverage settles without calling Paystack or requiring an email. Partial referral coverage initializes Paystack for only the remaining balance.
- The existing `/api/paystack-webhook` endpoint now dispatches matching ecommerce payment references to a separate signed-webhook handler while preserving the existing Spin webhook path. Ecommerce webhook receipts are persisted by a SHA-256 payload ID; webhook processing re-verifies the transaction with Paystack rather than trusting webhook amount fields.
- A successful provider charge that cannot be safely bound to the order or committed to inventory is marked `PAID_REQUIRES_REVIEW`; it is not silently treated as unpaid or fulfilled. Such cases require reconciliation/refund handling.
- Regression coverage includes server-generated references, exact amount/currency, authenticated and guest authorization, full/partial referral coverage, payment/order binding, inventory and coupon commit, signed/invalid webhooks, duplicate webhook handling, and mismatched successful charges. GitHub Actions run 44167100702 passed 90/90 tests; backend syntax checks also passed. A definitively failed provider attempt is marked `FAILED` so the next checkout attempt receives a fresh server-generated reference.
- WP4 is **partially implemented and test-validated**, not production-ready. No real Paystack sandbox transaction or staging Firestore emulator/project test has been run. The storefront still uses its legacy client-side Paystack flow and has not been migrated. Expiry/reconciliation, refund automation, and payment operations monitoring remain outstanding.

## WP5 guest order lookup status

- Added `spin-backend/ecommerce/lookup.js` and `POST /api/orders/lookup`.
- Authenticated orders require the verified Firebase UID that owns the order. Guest orders require the original 256-bit access secret and a timing-safe comparison against the stored SHA-256 hash.
- Lookup requires the cryptographically random 128-bit `orderId`; order reference, phone number, email, or a guessed short reference cannot authorize access.
- The API returns a deliberately limited order projection: delivery/customer details, item snapshots, amounts, payment status, fulfilment status, and timestamps. It excludes shopper UID, idempotency key, inventory reservation ID, guest secret hash, Paystack reference/access code, and internal payment metadata.
- Tests cover correct guest secret, missing/wrong guest secret, authenticated owner access, cross-shopper denial, short-reference/phone non-authorization, unknown/malformed IDs, and sensitive-field exclusion. The full suite passed 82/82 in GitHub Actions run 44166157732.
- WP5 backend lookup is implemented and test-validated. The current `track-order.html` still searches localStorage and reads order status through broad client-side Firestore queries; the tracking UI and account order history have not been migrated. That frontend migration remains WP7 and must use order ID plus guest secret for guests, never order reference or phone as an authentication factor.

## WP6 admin order operations status

- Added `spin-backend/ecommerce/admin-orders.js` and server routes `GET /api/admin/orders`, `GET /api/admin/orders/:orderId`, and `PATCH /api/admin/orders/:orderId/fulfilment`.
- Admin authorization verifies the Firebase ID token server-side, then checks the UID against the existing `admins/{uid}` allowlist document. The current Firestore rules deny client writes to `/admins`, so a signed-in shopper or referrer cannot grant themselves admin access.
- Admin order listing is bounded to 50 records per page and uses a validated cursor ordered by `createdAt` and `orderId`; it does not scan the entire orders collection.
- Fulfilment transitions are enforced server-side and audited transactionally: `PROCESSING -> PACKED -> SHIPPED -> DELIVERED`. Only paid orders can use this workflow. Each transition requires a reason and records actor UID, prior/new state, target order, and timestamp in `adminAuditLogs`.
- Paystack-paid and fully referral-covered orders enter `PROCESSING` after payment is committed. COD orders are deliberately blocked from this payment-backed transition path because the COD collection and inventory-confirmation policy has not yet been implemented. Cancellation/refund transitions are also excluded until their compensating inventory/referral/payment workflow exists.
- Admin order detail returns a restricted payment summary for operations but never exposes guest access hashes, guest secrets, access codes, idempotency keys, or inventory reservation IDs.
- Tests cover server-side admin allowlist lookup, pagination and cursor validation, order detail redaction, paid-order transitions, skipped/duplicate transitions, COD/unpaid denial, audit reasons, and immutable audit actor attribution. GitHub Actions run 44167100702 passed 90/90 tests; backend syntax checks passed.
- WP6 core admin read and fulfilment APIs are implemented and test-validated. The existing admin UI still reads orders directly from Firestore and must be migrated in WP7 before Firestore order reads/writes are locked down in WP8. No Firestore rules have been changed.


## WP7 frontend migration gate — audit result (2026-11-17)

The current storefront is not safe to switch to the new API until the operational dependencies below are closed. The migration is intentionally not started in this commit.

### Confirmed legacy paths that must be removed

- `checkout.html` calculates the payable amount in the browser, creates a Paystack reference in JavaScript, embeds the live public key, and treats the browser's `onSuccess` callback as payment confirmation.
- `completeOrder()` writes the order directly to Firestore through `VDB.saveOrder()`, deducts referral credit asynchronously through `VDB.spendReferralBalance()`, increments coupon usage asynchronously, stores the order as authoritative in localStorage, and sends an order-confirmed WhatsApp message before server verification.
- `track-order.html` authenticates tracking by a guessable short reference against localStorage. It also calls `VDB.getOrdersByPhone()`, which currently reads the entire Firestore `orders` collection and filters by phone in the browser.
- `orders.html` and the admin UI still rely on localStorage and direct Firestore order reads/updates. Those reads and writes must move to the new authenticated APIs before Firestore order rules are tightened.

### Operational blockers before checkout cutover

1. **Reservation expiry worker is missing.** Inventory and coupon holds have a 15-minute expiry timestamp, but no scheduled worker currently releases expired reservations, decrements coupon `reservedUses`, or reverses referral debits. A frontend cutover before this worker exists can strand inventory and referral balance after abandoned checkouts.
2. **COD lifecycle is not implemented.** COD orders are created as unpaid and `AWAITING_CONFIRMATION`; the paid-order fulfilment API deliberately refuses to advance them. Do not expose COD on the migrated checkout until an explicit confirmation, inventory-commit, collection and failed-delivery policy exists.
3. **API environment separation is not complete.** The Vercel production project domain is `spin-backend-delta.vercel.app`. Feature-branch pushes have generated READY preview deployments for both linked Vercel projects, but those preview URLs are commit-specific. A feature-preview storefront must not call the production API or touch production Firestore/payment data. Add an explicit staging API configuration and staging Firebase/Paystack credentials before end-to-end preview testing.
4. **Firebase client identity accessor is not yet exposed through `VDB`.** The frontend needs a method that returns the current Firebase user's UID and fresh ID token without trusting the cached `voltixUser` localStorage profile.
5. **No real staging integration test has been run.** The 90/90 GitHub Actions result uses the repository's Firestore test double. It proves the Node regression tests and syntax checks pass, not that Firestore transaction semantics, indexes, Firebase Auth, Paystack sandbox or webhook delivery work in staging.

### Next safe implementation sequence

- Implement an idempotent expiry/reconciliation worker with bounded batches, retryable leases and tests for inventory release, coupon hold release, referral debit reversal, duplicate execution and late successful Paystack charges.
- Define isolated staging API and Firebase/Paystack credentials; do not copy production secrets into preview environments.
- Expose a minimal Firebase ID-token accessor in `VDB`, then migrate checkout to server-calculated orders and server-side Paystack initialization/verification. Keep COD disabled until its workflow is implemented.
- Migrate guest tracking to order ID + 256-bit access secret; migrate signed-in order history and admin order operations to the authenticated APIs.
- Only after staging acceptance, propose Firestore rule lockdown and a separate production release plan.

### CI and preview status

- Latest GitHub Actions run: `44167262862`, commit `61054f5a3ac1c1f6e64420bab5bebe5da5c1c547`, completed successfully: 90 tests passed, 0 failed; backend syntax check passed.
- Both Vercel checks report success. Branch pushes have produced READY preview deployments; these are preview builds, not production promotion. No merge or production promotion was performed.
- Feature branch remains 91 commits ahead of `main`, 0 behind. No Firestore rules or production data were changed.


## WP7 operational dependency — expiry and reconciliation worker

- Added `spin-backend/ecommerce/expiry-worker.js` with a bounded batch size (default 25, maximum 100). It scans active inventory reservations by expiry time and finalizes expired checkout reservations in one Firestore transaction.
- Finalization releases product/variant reserved stock, releases coupon `reservedUses`, reverses a posted referral debit into an immutable deterministic ledger entry, and marks the order checkout as expired. These effects commit atomically and repeated execution is idempotent.
- Before release, the worker checks the order's payment record. If no payment was initialized, release is allowed after expiry. If Paystack has a payment reference, the worker queries Paystack server-to-server. Only a definitive provider `failed` status permits release. Missing, pending, timeout, or otherwise ambiguous results retain the stock hold for another reconciliation attempt.
- A late provider success is passed through the existing amount/currency/reference/order-binding verification. Since the reservation has expired, the existing payment path marks the order `PAID_REQUIRES_REVIEW`; the worker does not release stock or automatically fulfil it. The payment verifier also accepts a later success event for a locally `FAILED` attempt, so a delayed success webhook after stock release is escalated to manual review instead of being silently rejected.
- Payment initialization now checks that the order is not expired and that its inventory reservation is still active and within its expiry window. This closes the race where a new Paystack payment could otherwise be initialized after stock had already been released.
- Added a protected backend endpoint `POST /api/internal/ecommerce/expire-reservations`. It requires `ECOMMERCE_EXPIRY_CRON_SECRET` and accepts a bounded optional `batchSize`. No scheduler has been configured or activated; the endpoint is inert until the secret is set and an external scheduler is configured.
- Added `tests/ecommerce-expiry-worker.test.js` for abandoned checkout release, coupon and referral compensation, repeat execution, pending payments, late successful charges, and definitive provider failure.

### Worker limitations and release gates

- The worker is code-complete only pending CI and real Firestore staging validation. The repository's fake Firestore regression tests do not prove production transaction contention, query-index availability, or Paystack provider behavior.
- Configure the required Firestore composite index for `inventoryReservations(status, expiresAt)` if Firestore reports it is needed.
- Configure a scheduler to call the protected endpoint at a short interval (for example, every minute) only after staging credentials and a monitored scheduler are available. Do not place production Paystack or Firebase credentials in preview deployments.
- A reservation with an unresolved Paystack reference is deliberately retained rather than released. These cases need operational monitoring and manual review; safety is preferred over freeing stock prematurely.
- Expired reservations are scheduled through `nextReconcileAt`. Ambiguous or pending Paystack results are deferred for five minutes; already-settled/manual-review cases are deferred for one hour. This prevents a small batch of unresolved old payments from monopolizing every worker run. The query uses `status == RESERVED` plus `nextReconcileAt <= now`, ordered by `nextReconcileAt`; create the corresponding Firestore composite index (`status`, `nextReconcileAt`) if required.
- COD orders currently expire through the same 15-minute reservation policy. COD remains disabled in the migrated checkout until its separate collection and failed-delivery workflow is implemented.
