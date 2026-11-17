'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeFirestore } = require('./fake-firestore');
const { createOrder } = require('../spin-backend/ecommerce/orders');
const { initialisePaystackPayment } = require('../spin-backend/ecommerce/payments');
const { runExpiryWorker } = require('../spin-backend/ecommerce/expiry-worker');

const NOW = 1700000000000;
function setup() {
  const db = new FakeFirestore();
  db.seed('products/pods', { name: 'Pods', price: 50, stock: 5, reservedStock: 0, status: 'active' });
  db.seed('referrers/shopper-1', { balance: 30 });
  db.seed('coupons/SAVE10', { code: 'SAVE10', type: 'percent', value: 10, active: true, usedCount: 0, reservedUses: 0 });
  const deps = { db, now: () => NOW };
  return { db, deps };
}
function request(overrides = {}) {
  return {
    idempotencyKey: 'expiry_worker_test_001',
    guestAccessSecret: Buffer.alloc(32, 7).toString('base64url'),
    customer: { name: 'Test Buyer', phone: '0241234567', region: 'Greater Accra', city: 'Accra', address: 'Test Street' },
    items: [{ productId: 'pods', quantity: 2 }],
    deliveryMethod: 'standard', paymentMethod: 'momo',
    couponCode: 'SAVE10', referralCreditPesewas: 1000,
    ...overrides
  };
}
async function createExpiredOrder(deps, input = {}, expireNow = true) {
  const created = await createOrder(deps, request(input), 'shopper-1');
  assert.equal(created.http, 201);
  const order = deps.db.read('orders/' + created.json.orderId);
  if (expireNow) deps.now = () => order.reservationExpiresAt + 1;
  return { ...created, order };
}

test('expiry worker releases abandoned reservation, coupon hold and referral debit atomically', async () => {
  const { db, deps } = setup();
  const created = await createExpiredOrder(deps);
  const result = await runExpiryWorker(deps);
  const orderId = created.json.orderId;
  const order = db.read('orders/' + orderId);
  const reservation = db.read('inventoryReservations/' + order.reservationId);
  assert.equal(result.expired, 1);
  assert.equal(order.checkoutStatus, 'EXPIRED');
  assert.equal(order.paymentStatus, 'EXPIRED');
  assert.equal(order.couponReservationStatus, 'RELEASED');
  assert.equal(reservation.status, 'RELEASED');
  assert.equal(reservation.expiryFinalized, true);
  assert.equal(db.read('products/pods').reservedStock, 0);
  assert.equal(db.read('coupons/SAVE10').reservedUses, 0);
  assert.equal(db.read('referrers/shopper-1').balance, 30);
  assert.equal(db.read('referralLedger/' + orderId + '_reversal').amountPesewas, 1000);
});

test('expiry worker is idempotent on repeated runs', async () => {
  const { db, deps } = setup();
  const created = await createExpiredOrder(deps);
  const first = await runExpiryWorker(deps);
  const second = await runExpiryWorker(deps);
  assert.equal(first.expired, 1);
  assert.equal(second.expired, 0);
  assert.equal(db.read('products/pods').reservedStock, 0);
  assert.equal(db.read('referrers/shopper-1').balance, 30);
  assert.ok(db.read('orders/' + created.json.orderId).expiredAt);
});

test('expiry worker does not release stock while Paystack status is pending or unknown', async () => {
  const { db, deps } = setup();
  const created = await createExpiredOrder(deps, { couponCode: null, referralCreditPesewas: 0 }, false);
  deps.paystackInitialize = async payload => ({ status: true, data: {
    reference: payload.reference, authorization_url: 'https://checkout.paystack.com/test', access_code: 'test'
  } });
  const init = await initialisePaystackPayment(deps, {
    orderId: created.json.orderId, email: 'buyer@example.com', guestAccessSecret: created.json.guestAccessSecret
  }, null);
  assert.equal(init.http, 200);
  deps.now = () => created.order.reservationExpiresAt + 1;
  deps.paystackVerify = async reference => ({ found: true, data: {
    reference, status: 'pending', currency: 'GHS', amount: created.json.totalPesewas,
    metadata: { orderId: created.json.orderId, purpose: 'voltix_ecommerce_order' }
  } });
  const result = await runExpiryWorker(deps);
  assert.equal(result.pendingPayment, 1);
  assert.equal(db.read('products/pods').reservedStock, 2);
  assert.equal(db.read('orders/' + created.json.orderId).checkoutStatus, undefined);
});

test('expiry worker never releases stock after a late successful Paystack charge', async () => {
  const { db, deps } = setup();
  const created = await createExpiredOrder(deps, { couponCode: null, referralCreditPesewas: 0 }, false);
  deps.paystackInitialize = async payload => ({ status: true, data: {
    reference: payload.reference, authorization_url: 'https://checkout.paystack.com/test', access_code: 'test'
  } });
  const init = await initialisePaystackPayment(deps, {
    orderId: created.json.orderId, email: 'buyer@example.com', guestAccessSecret: created.json.guestAccessSecret
  }, null);
  deps.paystackVerify = async reference => ({ found: true, data: {
    reference, status: 'success', currency: 'GHS', amount: created.json.totalPesewas,
    metadata: { orderId: created.json.orderId, purpose: 'voltix_ecommerce_order' }
  } });
  const result = await runExpiryWorker(deps);
  const order = db.read('orders/' + created.json.orderId);
  assert.equal(result.review, 1);
  assert.equal(order.paymentStatus, 'PAID_REQUIRES_REVIEW');
  assert.equal(db.read('products/pods').stock, 5);
  assert.equal(db.read('products/pods').reservedStock, 2);
});

test('expiry worker releases only after provider confirms a definitive failure', async () => {
  const { db, deps } = setup();
  const created = await createExpiredOrder(deps, { couponCode: null, referralCreditPesewas: 0 });
  deps.paystackInitialize = async payload => ({ status: true, data: {
    reference: payload.reference, authorization_url: 'https://checkout.paystack.com/test', access_code: 'test'
  } });
  await initialisePaystackPayment(deps, {
    orderId: created.json.orderId, email: 'buyer@example.com', guestAccessSecret: created.json.guestAccessSecret
  }, null);
  deps.now = () => created.order.reservationExpiresAt + 1;
  deps.paystackVerify = async reference => ({ found: true, data: {
    reference, status: 'failed', currency: 'GHS', amount: created.json.totalPesewas,
    metadata: { orderId: created.json.orderId, purpose: 'voltix_ecommerce_order' }
  } });
  const result = await runExpiryWorker(deps);
  assert.equal(result.expired, 1);
  assert.equal(db.read('orders/' + created.json.orderId).paymentStatus, 'FAILED');
  assert.equal(db.read('products/pods').reservedStock, 0);
});
