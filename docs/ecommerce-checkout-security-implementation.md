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

`POST /api/orders` is implemented on the feature branch. Remaining endpoints are proposed and not yet implemented.

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
- This module is not yet wired into checkout APIs or an expiry worker. It must not be called directly by browsers. The tests also cover malformed reserved-stock counters and invalid product document paths. They have been committed but still require an executed CI run before WP1 can be marked validated.

## WP2 implementation status

- Added `spin-backend/ecommerce/orders.js` and exposed `POST /api/orders` from the existing Express backend.
- The API accepts product IDs, optional variant IDs, quantities, customer delivery details, payment method, delivery method, coupon code, and an idempotency key. It does not accept client prices or totals as authoritative inputs.
- Product and variant prices are read from Firestore and converted to integer pesewas. Standard delivery is configured as free; express delivery is GHS 35 and is restricted to Accra city, matching the existing storefront's stated policy. These constants preserve the existing storefront policy and must remain server-controlled.
- Inventory counters, the reservation record, order, guest access hash, coupon-capacity hold, and idempotency record are now written in one Firestore transaction. Product prices and stock are read in that same transaction; failed transactions leave no partial reservation or order.
- Idempotency records prevent duplicate logical orders and reject a reused key with a changed request. Guest orders must provide a client-generated canonical 256-bit base64url access secret with the idempotency key; only its SHA-256 hash is persisted. Retrying with the same key and secret returns the same secret in the response without persisting plaintext. Authenticated requests may provide a Firebase ID token and are associated with its verified UID.
- Coupon validation is performed against the server-side coupon document. Capacity is reserved through `reservedUses`, not counted as a completed redemption. A later verified-payment transition must convert the reservation to `usedCount`, and expiry/cancellation processing must release it. That transition and worker are not implemented yet.
- New orders are explicitly `UNPAID`. COD orders use `AWAITING_CONFIRMATION`; online payments use `AWAITING_PAYMENT`. This API does not initialize Paystack or confirm payment.
- Added `tests/ecommerce-orders.test.js` for server-side pricing, guest-secret hashing, idempotency, coupon capacity and malformed coupon metadata, stock shortage, COD and express-delivery rules, concurrent final-unit order creation, and variant-specific pricing/stock. WP1 tests cover reservation lifecycle, concurrent final-unit reservations, immediate cancellation, malformed reserved-stock counters, and invalid product document paths.
- Added `.github/workflows/ecommerce-security-tests.yml` to run the root regression suite on pushes to this feature branch and pull requests. No GitHub Actions result has been observed yet; current commit status reports only Vercel preview checks.

WP2 remains **partially implemented** until the test suite is executed and the checkout frontend is migrated to this API. Paystack initialization/verification and coupon-hold commit/release are intentionally deferred to WP4 and the expiry/reconciliation worker.

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
