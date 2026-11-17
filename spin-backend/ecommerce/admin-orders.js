'use strict';

const crypto = require('crypto');
const { publicOrder, ORDER_ID_RE } = require('./lookup');

const NEXT_FULFILMENT = Object.freeze({
  PROCESSING: 'PACKED',
  PACKED: 'SHIPPED',
  SHIPPED: 'DELIVERED'
});

async function getAdminOrder(deps, orderId) {
  if (typeof orderId !== 'string' || !ORDER_ID_RE.test(orderId)) {
    return { http: 400, json: { error: 'INVALID_ORDER_ID' } };
  }
  const orderSnap = await deps.db.collection('orders').doc(orderId).get();
  if (!orderSnap.exists) return { http: 404, json: { error: 'ORDER_NOT_FOUND' } };
  const paymentSnap = await deps.db.collection('orderPayments').doc(orderId).get();
  const payment = paymentSnap.exists ? paymentSnap.data() : null;
  return {
    http: 200,
    json: {
      status: 'ok',
      order: publicOrder(orderSnap.data()),
      payment: payment ? {
        status: payment.status,
        reference: payment.reference,
        expectedAmountPesewas: payment.expectedAmountPesewas,
        amountPesewas: payment.amountPesewas || null,
        currency: payment.currency,
        providerStatus: payment.providerStatus || null,
        failureCode: payment.failureCode || null
      } : null
    }
  };
}

async function updateFulfilmentStatus(deps, orderId, input, actorUid) {
  const { db } = deps;
  const now = deps.now || Date.now;
  const nextStatus = input && input.status;
  const reason = input && typeof input.reason === 'string' ? input.reason.trim() : '';
  if (typeof orderId !== 'string' || !ORDER_ID_RE.test(orderId)) {
    return { http: 400, json: { error: 'INVALID_ORDER_ID' } };
  }
  if (!Object.prototype.hasOwnProperty.call(NEXT_FULFILMENT, nextStatus)) {
    return { http: 400, json: { error: 'INVALID_FULFILMENT_STATUS' } };
  }
  if (typeof actorUid !== 'string' || !actorUid) {
    return { http: 401, json: { error: 'ADMIN_AUTH_REQUIRED' } };
  }
  if (reason.length < 5 || reason.length > 300) {
    return { http: 400, json: { error: 'AUDIT_REASON_REQUIRED' } };
  }

  const orderRef = db.collection('orders').doc(orderId);
  const auditId = crypto.randomBytes(16).toString('hex');
  const auditRef = db.collection('adminAuditLogs').doc(auditId);
  try {
    const result = await db.runTransaction(async tx => {
      const orderSnap = await tx.get(orderRef);
      if (!orderSnap.exists) return { code: 'ORDER_NOT_FOUND' };
      const order = orderSnap.data();
      if (order.paymentStatus !== 'PAID') {
        return { code: order.paymentMethod === 'cod' ? 'COD_FULFILMENT_POLICY_NOT_CONFIGURED' : 'ORDER_NOT_PAID' };
      }
      const expectedNext = NEXT_FULFILMENT[order.fulfilmentStatus];
      if (order.fulfilmentStatus === nextStatus) return { code: 'DUPLICATE', order };
      if (expectedNext !== nextStatus) {
        return { code: 'INVALID_TRANSITION', current: order.fulfilmentStatus, requested: nextStatus };
      }
      const timestamp = now();
      tx.set(orderRef, {
        fulfilmentStatus: nextStatus,
        fulfilmentUpdatedAt: timestamp,
        fulfilmentUpdatedBy: actorUid,
        updatedAt: timestamp
      }, { merge: true });
      tx.set(auditRef, {
        actorUid, action: 'ORDER_FULFILMENT_STATUS_CHANGED',
        targetType: 'order', targetId: orderId,
        fromStatus: order.fulfilmentStatus, toStatus: nextStatus,
        reason, createdAt: timestamp
      });
      return { code: 'UPDATED', from: order.fulfilmentStatus, to: nextStatus };
    });
    if (result.code === 'ORDER_NOT_FOUND') return { http: 404, json: { error: result.code } };
    if (result.code === 'COD_FULFILMENT_POLICY_NOT_CONFIGURED' || result.code === 'ORDER_NOT_PAID') {
      return { http: 409, json: { error: result.code } };
    }
    if (result.code === 'INVALID_TRANSITION') {
      return { http: 409, json: { error: result.code, current: result.current, requested: nextStatus } };
    }
    if (result.code === 'DUPLICATE') {
      return { http: 200, json: { status: 'unchanged', fulfilmentStatus: result.order.fulfilmentStatus } };
    }
    return { http: 200, json: { status: 'updated', from: result.from, fulfilmentStatus: result.to } };
  } catch (e) {
    return { http: 500, json: { error: 'ORDER_STATUS_UPDATE_FAILED' } };
  }
}

module.exports = { getAdminOrder, updateFulfilmentStatus, NEXT_FULFILMENT };
