'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeFirestore } = require('./fake-firestore');
const { createOrder } = require('../spin-backend/ecommerce/orders');
const { listAdminOrders, getAdminOrder, updateFulfilmentStatus } = require('../spin-backend/ecommerce/admin-orders');

const baseRequest = (overrides = {}) => ({
  idempotencyKey: 'admin_order_test_001',
  guestAccessSecret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
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
async function markPaid(db, orderId, extra = {}) {
  await db.collection('orders').doc(orderId).set({
    paymentStatus: 'PAID', fulfilmentStatus: 'PROCESSING', paymentProvider: 'PAYSTACK', ...extra
  }, { merge: true });
}


test('admin orders: list is bounded and cursor pagination has no duplicates or skipped rows', async () => {
  const { db, deps } = setup();
  for (let i = 1; i <= 55; i++) {
    const id = i.toString(16).padStart(32, '0');
    db.seed('orders/' + id, {
      orderId: id, orderRef: '#'+i, shopperUid: null,
      customer: { name: 'Buyer '+i, phone: '0241234567', region: 'Greater Accra', city: 'Accra', address: 'Street' },
      items: [], subtotalPesewas: 1000, discountPesewas: 0,
      deliveryPesewas: 0, referralCreditPesewas: 0, totalPesewas: 1000,
      currency: 'GHS', deliveryMethod: 'standard', paymentMethod: 'momo',
      paymentStatus: 'PAID', fulfilmentStatus: 'PROCESSING', createdAt: i, updatedAt: i
    });
  }
  const first = await listAdminOrders(deps, {});
  assert.equal(first.http, 200);
  assert.equal(first.json.orders.length, 50);
  assert.equal(first.json.hasMore, true);
  const second = await listAdminOrders(deps, { cursor: first.json.nextCursor });
  assert.equal(second.http, 200);
  assert.equal(second.json.orders.length, 5);
  assert.equal(second.json.hasMore, false);
  assert.equal(second.json.nextCursor, null);
  const allIds = [...first.json.orders, ...second.json.orders].map(o => o.orderId);
  assert.equal(new Set(allIds).size, 55);
  assert.equal(allIds.length, 55);
});

test('admin orders: invalid pagination cursor is rejected', async () => {
  const { deps } = setup();
  const result = await listAdminOrders(deps, { cursor: 'not-a-cursor' });
  assert.equal(result.http, 400);
  assert.equal(result.json.error, 'INVALID_CURSOR');
});

test('admin orders: only paid orders can advance through valid fulfilment states', async () => {
  const { db, deps } = setup();
  const created = await makeOrder(deps, {}, 'shopper-1');
  await markPaid(db, created.json.orderId);
  const packed = await updateFulfilmentStatus(deps, created.json.orderId, {
    status: 'PACKED', reason: 'Items packed and checked'
  }, 'admin-1');
  const shipped = await updateFulfilmentStatus(deps, created.json.orderId, {
    status: 'SHIPPED', reason: 'Handed to delivery courier'
  }, 'admin-1');
  const delivered = await updateFulfilmentStatus(deps, created.json.orderId, {
    status: 'DELIVERED', reason: 'Customer received the parcel'
  }, 'admin-1');
  assert.equal(packed.http, 200);
  assert.equal(shipped.http, 200);
  assert.equal(delivered.http, 200);
  assert.equal(db.read('orders/' + created.json.orderId).fulfilmentStatus, 'DELIVERED');
  const audit = await db.collection('adminAuditLogs').get();
  assert.equal(audit.size, 3);
  assert.ok(audit.docs.every(d => d.data().actorUid === 'admin-1'));
});

test('admin orders: unpaid and COD orders cannot be advanced by this payment-backed workflow', async () => {
  const { db, deps } = setup();
  const unpaid = await makeOrder(deps, {}, 'shopper-1');
  const cod = await makeOrder(deps, {
    idempotencyKey: 'admin_order_test_002', paymentMethod: 'cod'
  }, 'shopper-1');
  const a = await updateFulfilmentStatus(deps, unpaid.json.orderId, {
    status: 'PACKED', reason: 'Attempt to pack unpaid order'
  }, 'admin-1');
  const b = await updateFulfilmentStatus(deps, cod.json.orderId, {
    status: 'PACKED', reason: 'Attempt to pack COD order'
  }, 'admin-1');
  assert.equal(a.http, 409);
  assert.equal(a.json.error, 'ORDER_NOT_PAID');
  assert.equal(b.http, 409);
  assert.equal(b.json.error, 'COD_FULFILMENT_POLICY_NOT_CONFIGURED');
  assert.equal((await db.collection('adminAuditLogs').get()).size, 0);
});

test('admin orders: invalid, skipped and duplicate transitions are handled safely', async () => {
  const { db, deps } = setup();
  const created = await makeOrder(deps, {}, 'shopper-1');
  await markPaid(db, created.json.orderId);
  const skipped = await updateFulfilmentStatus(deps, created.json.orderId, {
    status: 'DELIVERED', reason: 'Trying to skip packing and shipping'
  }, 'admin-1');
  const first = await updateFulfilmentStatus(deps, created.json.orderId, {
    status: 'PACKED', reason: 'Packed and checked'
  }, 'admin-1');
  const duplicate = await updateFulfilmentStatus(deps, created.json.orderId, {
    status: 'PACKED', reason: 'Duplicate request'
  }, 'admin-1');
  assert.equal(skipped.http, 409);
  assert.equal(first.http, 200);
  assert.equal(duplicate.http, 200);
  assert.equal(duplicate.json.status, 'unchanged');
  assert.equal((await db.collection('adminAuditLogs').get()).size, 1);
});

test('admin orders: audit reason is mandatory and actor identity is required', async () => {
  const { db, deps } = setup();
  const created = await makeOrder(deps, {}, 'shopper-1');
  await markPaid(db, created.json.orderId);
  const noReason = await updateFulfilmentStatus(deps, created.json.orderId, { status: 'PACKED', reason: 'no' }, 'admin-1');
  const noActor = await updateFulfilmentStatus(deps, created.json.orderId, { status: 'PACKED', reason: 'Packed and checked' }, null);
  assert.equal(noReason.http, 400);
  assert.equal(noActor.http, 401);
  assert.equal((await db.collection('adminAuditLogs').get()).size, 0);
});

test('admin orders: detail endpoint returns payment metadata without guest secrets or internal IDs', async () => {
  const { db, deps } = setup();
  const created = await makeOrder(deps, {});
  db.seed('orderPayments/' + created.json.orderId, {
    status: 'INITIALIZED', reference: 'VOLTIX_admin_reference',
    expectedAmountPesewas: 10000, accessCode: 'private-access-code'
  });
  const result = await getAdminOrder(deps, created.json.orderId);
  assert.equal(result.http, 200);
  assert.equal(result.json.payment.reference, 'VOLTIX_admin_reference');
  const serialized = JSON.stringify(result.json);
  for (const secret of ['secretHash', 'guestAccessSecret', 'idempotencyKey', 'reservationId', 'private-access-code']) {
    assert.equal(serialized.includes(secret), false);
  }
});
