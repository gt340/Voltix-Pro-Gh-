'use strict';

const crypto = require('crypto');
const inventory = require('./inventory');

const INIT_LEASE_MS = 60 * 1000;
const REF_RE = /^[A-Za-z0-9_-]{16,64}$/;

function validEmail(value) {
  return typeof value === 'string' && value.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function validOrderId(value) {
  return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
}

async function initialisePaystackPayment(deps, input, uid) {
  const { db, paystackInitialize } = deps;
  const now = deps.now || Date.now;
  const orderId = input && input.orderId;
  const email = input && typeof input.email === 'string' ? input.email.trim() : '';
  if (!validOrderId(orderId)) return { http: 400, json: { error: 'INVALID_ORDER_ID' } };
  if (!validEmail(email)) return { http: 400, json: { error: 'VALID_EMAIL_REQUIRED' } };
  if (typeof paystackInitialize !== 'function') return { http: 503, json: { error: 'PAYMENT_PROVIDER_UNAVAILABLE' } };

  const orderRef = db.collection('orders').doc(orderId);
  const paymentRef = db.collection('orderPayments').doc(orderId);
  const reference = 'VOLTIX_' + crypto.randomBytes(16).toString('hex');
  const leaseToken = crypto.randomBytes(12).toString('hex');
  const timestamp = now();
  let decision;

  try {
    decision = await db.runTransaction(async tx => {
      const orderSnap = await tx.get(orderRef);
      if (!orderSnap.exists) return { code: 'ORDER_NOT_FOUND' };
      const order = orderSnap.data();
      if (order.shopperUid && order.shopperUid !== uid) return { code: 'ORDER_FORBIDDEN' };
      if (!order.shopperUid && !input.guestAccessSecret) return { code: 'GUEST_SECRET_REQUIRED' };
      if (order.paymentMethod === 'cod') return { code: 'COD_NOT_PAYSTACK' };
      if (order.paymentStatus === 'PAID') return { code: 'ALREADY_PAID' };
      if (!Number.isSafeInteger(order.totalPesewas) || order.totalPesewas < 0) return { code: 'INVALID_ORDER_AMOUNT' };
      if (order.totalPesewas === 0) return { code: 'FULLY_COVERED' };

      const paymentSnap = await tx.get(paymentRef);
      if (paymentSnap.exists) {
        const current = paymentSnap.data();
        if (current.status === 'INITIALIZED') return { code: 'EXISTING', payment: current };
        if (current.status === 'INITIALIZING' && current.leaseExpiresAt > timestamp) return { code: 'IN_PROGRESS' };
        if (current.status === 'SUCCESS' || current.status === 'PAID_REQUIRES_REVIEW') return { code: 'ALREADY_PAID' };
      }
      const payment = {
        orderId, reference, expectedAmountPesewas: order.totalPesewas,
        currency: 'GHS', email, status: 'INITIALIZING',
        leaseToken, leaseExpiresAt: timestamp + INIT_LEASE_MS,
        createdAt: timestamp, updatedAt: timestamp
      };
      tx.set(paymentRef, payment);
      return { code: 'CLAIMED', payment, order };
    });
  } catch (e) {
    return { http: 500, json: { error: 'PAYMENT_INITIALIZATION_FAILED' } };
  }

  if (decision.code === 'ORDER_NOT_FOUND') return { http: 404, json: { error: decision.code } };
  if (decision.code === 'ORDER_FORBIDDEN' || decision.code === 'GUEST_SECRET_REQUIRED') return { http: 403, json: { error: decision.code } };
  if (decision.code === 'COD_NOT_PAYSTACK') return { http: 400, json: { error: decision.code } };
  if (decision.code === 'ALREADY_PAID') return { http: 409, json: { error: decision.code } };
  if (decision.code === 'INVALID_ORDER_AMOUNT') return { http: 409, json: { error: decision.code } };
  if (decision.code === 'IN_PROGRESS') return { http: 409, json: { error: decision.code } };
  if (decision.code === 'EXISTING') {
    return { http: 200, json: {
      status: 'initialized', reference: decision.payment.reference,
      authorizationUrl: decision.payment.authorizationUrl,
      accessCode: decision.payment.accessCode,
      amountPesewas: decision.payment.expectedAmountPesewas
    } };
  }
  if (decision.code === 'FULLY_COVERED') {
    const orderSnap = await orderRef.get();
    const order = orderSnap.data();
    if (!order || !order.reservationId) return { http: 409, json: { error: 'RESERVATION_MISSING' } };
    const committed = await inventory.commitReservation(deps, order.reservationId);
    if (!committed.ok) return { http: 409, json: { error: 'INVENTORY_COMMIT_REQUIRES_REVIEW', detail: committed.code } };
    await db.runTransaction(async tx => {
      const fresh = await tx.get(orderRef);
      if (!fresh.exists) throw new Error('ORDER_NOT_FOUND');
      if (fresh.data().paymentStatus === 'PAID') return;
      tx.set(orderRef, {
        paymentStatus: 'PAID', paymentProvider: 'REFERRAL_CREDIT',
        paidAmountPesewas: 0, paidAt: now(), updatedAt: now()
      }, { merge: true });
    });
    return { http: 200, json: { status: 'paid', method: 'referral_credit', amountPesewas: 0 } };
  }

  let provider;
  try {
    provider = await paystackInitialize({
      email, amount: decision.payment.expectedAmountPesewas,
      currency: 'GHS', reference: decision.payment.reference,
      callback_url: deps.paystackCallbackUrl || undefined,
      metadata: { orderId, purpose: 'voltix_ecommerce_order' }
    });
  } catch (e) {
    await db.collection('orderPayments').doc(orderId).set({
      status: 'INIT_FAILED', failureCode: 'PROVIDER_UNAVAILABLE',
      leaseExpiresAt: 0, updatedAt: now()
    }, { merge: true });
    return { http: 502, json: { error: 'PAYMENT_PROVIDER_UNAVAILABLE' } };
  }
  const data = provider && provider.data;
  if (!provider || provider.status !== true || !data ||
      data.reference !== decision.payment.reference ||
      typeof data.authorization_url !== 'string' || typeof data.access_code !== 'string') {
    await db.collection('orderPayments').doc(orderId).set({
      status: 'INIT_FAILED', failureCode: 'INVALID_PROVIDER_RESPONSE',
      leaseExpiresAt: 0, updatedAt: now()
    }, { merge: true });
    return { http: 502, json: { error: 'INVALID_PAYMENT_PROVIDER_RESPONSE' } };
  }
  await db.collection('orderPayments').doc(orderId).set({
    status: 'INITIALIZED', authorizationUrl: data.authorization_url,
    accessCode: data.access_code, leaseExpiresAt: 0, updatedAt: now()
  }, { merge: true });
  return { http: 200, json: {
    status: 'initialized', reference: data.reference,
    authorizationUrl: data.authorization_url, accessCode: data.access_code,
    amountPesewas: decision.payment.expectedAmountPesewas
  } };
}

async function verifyPaystackOrderPayment(deps, input, uid) {
  const { db, paystackVerify } = deps;
  const now = deps.now || Date.now;
  const orderId = input && input.orderId;
  const reference = input && input.reference;
  if (!validOrderId(orderId) || typeof reference !== 'string' || !REF_RE.test(reference)) {
    return { http: 400, json: { error: 'INVALID_PAYMENT_REFERENCE' } };
  }
  const orderRef = db.collection('orders').doc(orderId);
  const paymentRef = db.collection('orderPayments').doc(orderId);
  const [orderSnap, paymentSnap] = await Promise.all([orderRef.get(), paymentRef.get()]);
  if (!orderSnap.exists || !paymentSnap.exists) return { http: 404, json: { error: 'PAYMENT_NOT_FOUND' } };
  const order = orderSnap.data();
  const payment = paymentSnap.data();
  if (order.shopperUid && order.shopperUid !== uid) return { http: 403, json: { error: 'ORDER_FORBIDDEN' } };
  if (!order.shopperUid && !input.guestAccessSecret) return { http: 403, json: { error: 'GUEST_SECRET_REQUIRED' } };
  if (payment.reference !== reference) return { http: 409, json: { error: 'REFERENCE_ORDER_MISMATCH' } };
  if (payment.status === 'SUCCESS') return { http: 200, json: { status: 'paid', orderId } };
  if (typeof paystackVerify !== 'function') return { http: 503, json: { error: 'PAYMENT_PROVIDER_UNAVAILABLE' } };

  let result;
  try { result = await paystackVerify(reference); }
  catch (e) { return { http: 502, transient: true, json: { error: 'PAYMENT_VERIFICATION_UNAVAILABLE' } }; }
  if (!result || !result.found || !result.data) return { http: 400, json: { error: 'PAYMENT_REFERENCE_NOT_FOUND' } };
  const data = result.data;
  if (data.reference !== reference) return { http: 400, json: { error: 'REFERENCE_MISMATCH' } };
  if (data.status !== 'success') return { http: 409, json: { error: 'PAYMENT_NOT_SUCCESSFUL' } };
  if (data.currency !== 'GHS') return { http: 400, json: { error: 'PAYMENT_CURRENCY_MISMATCH' } };
  if (data.amount !== payment.expectedAmountPesewas) return { http: 409, json: { error: 'PAYMENT_AMOUNT_MISMATCH' } };
  const metadata = data.metadata;
  if (!metadata || metadata.orderId !== orderId || metadata.purpose !== 'voltix_ecommerce_order') {
    return { http: 409, json: { error: 'PAYMENT_ORDER_BINDING_MISMATCH' } };
  }

  const committed = await inventory.commitReservation(deps, order.reservationId);
  if (!committed.ok) {
    await paymentRef.set({
      status: 'PAID_REQUIRES_REVIEW', providerStatus: 'success',
      verifiedAt: now(), failureCode: committed.code, updatedAt: now()
    }, { merge: true });
    await orderRef.set({
      paymentStatus: 'PAID_REQUIRES_REVIEW', updatedAt: now()
    }, { merge: true });
    return { http: 409, json: { error: 'PAYMENT_RECEIVED_INVENTORY_REQUIRES_REVIEW' } };
  }

  await db.runTransaction(async tx => {
    const freshOrder = await tx.get(orderRef);
    const freshPayment = await tx.get(paymentRef);
    if (!freshOrder.exists || !freshPayment.exists) throw new Error('PAYMENT_RECORD_MISSING');
    if (freshPayment.data().status === 'SUCCESS') return;
    if (freshPayment.data().reference !== reference) throw new Error('PAYMENT_REFERENCE_CHANGED');
    tx.set(paymentRef, {
      status: 'SUCCESS', providerStatus: 'success',
      amountPesewas: data.amount, currency: data.currency,
      verifiedAt: now(), updatedAt: now()
    }, { merge: true });
    tx.set(orderRef, {
      paymentStatus: 'PAID', paidAmountPesewas: data.amount,
      paymentProvider: 'PAYSTACK', paymentReference: reference,
      paidAt: now(), updatedAt: now()
    }, { merge: true });
  });
  return { http: 200, json: { status: 'paid', orderId, amountPesewas: data.amount } };
}

module.exports = { initialisePaystackPayment, verifyPaystackOrderPayment, validEmail, validOrderId };
