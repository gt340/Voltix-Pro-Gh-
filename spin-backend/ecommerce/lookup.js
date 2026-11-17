'use strict';

const { guestSecretMatches } = require('./payments');

const ORDER_ID_RE = /^[a-f0-9]{32}$/;

function publicOrder(order) {
  return {
    orderId: order.orderId,
    orderRef: order.orderRef,
    customer: {
      name: order.customer && order.customer.name,
      phone: order.customer && order.customer.phone,
      region: order.customer && order.customer.region,
      city: order.customer && order.customer.city,
      address: order.customer && order.customer.address
    },
    items: Array.isArray(order.items) ? order.items.map(item => ({
      productId: item.productId,
      variantId: item.variantId == null ? null : item.variantId,
      name: item.name,
      variantName: item.variantName || null,
      quantity: item.quantity,
      unitPricePesewas: item.unitPricePesewas,
      lineTotalPesewas: item.lineTotalPesewas
    })) : [],
    subtotalPesewas: order.subtotalPesewas,
    discountPesewas: order.discountPesewas,
    deliveryPesewas: order.deliveryPesewas,
    referralCreditPesewas: order.referralCreditPesewas,
    totalPesewas: order.totalPesewas,
    currency: order.currency,
    deliveryMethod: order.deliveryMethod,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    fulfilmentStatus: order.fulfilmentStatus,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    paidAt: order.paidAt || null
  };
}

async function lookupOrder(deps, input, uid) {
  const { db } = deps;
  const orderId = input && input.orderId;
  if (typeof orderId !== 'string' || !ORDER_ID_RE.test(orderId)) {
    return { http: 400, json: { error: 'INVALID_ORDER_ID' } };
  }
  const orderSnap = await db.collection('orders').doc(orderId).get();
  if (!orderSnap.exists) return { http: 404, json: { error: 'ORDER_NOT_FOUND' } };
  const order = orderSnap.data();

  if (order.shopperUid) {
    if (!uid || order.shopperUid !== uid) return { http: 403, json: { error: 'ORDER_FORBIDDEN' } };
  } else {
    const accessSnap = await db.collection('orderAccess').doc(orderId).get();
    if (!accessSnap.exists || !guestSecretMatches(input.guestAccessSecret, accessSnap.data().secretHash)) {
      return { http: 403, json: { error: 'ORDER_FORBIDDEN' } };
    }
  }

  return { http: 200, json: { status: 'ok', order: publicOrder(order) } };
}

module.exports = { lookupOrder, publicOrder, ORDER_ID_RE };
