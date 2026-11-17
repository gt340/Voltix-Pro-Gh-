'use strict';

// Bounded, retry-safe expiry/reconciliation worker. This module is backend-only.
// It never releases a reservation while a Paystack payment is pending or ambiguous.
const crypto = require('crypto');
const inventory = require('./inventory');
const ecommercePayments = require('./payments');

const DEFAULT_BATCH_SIZE = 25;
const MAX_BATCH_SIZE = 100;

function validOrderId(value) {
  return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
}

function timingSafeSecretEqual(expected, supplied) {
  if (typeof expected !== 'string' || typeof supplied !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function reconcilePaymentBeforeExpiry(deps, order, payment) {
  if (!payment) return { safeToRelease: true, reason: 'NO_PAYMENT_INITIALIZED' };
  if (payment.status === 'FAILED') return { safeToRelease: true, reason: 'PAYMENT_FAILED' };
  if (payment.status === 'SUCCESS' || payment.status === 'PAID_REQUIRES_REVIEW') {
    return { safeToRelease: false, reason: 'PAYMENT_ALREADY_SETTLED_OR_REVIEW' };
  }
  if (typeof payment.reference !== 'string' || !payment.reference) {
    return { safeToRelease: false, reason: 'PAYMENT_REFERENCE_UNAVAILABLE' };
  }

  // Query Paystack directly first. Only a definitive provider "failed" state
  // permits release. Missing, pending, timeout, or unknown results keep stock held.
  if (typeof deps.paystackVerify !== 'function') {
    return { safeToRelease: false, reason: 'PAYMENT_PROVIDER_UNAVAILABLE' };
  }
  const providerResult = await deps.paystackVerify(payment.reference);
  if (!providerResult || !providerResult.found || !providerResult.data) {
    return { safeToRelease: false, reason: 'PAYMENT_STATUS_AMBIGUOUS' };
  }
  const data = providerResult.data;
  if (data.reference !== payment.reference) {
    return { safeToRelease: false, reason: 'PAYMENT_REFERENCE_MISMATCH' };
  }
  if (data.status === 'failed') {
    const paymentRef = deps.db.collection('orderPayments').doc(order.orderId);
    await deps.db.runTransaction(async tx => {
      const latest = await tx.get(paymentRef);
      if (latest.exists && latest.data().reference === payment.reference &&
          !['SUCCESS', 'PAID_REQUIRES_REVIEW'].includes(latest.data().status)) {
        tx.set(paymentRef, {
          status: 'FAILED', providerStatus: 'failed', failureCode: 'PAYMENT_NOT_SUCCESSFUL',
          leaseExpiresAt: 0, updatedAt: (deps.now || Date.now)()
        }, { merge: true });
      }
    });
    return { safeToRelease: true, reason: 'PAYMENT_FAILED' };
  }
  if (data.status !== 'success') {
    return { safeToRelease: false, reason: 'PAYMENT_STATUS_AMBIGUOUS' };
  }

  // A success must pass the same amount/currency/reference/order binding checks.
  // If its reservation is expired, payment verification marks it for manual review.
  await ecommercePayments.verifyPaystackOrderPayment(
    deps, { orderId: order.orderId, reference: payment.reference }, null, true
  );
  const fresh = await deps.db.collection('orderPayments').doc(order.orderId).get();
  if (fresh.exists && ['SUCCESS', 'PAID_REQUIRES_REVIEW'].includes(fresh.data().status)) {
    return { safeToRelease: false, reason: 'PAYMENT_SETTLED_OR_REVIEW' };
  }
  return { safeToRelease: false, reason: 'PAYMENT_SUCCESS_REQUIRES_REVIEW' };
}

async function finalizeExpiredOrder(deps, reservationId, reason) {
  const { db } = deps;
  const now = deps.now || Date.now;
  const reservationRef = db.collection('inventoryReservations').doc(reservationId);

  try {
    return await db.runTransaction(async tx => {
      const reservationSnap = await tx.get(reservationRef);
      if (!reservationSnap.exists) return { ok: false, code: 'RESERVATION_NOT_FOUND' };
      const reservation = reservationSnap.data();
      if (reservation.status === 'RELEASED' && reservation.expiryFinalized === true) {
        return { ok: true, duplicate: true, code: 'ALREADY_FINALIZED' };
      }
      if (reservation.status !== 'RESERVED') {
        return { ok: false, code: 'RESERVATION_NOT_ACTIVE', status: reservation.status };
      }
      const timestamp = now();
      if (!Number.isSafeInteger(reservation.expiresAt) || timestamp < reservation.expiresAt) {
        return { ok: false, code: 'RESERVATION_NOT_EXPIRED' };
      }
      if (!validOrderId(reservation.orderId)) return { ok: false, code: 'INVALID_ORDER_BINDING' };

      const orderRef = db.collection('orders').doc(reservation.orderId);
      const paymentRef = db.collection('orderPayments').doc(reservation.orderId);
      const orderSnap = await tx.get(orderRef);
      const paymentSnap = await tx.get(paymentRef);
      if (!orderSnap.exists) return { ok: false, code: 'ORDER_NOT_FOUND' };
      const order = orderSnap.data();
      if (order.reservationId !== reservationId || order.orderId !== reservation.orderId) {
        return { ok: false, code: 'ORDER_RESERVATION_MISMATCH' };
      }
      if (['PAID', 'PAID_REQUIRES_REVIEW'].includes(order.paymentStatus)) {
        return { ok: false, code: 'PAYMENT_REQUIRES_REVIEW' };
      }
      if (paymentSnap.exists && paymentSnap.data().status !== 'FAILED') {
        return { ok: false, code: 'PAYMENT_RECONCILIATION_REQUIRED' };
      }

      const productIds = [...new Set((reservation.items || []).map(item => item.productId))];
      const productDocs = new Map();
      for (const productId of productIds) {
        const ref = db.collection('products').doc(productId);
        const snap = await tx.get(ref);
        if (!snap.exists) return { ok: false, code: 'PRODUCT_NOT_FOUND', productId };
        productDocs.set(productId, { ref, data: snap.data() });
      }

      const couponRef = order.couponCode ? db.collection('coupons').doc(order.couponCode) : null;
      const couponSnap = couponRef ? await tx.get(couponRef) : null;
      const debitRef = db.collection('referralLedger').doc(reservation.orderId + '_debit');
      const reversalRef = db.collection('referralLedger').doc(reservation.orderId + '_reversal');
      const debitSnap = await tx.get(debitRef);
      const reversalSnap = await tx.get(reversalRef);
      let referrerRef = null;
      let referrerSnap = null;
      if (Number(order.referralCreditPesewas || 0) > 0 && !debitSnap.exists) {
        return { ok: false, code: 'REFERRAL_DEBIT_MISSING' };
      }
      if (debitSnap.exists) {
        const debit = debitSnap.data();
        if (!Number.isSafeInteger(debit.amountPesewas) || debit.amountPesewas <= 0 ||
            debit.amountPesewas !== order.referralCreditPesewas ||
            typeof debit.uid !== 'string' || debit.uid !== order.shopperUid) {
          return { ok: false, code: 'REFERRAL_LEDGER_INVALID' };
        }
        referrerRef = db.collection('referrers').doc(debit.uid);
        referrerSnap = await tx.get(referrerRef);
        if (!referrerSnap.exists) return { ok: false, code: 'REFERRER_ACCOUNT_NOT_FOUND' };
      }

      const updatedProducts = new Map();
      for (const item of reservation.items) {
        const current = updatedProducts.get(item.productId) || productDocs.get(item.productId).data;
        let target;
        try { target = inventory.getStockTarget(current, item.variantId == null ? null : item.variantId); }
        catch (error) { return { ok: false, code: error.message, productId: item.productId }; }
        if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0 || target.reservedStock < item.quantity) {
          return { ok: false, code: 'RESERVATION_COUNTER_MISMATCH', productId: item.productId };
        }
        updatedProducts.set(item.productId,
          inventory.withReservedStock(current, target, target.reservedStock - item.quantity));
      }

      if (couponRef && order.couponReservationStatus !== 'RESERVED') {
        return { ok: false, code: 'COUPON_RESERVATION_STATE_INVALID' };
      }
      if (couponRef && order.couponReservationStatus === 'RESERVED') {
        if (!couponSnap || !couponSnap.exists) return { ok: false, code: 'COUPON_RESERVATION_MISSING' };
        const coupon = couponSnap.data();
        if (!Number.isSafeInteger(coupon.reservedUses) || coupon.reservedUses < 1) {
          return { ok: false, code: 'COUPON_COUNTER_INVALID' };
        }
      }

      for (const [productId, product] of updatedProducts) {
        tx.set(productDocs.get(productId).ref, product, { merge: true });
      }
      if (couponRef && order.couponReservationStatus === 'RESERVED') {
        tx.set(couponRef, { reservedUses: couponSnap.data().reservedUses - 1 }, { merge: true });
      }
      if (referrerRef && debitSnap.exists && !reversalSnap.exists) {
        const debit = debitSnap.data();
        const balance = Number(referrerSnap.data().balance == null ? 0 : referrerSnap.data().balance);
        const balancePesewas = Math.round(balance * 100);
        if (!Number.isSafeInteger(balancePesewas) || balancePesewas < 0) {
          return { ok: false, code: 'INVALID_REFERRAL_BALANCE' };
        }
        const restored = balancePesewas + debit.amountPesewas;
        if (!Number.isSafeInteger(restored)) return { ok: false, code: 'INVALID_REFERRAL_BALANCE' };
        tx.set(referrerRef, { balance: restored / 100 }, { merge: true });
        tx.set(reversalRef, {
          orderId: reservation.orderId, uid: debit.uid, type: 'CREDIT_REVERSAL',
          status: 'POSTED', amountPesewas: debit.amountPesewas, currency: 'GHS',
          balanceAfterPesewas: restored, originalEntryId: reservation.orderId + '_debit',
          reason: 'Checkout reservation expired: ' + reason, createdAt: timestamp
        });
      }

      tx.set(reservationRef, {
        status: 'RELEASED', expiryFinalized: true, releaseReason: reason,
        updatedAt: timestamp
      }, { merge: true });
      tx.set(orderRef, {
        checkoutStatus: 'EXPIRED',
        paymentStatus: paymentSnap.exists ? 'FAILED' : 'EXPIRED',
        fulfilmentStatus: 'CANCELLED',
        couponReservationStatus: couponRef ? 'RELEASED' : null,
        referralCreditReversedPesewas: debitSnap.exists ? debitSnap.data().amountPesewas : 0,
        referralReversedAt: debitSnap.exists ? timestamp : null,
        referralReversalReason: debitSnap.exists ? 'Checkout reservation expired: ' + reason : null,
        expiredAt: timestamp, updatedAt: timestamp
      }, { merge: true });
      return { ok: true, duplicate: false, code: 'EXPIRED_AND_RELEASED' };
    });
  } catch (error) {
    return { ok: false, code: 'EXPIRY_FINALIZATION_FAILED', message: error.message };
  }
}

async function runExpiryWorker(deps, options = {}) {
  const now = deps.now || Date.now;
  const batchSize = options.batchSize == null ? DEFAULT_BATCH_SIZE : Number(options.batchSize);
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    return { ok: false, code: 'INVALID_BATCH_SIZE' };
  }
  const snapshot = await deps.db.collection('inventoryReservations')
    .where('status', '==', 'RESERVED')
    .orderBy('expiresAt', 'asc')
    .limit(batchSize)
    .get();

  const summary = { ok: true, scanned: snapshot.size, expired: 0, pendingPayment: 0, review: 0, failed: 0, skipped: 0 };
  for (const doc of snapshot.docs) {
    const reservation = doc.data();
    if (!Number.isSafeInteger(reservation.expiresAt) || reservation.expiresAt > now()) {
      summary.skipped++;
      continue;
    }
    const orderId = reservation.orderId;
    if (!validOrderId(orderId)) { summary.failed++; continue; }
    try {
      const orderSnap = await deps.db.collection('orders').doc(orderId).get();
      if (!orderSnap.exists) { summary.failed++; continue; }
      const order = orderSnap.data();
      if (['PAID', 'PAID_REQUIRES_REVIEW'].includes(order.paymentStatus)) {
        summary.review++;
        continue;
      }
      const paymentSnap = await deps.db.collection('orderPayments').doc(orderId).get();
      const payment = paymentSnap.exists ? paymentSnap.data() : null;
      const decision = await reconcilePaymentBeforeExpiry(deps, order, payment);
      if (!decision.safeToRelease) {
        if (decision.reason === 'PAYMENT_SETTLED_OR_REVIEW' || decision.reason === 'PAYMENT_ALREADY_SETTLED_OR_REVIEW') summary.review++;
        else summary.pendingPayment++;
        continue;
      }
      const result = await finalizeExpiredOrder(deps, doc.id, decision.reason);
      if (result.ok && !result.duplicate) summary.expired++;
      else if (result.code === 'PAYMENT_REQUIRES_REVIEW' || result.code === 'PAYMENT_RECONCILIATION_REQUIRED') summary.review++;
      else if (result.code === 'ALREADY_FINALIZED') summary.skipped++;
      else summary.failed++;
    } catch (error) {
      summary.failed++;
    }
  }
  return summary;
}

module.exports = {
  DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE,
  timingSafeSecretEqual, reconcilePaymentBeforeExpiry,
  finalizeExpiredOrder, runExpiryWorker
};
