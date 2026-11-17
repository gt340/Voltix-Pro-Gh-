'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeFirestore } = require('./fake-firestore');
const { createOrder } = require('../spin-backend/ecommerce/orders');
const { lookupOrder } = require('../spin-backend/ecommerce/lookup');

const guestSecret = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const baseRequest = (overrides = {}) => ({
  idempotencyKey: 'lookup_order_test_001',
  guestAccessSecret: guestSecret,
  customer: { name: 'Test Buyer', phone: '0241234567', region: 'Greater Accra', city: 'Accra', address: 'Test Street' },
  items: [{ productId: 'pods', quantity: 2 }],
  deliveryMethod: 'standard', paymentMethod: 'momo', ...overrides
});
function setup() {
  const db = new FakeFirestore();
  db.seed('products/pods', { name: 'Pods', price: 50, stock: 5, reservedStock: 0, status: 'active' });
  return { db, deps: { db, now: () => 1700000000000 } };
}
async function makeOrder(deps, input, uid) {
  const result = await createOrder(deps, baseRequest(input), uid || null);
  assert.equal(result.http, 201);
  return result;
}

test('order lookup: guest secret returns only the limited public order projection', async () => {
  const { db, deps } = setup();
  const created = await makeOrder(deps, {});
  db.seed('orderPayments/' + created.json.orderId, {
    reference: 'VOLTIX_private_reference', accessCode: 'private-access-code'
  });
  const result = await lookupOrder(deps, {
    orderId: created.json.orderId, guestAccessSecret: created.json.guestAccessSecret
  }, null);
  assert.equal(result.http, 200);
  assert.equal(result.json.order.orderId, created.json.orderId);
  assert.equal(result.json.order.orderRef, created.json.orderRef);
  assert.equal(result.json.order.totalPesewas, 10000);
  assert.equal(result.json.order.items[0].quantity, 2);
  const serialized = JSON.stringify(result.json);
  for (const secret of ['shopperUid', 'idempotencyKey', 'reservationId', 'secretHash', 'VOLTIX_private_reference', 'private-access-code']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('order lookup: guest requires the exact 256-bit access secret', async () => {
  const { deps } = setup();
  const created = await makeOrder(deps, {});
  const missing = await lookupOrder(deps, { orderId: created.json.orderId }, null);
  const wrong = await lookupOrder(deps, { orderId: created.json.orderId, guestAccessSecret: 'wrong' }, null);
  assert.equal(missing.http, 403);
  assert.equal(wrong.http, 403);
});

test('order lookup: authenticated shopper can read own order but another UID is denied', async () => {
  const { deps } = setup();
  const created = await makeOrder(deps, { idempotencyKey: 'lookup_order_test_002' }, 'shopper-1');
  const owner = await lookupOrder(deps, { orderId: created.json.orderId }, 'shopper-1');
  const other = await lookupOrder(deps, { orderId: created.json.orderId }, 'shopper-2');
  const anonymous = await lookupOrder(deps, { orderId: created.json.orderId }, null);
  assert.equal(owner.http, 200);
  assert.equal(other.http, 403);
  assert.equal(anonymous.http, 403);
});

test('order lookup: phone number or short order reference cannot authorize access', async () => {
  const { deps } = setup();
  const created = await makeOrder(deps, {});
  const result = await lookupOrder(deps, {
    orderId: created.json.orderId, phone: '0241234567', orderRef: created.json.orderRef
  }, null);
  assert.equal(result.http, 403);
});

test('order lookup: malformed and unknown order IDs are handled without data disclosure', async () => {
  const { deps } = setup();
  assert.equal((await lookupOrder(deps, { orderId: '#1001' }, null)).http, 400);
  assert.equal((await lookupOrder(deps, { orderId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, null)).http, 404);
});
