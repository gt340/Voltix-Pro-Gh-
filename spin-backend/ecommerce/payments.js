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

async function markOrderPaymentReview(deps, orderId, code) {
  const now = deps.now || Date.now;
  const orderRef = deps.db.collection('orders').doc(orderId);
  const paymentRef = deps.db.collection('orderPayments').doc(orderId);
  await deps.db.runTransaction(async tx => {
    const orderSnap = await tx.get(orderRef);
    const paymentSnap = await tx.get(paymentRef);
    if (paymentSnap.exists && paymentSnap.data().status !== 'SUCCESS') {
      tx.set(paymentRef, {
        status: 'PAID_REQUIRES_REVIEW', providerStatus: 'success',
        failureCode: code, verifiedAt: now(), updatedAt: now()
      }, { merge: true });
    }
    if (orderSnap.exists && orderSnap.data().paymentStatus !== 'PAID') {
      tx.set(orderRef, {
        paymentStatus: 'PAID_REQUIRES_REVIEW',
        paymentReviewCode: code, updatedAt: now()
      }, { merge: true });
    }
  });
}

function guestSecretMatches(secret, storedHash) {
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(secret) ||
      Buffer.from(secret, 'base64url').length !== 32 ||
      Buffer.from(secret, 'base64url').toString('base64url') !== secret ||
      typeof storedHash !== 'string' || !/^[a-f0-9]{64}$/.test(storedHash)) return false;
  const actual = crypto.createHash('sha256').update(secret).digest();
  const expected = Buffer.from(storedHash, 'hex');
  return crypto.timingSafeEqual(actual, expected);
}

async function initialisePaystackPayment(deps, input, uid) {
  const { db, paystackInitialize } = deps;
  const now = deps.now || Date.now;
  const orderId = input && input.orderId;
  const email = input && typeof input.email === 'string' ? input.email.trim() : '';
  if (!validOrderId(orderId)) return { http: 400, json: { error: 'INVALID_ORDER_ID' } };
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
      if (!order.shopperUid) {
        const accessSnap = await tx.get(db.collection('orderAccess').doc(orderId));
        if (!accessSnap.exists || !guestSecretMatches(input.guestAccessSecret, accessSnap.data().secretHash)) return { code: 'ORDER_FORBIDDEN' };
      }
      if (order.paymentMethod === 'cod') return { code: 'COD_NOT_PAYSTACK' };
      if (order.paymentStatus === 'PAID') return { code: 'ALREADY_PAID' };
      if (!Number.isSafeInteger(order.totalPesewas) || order.totalPesewas < 0) return { code: 'INVALID_ORDER_AMOUNT' };
      if (order.totalPesewas === 0) return { code: order.referralCreditPesewas > 0 ? 'FULLY_COVERED' : 'ZERO_AMOUNT_NOT_REFERRAL' };
      if (order.paymentStatus !== 'UNPAID' || order.checkoutStatus === 'EXPIRED') return { code: 'ORDER_NOT_PAYABLE' };
      const reservationRef = db.collection('inventoryReservations').doc(order.reservationId);
      const reservationSnap = await tx.get(reservationRef);
      if (!reservationSnap.exists || reservationSnap.data().status !== 'RESERVED' || reservationSnap.data().expiresAt <= timestamp) return { code: 'ORDER_NOT_PAYABLE' };
      if (!validEmail(email)) return { code: 'VALID_EMAIL_REQUIRED' };

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
  if (decision.code === 'ALREADY_PAID' || decision.code === 'ORDER_NOT_PAYABLE') return { http: 409, json: { error: decision.code } };
  if (decision.code === 'VALID_EMAIL_REQUIRED') return { http: 400, json: { error: decision.code } };
  if (decision.code === 'INVALID_ORDER_AMOUNT' || decision.code === 'ZERO_AMOUNT_NOT_REFERRAL') return { http: 409, json: { error: decision.code } };
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
    if (order.couponCode) {
      const couponSnap = await db.collection('coupons').doc(order.couponCode).get();
      const coupon = couponSnap.exists ? couponSnap.data() : null;
      if (!coupon || !Number.isSafeInteger(coupon.reservedUses) || coupon.reservedUses < 1 ||
          !Number.isSafeInteger(coupon.usedCount) || coupon.usedCount < 0) {
        await markOrderPaymentReview(deps, orderId, 'COUPON_RESERVATION_INVALID');
        return { http: 409, json: { error: 'PAYMENT_REQUIRES_REVIEW' } };
      }
    }
    const committed = await inventory.commitReservation(deps, order.reservationId);
    if (!committed.ok) {
      await orderRef.set({ paymentStatus: 'PAID_REQUIRES_REVIEW', paymentReviewCode: committed.code, updatedAt: now() }, { merge: true });
      return { http: 409, json: { error: 'INVENTORY_COMMIT_REQUIRES_REVIEW', detail: committed.code } };
    }
    await db.runTransaction(async tx => {
      const fresh = await tx.get(orderRef);
      const couponRef = order.couponCode ? db.collection('coupons').doc(order.couponCode) : null;
      const couponSnap = couponRef ? await tx.get(couponRef) : null;
      if (!fresh.exists) throw new Error('ORDER_NOT_FOUND');
      if (fresh.data().paymentStatus === 'PAID') return;
      if (couponRef) {
        if (!couponSnap.exists) throw new Error('COUPON_RESERVATION_MISSING');
        const coupon = couponSnap.data();
        if (!Number.isSafeInteger(coupon.reservedUses) || coupon.reservedUses < 1 || !Number.isSafeInteger(coupon.usedCount) || coupon.usedCount < 0) throw new Error('COUPON_COUNTER_INVALID');
        tx.set(couponRef, { reservedUses: coupon.reservedUses - 1, usedCount: coupon.usedCount + 1 }, { merge: true });
      }
      tx.set(orderRef, {
        paymentStatus: 'PAID', fulfilmentStatus: 'PROCESSING', paymentProvider: 'REFERRAL_CREDIT',
        paidAmountPesewas: 0, paidByReferralPesewas: order.referralCreditPesewas,
        couponReservationStatus: couponRef ? 'COMMITTED' : null,
        paidAt: now(), updatedAt: now()
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

async function verifyPaystackOrderPayment(deps, input, uid, trustedWebhook = false) {
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
  if (!trustedWebhook && order.shopperUid && order.shopperUid !== uid) return { http: 403, json: { error: 'ORDER_FORBIDDEN' } };
  if (!trustedWebhook && !order.shopperUid) {
    const accessSnap = await db.collection('orderAccess').doc(orderId).get();
    if (!accessSnap.exists || !guestSecretMatches(input.guestAccessSecret, accessSnap.data().secretHash)) return { http: 403, json: { error: 'ORDER_FORBIDDEN' } };
  }
  if (payment.reference !== reference) return { http: 409, json: { error: 'REFERENCE_ORDER_MISMATCH' } };
  if (payment.status === 'SUCCESS') return { http: 200, json: { status: 'paid', orderId } };
  if (!['INITIALIZED', 'INITIALIZING', 'INIT_FAILED', 'PAID_REQUIRES_REVIEW'].includes(payment.status)) return { http: 409, json: { error: 'PAYMENT_NOT_INITIALIZED' } };
  if (typeof paystackVerify !== 'function') return { http: 503, json: { error: 'PAYMENT_PROVIDER_UNAVAILABLE' } };

  let result;
  try { result = await paystackVerify(reference); }
  catch (e) { return { http: 502, transient: true, json: { error: 'PAYMENT_VERIFICATION_UNAVAILABLE' } }; }
  if (!result || !result.found || !result.data) return trustedWebhook
    ? { http: 502, transient: true, json: { error: 'PAYMENT_VERIFICATION_PENDING' } }
    : { http: 400, json: { error: 'PAYMENT_REFERENCE_NOT_FOUND' } };
  const data = result.data;
  if (data.reference !== reference) { await markOrderPaymentReview(deps, orderId, 'REFERENCE_MISMATCH'); return { http: 409, json: { error: 'PAYMENT_REQUIRES_REVIEW' } }; }
  if (data.status !== 'success') {
    if (trustedWebhook) return { http: 502, transient: true, json: { error: 'PAYMENT_VERIFICATION_PENDING' } };
    await paymentRef.set({ status: 'FAILED', providerStatus: String(data.status || 'unknown'), failureCode: 'PAYMENT_NOT_SUCCESSFUL', leaseExpiresAt: 0, updatedAt: now() }, { merge: true });
    return { http: 409, json: { error: 'PAYMENT_NOT_SUCCESSFUL' } };
  }
  if (data.currency !== 'GHS') { await markOrderPaymentReview(deps, orderId, 'CURRENCY_MISMATCH'); return { http: 409, json: { error: 'PAYMENT_REQUIRES_REVIEW' } }; }
  if (data.amount !== payment.expectedAmountPesewas) { await markOrderPaymentReview(deps, orderId, 'AMOUNT_MISMATCH'); return { http: 409, json: { error: 'PAYMENT_REQUIRES_REVIEW' } }; }
  const metadata = data.metadata;
  if (!metadata || metadata.orderId !== orderId || metadata.purpose !== 'voltix_ecommerce_order') {
    await markOrderPaymentReview(deps, orderId, 'ORDER_BINDING_MISMATCH');
    return { http: 409, json: { error: 'PAYMENT_REQUIRES_REVIEW' } };
  }
  const latestPayment = await paymentRef.get();
  if (latestPayment.exists && latestPayment.data().status === 'SUCCESS') return { http: 200, json: { status: 'paid', orderId } };
  const latestOrder = await orderRef.get();
  if (latestOrder.exists && latestOrder.data().paymentStatus === 'PAID') return { http: 200, json: { status: 'paid', orderId } };

  if (order.couponCode) {
    const couponSnap = await db.collection('coupons').doc(order.couponCode).get();
    const coupon = couponSnap.exists ? couponSnap.data() : null;
    if (!coupon || !Number.isSafeInteger(coupon.reservedUses) || coupon.reservedUses < 1 ||
        !Number.isSafeInteger(coupon.usedCount) || coupon.usedCount < 0) {
      await markOrderPaymentReview(deps, orderId, 'COUPON_RESERVATION_INVALID');
      return { http: 409, json: { error: 'PAYMENT_REQUIRES_REVIEW' } };
    }
  }
  const committed = await inventory.commitReservation(deps, order.reservationId);
  if (!committed.ok) {
    await markOrderPaymentReview(deps, orderId, committed.code);
    return { http: 409, json: { error: 'PAYMENT_RECEIVED_INVENTORY_REQUIRES_REVIEW' } };
  }

  await db.runTransaction(async tx => {
    const freshOrder = await tx.get(orderRef);
    const freshPayment = await tx.get(paymentRef);
    const couponRef = order.couponCode ? db.collection('coupons').doc(order.couponCode) : null;
    const couponSnap = couponRef ? await tx.get(couponRef) : null;
    if (!freshOrder.exists || !freshPayment.exists) throw new Error('PAYMENT_RECORD_MISSING');
    if (freshPayment.data().status === 'SUCCESS') return;
    if (freshPayment.data().reference !== reference) throw new Error('PAYMENT_REFERENCE_CHANGED');
    tx.set(paymentRef, {
      status: 'SUCCESS', providerStatus: 'success',
      amountPesewas: data.amount, currency: data.currency,
      verifiedAt: now(), updatedAt: now()
    }, { merge: true });
    if (couponRef) {
      if (!couponSnap.exists) throw new Error('COUPON_RESERVATION_MISSING');
      const coupon = couponSnap.data();
      if (!Number.isSafeInteger(coupon.reservedUses) || coupon.reservedUses < 1 ||
          !Number.isSafeInteger(coupon.usedCount) || coupon.usedCount < 0) throw new Error('COUPON_COUNTER_INVALID');
      tx.set(couponRef, { reservedUses: coupon.reservedUses - 1, usedCount: coupon.usedCount + 1 }, { merge: true });
    }
    tx.set(orderRef, {
      paymentStatus: 'PAID', fulfilmentStatus: 'PROCESSING', paidAmountPesewas: data.amount,
      paymentProvider: 'PAYSTACK', paymentReference: reference,
      couponReservationStatus: couponRef ? 'COMMITTED' : null,
      paidAt: now(), updatedAt: now()
    }, { merge: true });
  });
  return { http: 200, json: { status: 'paid', orderId, amountPesewas: data.amount } };
}

function verifyWebhookSignature(rawBody, signature, secret) {
  if (!secret || !signature || !rawBody) return false;
  const expected = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function handlePaystackWebhook(deps, { rawBody, signature }) {
  if (!verifyWebhookSignature(rawBody, signature, deps.paystackSecret)) {
    return { handled: true, http: 401, text: 'Invalid signature' };
  }
  let event;
  try { event = JSON.parse(rawBody.toString('utf8')); }
  catch (e) { return { handled: true, http: 400, text: 'Bad payload' }; }
  if (!event || event.event !== 'charge.success' || !event.data || typeof event.data.reference !== 'string') {
    return { handled: true, http: 200, text: 'Ignored' };
  }
  const reference = event.data.reference;
  const matches = await deps.db.collection('orderPayments').where('reference', '==', reference).get();
  if (!matches || matches.empty) return { handled: false };
  const paymentDoc = matches.docs[0];
  const orderId = paymentDoc.id;
  const receiptId = crypto.createHash('sha256').update(rawBody).digest('hex');
  const receiptRef = deps.db.collection('paymentWebhookEvents').doc(receiptId);
  await receiptRef.set({
    provider: 'PAYSTACK', event: event.event, reference, orderId,
    status: 'RECEIVED', receivedAt: (deps.now || Date.now)()
  }, { merge: true });
  const result = await verifyPaystackOrderPayment(deps, { orderId, reference }, null, true);
  if (result.transient || result.http >= 500) {
    await receiptRef.set({ status: 'RETRY', updatedAt: (deps.now || Date.now)() }, { merge: true });
    return { handled: true, http: 500, text: 'Retry later' };
  }
  await receiptRef.set({
    status: result.http === 200 ? 'PROCESSED' : 'REVIEW',
    resultCode: result.json && (result.json.error || result.json.status),
    updatedAt: (deps.now || Date.now)()
  }, { merge: true });
  return { handled: true, http: 200, text: 'OK' };
}

module.exports = { initialisePaystackPayment, verifyPaystackOrderPayment, handlePaystackWebhook, verifyWebhookSignature, validEmail, validOrderId, guestSecretMatches };
