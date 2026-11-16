'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeFirestore } = require('./fake-firestore');
const { createOrder } = require('../spin-backend/ecommerce/orders');

const NOW = 1700000000000;
const baseRequest = (overrides = {}) => ({
  idempotencyKey: 'checkout_request_0001',
  guestAccessSecret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  customer: { name: 'Test Buyer', phone: '0241234567', region: 'Greater Accra', city: 'Accra', address: 'Test Street, Accra' },
  items: [{ productId: 'pods', quantity: 2 }],
  deliveryMethod: 'standard',
  paymentMethod: 'momo',
  ...overrides
});
function setup() {
  const db = new FakeFirestore();
  db.seed('products/pods', { name: 'Premium Pods', price: 50, stock: 5, reservedStock: 0, status: 'active' });
  return { db, deps: { db, now: () => NOW } };
}

test('orders: calculates product total from Firestore, not client price', async () => {
  const { db, deps } = setup();
  const r = await createOrder(deps, baseRequest({ items: [{ productId: 'pods', quantity: 2, price: 0.01 }] }), null);
  assert.equal(r.http, 201);
  assert.equal(r.json.totalPesewas, 10000);
  const order = db.read('orders/' + r.json.orderId);
  assert.equal(order.items[0].unitPricePesewas, 5000);
  assert.equal(order.paymentStatus, 'UNPAID');
  assert.equal(db.read('products/pods').reservedStock, 2);
});

test('orders: guest secret is returned and only its hash is persisted', async () => {
  const { db, deps } = setup();
  const r = await createOrder(deps, baseRequest(), null);
  assert.equal(typeof r.json.guestAccessSecret, 'string');
  const access = db.read('orderAccess/' + r.json.orderId);
  assert.equal(access.secretHash.length, 64);
  assert.equal(JSON.stringify(access).includes(r.json.guestAccessSecret), false);
});

test('orders: same idempotency key and guest secret returns the original order without a second hold', async () => {
  const { db, deps } = setup();
  const first = await createOrder(deps, baseRequest(), null);
  const second = await createOrder(deps, baseRequest(), null);
  assert.equal(second.http, 200);
  assert.equal(second.json.orderId, first.json.orderId);
  assert.equal(second.json.guestAccessSecret, first.json.guestAccessSecret);
  assert.equal(db.read('products/pods').reservedStock, 2);
});

test('orders: reusing idempotency key with changed payload conflicts', async () => {
  const { db, deps } = setup();
  await createOrder(deps, baseRequest(), null);
  const changed = await createOrder(deps, baseRequest({ items: [{ productId: 'pods', quantity: 1 }] }), null);
  assert.equal(changed.http, 409);
  assert.equal(db.read('products/pods').reservedStock, 2);
});

test('orders: coupon discount is recalculated from server catalogue price', async () => {
  const { db, deps } = setup();
  db.seed('coupons/SAVE10', { code: 'SAVE10', type: 'percent', value: 10, active: true, usedCount: 0, maxUses: 5 });
  const r = await createOrder(deps, baseRequest({ couponCode: 'save10' }), null);
  assert.equal(r.http, 201);
  assert.equal(r.json.totalPesewas, 9000);
  assert.equal(db.read('coupons/SAVE10').usedCount, 0);
  assert.equal(db.read('coupons/SAVE10').reservedUses, 1);
});

test('orders: coupon last-use limit is enforced', async () => {
  const { db, deps } = setup();
  db.seed('coupons/SAVE10', { code: 'SAVE10', type: 'percent', value: 10, active: true, usedCount: 1, maxUses: 1 });
  const r = await createOrder(deps, baseRequest({ couponCode: 'SAVE10' }), null);
  assert.equal(r.http, 400);
  assert.equal(db.read('products/pods').reservedStock, 0);
});

test('orders: stock shortage rejects checkout', async () => {
  const { db, deps } = setup();
  const r = await createOrder(deps, baseRequest({ items: [{ productId: 'pods', quantity: 6 }] }), null);
  assert.equal(r.http, 409);
  assert.equal(db.read('products/pods').reservedStock, 0);
});

test('orders: COD remains unpaid and express delivery is limited to Accra', async () => {
  const { db, deps } = setup();
  const r = await createOrder(deps, baseRequest({ paymentMethod: 'cod', deliveryMethod: 'express' }), null);
  assert.equal(r.http, 201);
  const order = db.read('orders/' + r.json.orderId);
  assert.equal(order.paymentStatus, 'UNPAID');
  assert.equal(order.fulfilmentStatus, 'AWAITING_CONFIRMATION');
  assert.equal(order.deliveryPesewas, 3500);
  const denied = await createOrder(deps, baseRequest({
    idempotencyKey: 'checkout_request_0002',
    customer: { name: 'Buyer', phone: '0241234567', region: 'Ashanti', city: 'Kumasi', address: 'Street' },
    deliveryMethod: 'express'
  }), null);
  assert.equal(denied.http, 400);
});

test('orders: guest access secret is mandatory and must be 256-bit base64url', async () => {
  const { deps } = setup();
  const missing = await createOrder(deps, baseRequest({ guestAccessSecret: undefined }), null);
  const weak = await createOrder(deps, baseRequest({ guestAccessSecret: 'guessable-secret' }), null);
  assert.equal(missing.http, 400);
  assert.equal(missing.json.error, 'INVALID_GUEST_ACCESS_SECRET');
  assert.equal(weak.http, 400);
  assert.equal(weak.json.error, 'INVALID_GUEST_ACCESS_SECRET');
});

test('orders: guest secret change under the same idempotency key conflicts', async () => {
  const { db, deps } = setup();
  await createOrder(deps, baseRequest(), null);
  const changedSecret = await createOrder(deps, baseRequest({
    guestAccessSecret: Buffer.alloc(32, 1).toString('base64url')
  }), null);
  assert.equal(changedSecret.http, 409);
  assert.equal(db.read('products/pods').reservedStock, 2);
});

test('orders: concurrent checkouts cannot oversell the final unit', async () => {
  const { db, deps } = setup();
  db.seed('products/pods', { name: 'Premium Pods', price: 50, stock: 1, reservedStock: 0, status: 'active' });
  const a = createOrder(deps, baseRequest({ idempotencyKey: 'checkout_concurrent_001', items: [{ productId: 'pods', quantity: 1 }] }), null);
  const b = createOrder(deps, baseRequest({ idempotencyKey: 'checkout_concurrent_002', items: [{ productId: 'pods', quantity: 1 }] }), null);
  const results = await Promise.all([a, b]);
  assert.equal(results.filter(x => x.http === 201).length, 1);
  assert.equal(results.filter(x => x.http === 409).length, 1);
  assert.equal(db.read('products/pods').reservedStock, 1);
});

test('orders: variant checkout uses variant price and variant stock', async () => {
  const { db, deps } = setup();
  db.seed('products/pods', {
    name: 'Premium Pods', price: 50, stock: null, status: 'active',
    variants: [
      { id: 'black', name: 'Black', price: 60, stock: 2, reservedStock: 0 },
      { id: 'white', name: 'White', price: 55, stock: 1, reservedStock: 0 }
    ]
  });
  const r = await createOrder(deps, baseRequest({
    items: [{ productId: 'pods', variantId: 'black', quantity: 1 }]
  }), null);
  assert.equal(r.http, 201);
  assert.equal(r.json.totalPesewas, 6000);
  const product = db.read('products/pods');
  assert.equal(product.variants[0].reservedStock, 1);
  assert.equal(product.variants[1].reservedStock, 0);
});

test('orders: inactive, malformed-expiry and corrupt-use-count coupons fail closed', async () => {
  for (const [code, coupon] of [
    ['INACTIVE', { type: 'percent', value: 10, active: false }],
    ['BADDATE', { type: 'percent', value: 10, active: true, expiresAt: 'not-a-date' }],
    ['BADCOUNT', { type: 'percent', value: 10, active: true, usedCount: '2' }]
  ]) {
    const { db, deps } = setup();
    db.seed('coupons/' + code, coupon);
    const r = await createOrder(deps, baseRequest({ couponCode: code }), null);
    assert.equal(r.http, 400, code);
    assert.equal(r.json.error, 'COUPON_INVALID', code);
    assert.equal(db.read('products/pods').reservedStock, 0, code);
  }
});
