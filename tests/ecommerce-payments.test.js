'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { FakeFirestore } = require('./fake-firestore');
const { createOrder } = require('../spin-backend/ecommerce/orders');
const { initialisePaystackPayment, verifyPaystackOrderPayment, handlePaystackWebhook } = require('../spin-backend/ecommerce/payments');

const NOW = 1700000000000;
const request = (overrides = {}) => ({
  idempotencyKey: 'paystack_order_test_001',
  guestAccessSecret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  customer: { name: 'Test Buyer', phone: '0241234567', region: 'Greater Accra', city: 'Accra', address: 'Test Street' },
  items: [{ productId: 'pods', quantity: 2 }],
  deliveryMethod: 'standard', paymentMethod: 'momo', ...overrides
});
function setup() {
  const db = new FakeFirestore();
  db.seed('products/pods', { name: 'Pods', price: 50, stock: 5, reservedStock: 0, status: 'active' });
  return { db, deps: { db, now: () => NOW } };
}
async function create(deps, input, uid) {
  const result = await createOrder(deps, request(input), uid || null);
  assert.equal(result.http, 201);
  return result;
}

test('ecommerce payments: Paystack receives server amount, GHS and server-generated reference', async () => {
  const { db, deps } = setup();
  const order = await create(deps, {}, 'shopper-1');
  let payload;
  deps.paystackInitialize = async value => {
    payload = value;
    return { status: true, data: {
      reference: value.reference, authorization_url: 'https://checkout.paystack.com/test',
      access_code: 'access_test'
    } };
  };
  const result = await initialisePaystackPayment(deps, {
    orderId: order.json.orderId, email: 'buyer@example.com', amount: 1, reference: 'CLIENT_REFERENCE'
  }, 'shopper-1');
  assert.equal(result.http, 200);
  assert.equal(payload.amount, 10000);
  assert.notEqual(payload.reference, 'CLIENT_REFERENCE');
  assert.equal(payload.currency, 'GHS');
  assert.match(payload.reference, /^VOLTIX_[a-f0-9]{32}$/);
  assert.equal(payload.metadata.orderId, order.json.orderId);
  assert.equal(result.json.reference, payload.reference);
  assert.equal(db.read('orderPayments/' + order.json.orderId).status, 'INITIALIZED');
});

test('ecommerce payments: guest must prove the 256-bit order access secret', async () => {
  const { deps } = setup();
  const order = await create(deps, {});
  deps.paystackInitialize = async value => ({ status: true, data: {
    reference: value.reference, authorization_url: 'https://checkout.paystack.com/test', access_code: 'x'
  } });
  const denied = await initialisePaystackPayment(deps, {
    orderId: order.json.orderId, email: 'buyer@example.com', guestAccessSecret: 'wrong-secret'
  }, null);
  assert.equal(denied.http, 403);
  const accepted = await initialisePaystackPayment(deps, {
    orderId: order.json.orderId, email: 'buyer@example.com', guestAccessSecret: order.json.guestAccessSecret
  }, null);
  assert.equal(accepted.http, 200);
});

test('ecommerce payments: partial referral credit initializes Paystack for only the remaining balance', async () => {
  const { deps } = setup();
  deps.db.seed('referrers/shopper-1', { balance: 25 });
  const order = await create(deps, { referralCreditPesewas: 2500 }, 'shopper-1');
  let amount;
  deps.paystackInitialize = async value => {
    amount = value.amount;
    return { status: true, data: {
      reference: value.reference, authorization_url: 'https://checkout.paystack.com/test', access_code: 'x'
    } };
  };
  const result = await initialisePaystackPayment(deps, {
    orderId: order.json.orderId, email: 'buyer@example.com'
  }, 'shopper-1');
  assert.equal(result.http, 200);
  assert.equal(amount, 7500);
  assert.equal(order.json.totalPesewas, 7500);
});

test('ecommerce payments: verified payment commits inventory and marks order paid exactly once', async () => {
  const { db, deps } = setup();
  const order = await create(deps, {}, 'shopper-1');
  deps.paystackInitialize = async value => ({ status: true, data: {
    reference: value.reference, authorization_url: 'https://checkout.paystack.com/test', access_code: 'x'
  } });
  const initialized = await initialisePaystackPayment(deps, {
    orderId: order.json.orderId, email: 'buyer@example.com'
  }, 'shopper-1');
  deps.paystackVerify = async reference => ({ found: true, data: {
    reference, status: 'success', currency: 'GHS', amount: 10000,
    metadata: { orderId: order.json.orderId, purpose: 'voltix_ecommerce_order' }
  } });
  const first = await verifyPaystackOrderPayment(deps, {
    orderId: order.json.orderId, reference: initialized.json.reference
  }, 'shopper-1');
  const second = await verifyPaystackOrderPayment(deps, {
    orderId: order.json.orderId, reference: initialized.json.reference
  }, 'shopper-1');
  assert.equal(first.http, 200);
  assert.equal(second.http, 200);
  assert.equal(db.read('orders/' + order.json.orderId).paymentStatus, 'PAID');
  assert.equal(db.read('products/pods').stock, 3);
  assert.equal(db.read('products/pods').reservedStock, 0);
  assert.equal(db.read('inventoryReservations/' + db.read('orders/' + order.json.orderId).reservationId).status, 'COMMITTED');
});

test('ecommerce payments: definitive failed attempt can be retried with a fresh server reference', async () => {
  const { db, deps } = setup();
  const order = await create(deps, {}, 'shopper-1');
  deps.paystackInitialize = async value => ({ status: true, data: {
    reference: value.reference, authorization_url: 'https://checkout.paystack.com/test', access_code: 'x'
  } });
  const first = await initialisePaystackPayment(deps, {
    orderId: order.json.orderId, email: 'buyer@example.com'
  }, 'shopper-1');
  deps.paystackVerify = async reference => ({ found: true, data: {
    reference, status: 'failed', currency: 'GHS', amount: 10000,
    metadata: { orderId: order.json.orderId, purpose: 'voltix_ecommerce_order' }
  } });
  const failed = await verifyPaystackOrderPayment(deps, {
    orderId: order.json.orderId, reference: first.json.reference
  }, 'shopper-1');
  assert.equal(failed.http, 409);
  assert.equal(db.read('orderPayments/' + order.json.orderId).status, 'FAILED');
  const second = await initialisePaystackPayment(deps, {
    orderId: order.json.orderId, email: 'buyer@example.com'
  }, 'shopper-1');
  assert.equal(second.http, 200);
  assert.notEqual(second.json.reference, first.json.reference);
  assert.equal(db.read('orders/' + order.json.orderId).paymentStatus, 'UNPAID');
});

test('ecommerce payments: amount, currency and order metadata mismatches never commit stock', async () => {
  for (const patch of [
    { amount: 9999 }, { currency: 'USD' },
    { metadata: { orderId: 'ffffffffffffffffffffffffffffffff', purpose: 'voltix_ecommerce_order' } }
  ]) {
    const { db, deps } = setup();
    const order = await create(deps, {}, 'shopper-1');
    deps.paystackInitialize = async value => ({ status: true, data: {
      reference: value.reference, authorization_url: 'https://checkout.paystack.com/test', access_code: 'x'
    } });
    const initialized = await initialisePaystackPayment(deps, {
      orderId: order.json.orderId, email: 'buyer@example.com'
    }, 'shopper-1');
    deps.paystackVerify = async reference => ({ found: true, data: {
      reference, status: 'success', currency: 'GHS', amount: 10000,
      metadata: { orderId: order.json.orderId, purpose: 'voltix_ecommerce_order' }, ...patch
    } });
    const result = await verifyPaystackOrderPayment(deps, {
      orderId: order.json.orderId, reference: initialized.json.reference
    }, 'shopper-1');
    assert.equal(result.http, 409);
    assert.equal(db.read('orders/' + order.json.orderId).paymentStatus, 'PAID_REQUIRES_REVIEW');
    assert.equal(db.read('products/pods').stock, 5);
    assert.equal(db.read('products/pods').reservedStock, 2);
  }
});

test('ecommerce payments: a reference cannot be verified against another order', async () => {
  const { deps } = setup();
  const one = await create(deps, {}, 'shopper-1');
  const two = await create(deps, { idempotencyKey: 'paystack_order_test_002' }, 'shopper-1');
  deps.paystackInitialize = async value => ({ status: true, data: {
    reference: value.reference, authorization_url: 'https://checkout.paystack.com/test', access_code: 'x'
  } });
  const initialized = await initialisePaystackPayment(deps, {
    orderId: one.json.orderId, email: 'buyer@example.com'
  }, 'shopper-1');
  await initialisePaystackPayment(deps, {
    orderId: two.json.orderId, email: 'buyer@example.com'
  }, 'shopper-1');
  const result = await verifyPaystackOrderPayment(deps, {
    orderId: two.json.orderId, reference: initialized.json.reference
  }, 'shopper-1');
  assert.equal(result.http, 409);
  assert.equal(result.json.error, 'REFERENCE_ORDER_MISMATCH');
});


test('ecommerce payments: full referral coverage commits without calling Paystack', async () => {
  const { db, deps } = setup();
  db.seed('referrers/shopper-1', { balance: 100 });
  const order = await create(deps, { referralCreditPesewas: 10000 }, 'shopper-1');
  let providerCalled = false;
  deps.paystackInitialize = async () => { providerCalled = true; throw new Error('must not call provider'); };
  const result = await initialisePaystackPayment(deps, {
    orderId: order.json.orderId
  }, 'shopper-1');
  assert.equal(result.http, 200);
  assert.equal(result.json.status, 'paid');
  assert.equal(providerCalled, false);
  assert.equal(db.read('orders/' + order.json.orderId).paymentStatus, 'PAID');
  assert.equal(db.read('orders/' + order.json.orderId).paymentProvider, 'REFERRAL_CREDIT');
  assert.equal(db.read('products/pods').stock, 3);
  assert.equal(db.read('referrers/shopper-1').balance, 0);
});

test('ecommerce payments: successful payment commits coupon reservation exactly once', async () => {
  const { db, deps } = setup();
  db.seed('coupons/SAVE10', { code: 'SAVE10', type: 'percent', value: 10, active: true, usedCount: 0, reservedUses: 0 });
  const order = await create(deps, { couponCode: 'SAVE10' }, 'shopper-1');
  deps.paystackInitialize = async value => ({ status: true, data: {
    reference: value.reference, authorization_url: 'https://checkout.paystack.com/test', access_code: 'x'
  } });
  const initialized = await initialisePaystackPayment(deps, {
    orderId: order.json.orderId, email: 'buyer@example.com'
  }, 'shopper-1');
  deps.paystackVerify = async reference => ({ found: true, data: {
    reference, status: 'success', currency: 'GHS', amount: 9000,
    metadata: { orderId: order.json.orderId, purpose: 'voltix_ecommerce_order' }
  } });
  const result = await verifyPaystackOrderPayment(deps, {
    orderId: order.json.orderId, reference: initialized.json.reference
  }, 'shopper-1');
  assert.equal(result.http, 200);
  assert.equal(db.read('coupons/SAVE10').usedCount, 1);
  assert.equal(db.read('coupons/SAVE10').reservedUses, 0);
  assert.equal(db.read('orders/' + order.json.orderId).couponReservationStatus, 'COMMITTED');
});

test('ecommerce payments: signed Paystack webhook verifies server-side and is idempotent', async () => {
  const { db, deps } = setup();
  const order = await create(deps, {});
  deps.paystackSecret = 'test_webhook_secret';
  deps.paystackInitialize = async value => ({ status: true, data: {
    reference: value.reference, authorization_url: 'https://checkout.paystack.com/test', access_code: 'x'
  } });
  const initialized = await initialisePaystackPayment(deps, {
    orderId: order.json.orderId, email: 'buyer@example.com', guestAccessSecret: order.json.guestAccessSecret
  }, null);
  deps.paystackVerify = async reference => ({ found: true, data: {
    reference, status: 'success', currency: 'GHS', amount: 10000,
    metadata: { orderId: order.json.orderId, purpose: 'voltix_ecommerce_order' }
  } });
  const rawBody = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: initialized.json.reference } }));
  const signature = crypto.createHmac('sha512', deps.paystackSecret).update(rawBody).digest('hex');
  const first = await handlePaystackWebhook(deps, { rawBody, signature });
  const second = await handlePaystackWebhook(deps, { rawBody, signature });
  assert.equal(first.handled, true);
  assert.equal(first.http, 200);
  assert.equal(second.http, 200);
  assert.equal(db.read('orders/' + order.json.orderId).paymentStatus, 'PAID');
  assert.equal(db.read('products/pods').stock, 3);
  assert.equal(db.read('paymentWebhookEvents/' + crypto.createHash('sha256').update(rawBody).digest('hex')).status, 'PROCESSED');
});

test('ecommerce payments: trusted webhook can settle an authenticated shopper order', async () => {
  const { db, deps } = setup();
  const order = await create(deps, {}, 'shopper-1');
  deps.paystackSecret = 'test_webhook_secret';
  deps.paystackInitialize = async value => ({ status: true, data: {
    reference: value.reference, authorization_url: 'https://checkout.paystack.com/test', access_code: 'x'
  } });
  const initialized = await initialisePaystackPayment(deps, {
    orderId: order.json.orderId, email: 'buyer@example.com'
  }, 'shopper-1');
  deps.paystackVerify = async reference => ({ found: true, data: {
    reference, status: 'success', currency: 'GHS', amount: 10000,
    metadata: { orderId: order.json.orderId, purpose: 'voltix_ecommerce_order' }
  } });
  const rawBody = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: initialized.json.reference } }));
  const signature = crypto.createHmac('sha512', deps.paystackSecret).update(rawBody).digest('hex');
  const result = await handlePaystackWebhook(deps, { rawBody, signature });
  assert.equal(result.http, 200);
  assert.equal(db.read('orders/' + order.json.orderId).paymentStatus, 'PAID');
  assert.equal(db.read('products/pods').stock, 3);
});

test('ecommerce payments: webhook retries when Paystack verification is temporarily not found', async () => {
  const { db, deps } = setup();
  const order = await create(deps, {}, 'shopper-1');
  deps.paystackSecret = 'test_webhook_secret';
  deps.paystackInitialize = async value => ({ status: true, data: {
    reference: value.reference, authorization_url: 'https://checkout.paystack.com/test', access_code: 'x'
  } });
  const initialized = await initialisePaystackPayment(deps, {
    orderId: order.json.orderId, email: 'buyer@example.com'
  }, 'shopper-1');
  deps.paystackVerify = async () => ({ found: false });
  const rawBody = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: initialized.json.reference } }));
  const signature = crypto.createHmac('sha512', deps.paystackSecret).update(rawBody).digest('hex');
  const result = await handlePaystackWebhook(deps, { rawBody, signature });
  const receiptId = crypto.createHash('sha256').update(rawBody).digest('hex');
  assert.equal(result.http, 500);
  assert.equal(db.read('paymentWebhookEvents/' + receiptId).status, 'RETRY');
  assert.equal(db.read('orders/' + order.json.orderId).paymentStatus, 'UNPAID');
});

test('ecommerce payments: invalid webhook signature cannot change order or inventory', async () => {
  const { db, deps } = setup();
  const order = await create(deps, {}, 'shopper-1');
  deps.paystackSecret = 'test_webhook_secret';
  const rawBody = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: 'VOLTIX_0123456789abcdef0123456789abcdef' } }));
  const result = await handlePaystackWebhook(deps, { rawBody, signature: 'bad' });
  assert.equal(result.http, 401);
  assert.equal(db.read('orders/' + order.json.orderId).paymentStatus, 'UNPAID');
  assert.equal(db.read('products/pods').stock, 5);
});

test('ecommerce payments: COD, missing email and wrong shopper are rejected', async () => {
  const { deps } = setup();
  deps.paystackInitialize = async value => ({ status: true, data: { reference: value.reference, authorization_url: 'https://checkout.paystack.com/test', access_code: 'x' } });
  const cod = await create(deps, { paymentMethod: 'cod' }, 'shopper-1');
  const online = await create(deps, { idempotencyKey: 'paystack_order_test_003' }, 'shopper-1');
  assert.equal((await initialisePaystackPayment(deps, { orderId: cod.json.orderId, email: 'buyer@example.com' }, 'shopper-1')).http, 400);
  assert.equal((await initialisePaystackPayment(deps, { orderId: online.json.orderId }, 'shopper-1')).http, 400);
  assert.equal((await initialisePaystackPayment(deps, { orderId: online.json.orderId, email: 'buyer@example.com' }, 'attacker')).http, 403);
});
