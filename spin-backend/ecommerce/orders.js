'use strict';

const crypto = require('crypto');
const inventory = require('./inventory');

const DELIVERY = Object.freeze({
  standard: { pesewas: 0, label: 'Standard Delivery' },
  express: { pesewas: 3500, label: 'Express Delivery' }
});

function moneyToPesewas(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error('INVALID_PRICE');
  const pesewas = Math.round(n * 100);
  if (!Number.isSafeInteger(pesewas) || Math.abs(n * 100 - pesewas) > 1e-7) throw new Error('INVALID_PRICE');
  return pesewas;
}

function cleanText(value, max, field) {
  if (typeof value !== 'string') throw new Error('INVALID_' + field.toUpperCase());
  const v = value.trim();
  if (!v || v.length > max) throw new Error('INVALID_' + field.toUpperCase());
  return v;
}

function normaliseRequest(input, uid) {
  const customer = input && input.customer || {};
  const name = cleanText(customer.name, 100, 'name');
  const phone = cleanText(customer.phone, 24, 'phone');
  if (phone.replace(/\D/g, '').length < 7) throw new Error('INVALID_PHONE');
  const region = cleanText(customer.region, 80, 'region');
  const city = cleanText(customer.city, 80, 'city');
  const address = cleanText(customer.address, 300, 'address');
  const deliveryMethod = input.deliveryMethod || 'standard';
  if (!Object.prototype.hasOwnProperty.call(DELIVERY, deliveryMethod)) throw new Error('INVALID_DELIVERY_METHOD');
  if (deliveryMethod === 'express' && !/accra/i.test(city)) {
    throw new Error('EXPRESS_DELIVERY_AREA_RESTRICTED');
  }
  const paymentMethod = input.paymentMethod;
  if (!['momo', 'card', 'cod'].includes(paymentMethod)) throw new Error('INVALID_PAYMENT_METHOD');
  const idempotencyKey = input.idempotencyKey;
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey)) {
    throw new Error('INVALID_IDEMPOTENCY_KEY');
  }
  if (!Array.isArray(input.items) || input.items.length === 0 || input.items.length > 50) throw new Error('INVALID_ITEMS');
  const items = inventory.normaliseItems(input.items);
  const couponCode = input.couponCode == null || input.couponCode === '' ? null : String(input.couponCode).trim().toUpperCase();
  if (couponCode && !/^[A-Z0-9_-]{3,32}$/.test(couponCode)) throw new Error('INVALID_COUPON_CODE');
  let guestAccessSecret = null;
  if (!uid) {
    guestAccessSecret = input.guestAccessSecret;
    if (typeof guestAccessSecret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(guestAccessSecret) || Buffer.from(guestAccessSecret, 'base64url').length !== 32 || Buffer.from(guestAccessSecret, 'base64url').toString('base64url') !== guestAccessSecret) {
      throw new Error('INVALID_GUEST_ACCESS_SECRET');
    }
  }
  const guestAccessSecretHash = guestAccessSecret ? crypto.createHash('sha256').update(guestAccessSecret).digest('hex') : null;
  const canonical = { uid: uid || null, customer: { name, phone, region, city, address }, deliveryMethod, paymentMethod, items, couponCode, guestAccessSecretHash };
  const requestHash = crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  return { ...canonical, guestAccessSecret, idempotencyKey, requestHash };
}

function resolveProductLine(product, item) {
  if (!product || (product.status && product.status !== 'active')) throw new Error('PRODUCT_UNAVAILABLE');
  let selected = product;
  let variantName = null;
  if (item.variantId !== null) {
    const variant = Array.isArray(product.variants) && product.variants.find(v => String(v.id) === item.variantId);
    if (!variant) throw new Error('VARIANT_NOT_FOUND');
    selected = variant;
    variantName = typeof variant.name === 'string' ? variant.name : null;
  }
  const pricePesewas = moneyToPesewas(selected.price);
  if (pricePesewas <= 0) throw new Error('INVALID_PRICE');
  return {
    productId: item.productId,
    variantId: item.variantId,
    name: String(product.name || 'Product').slice(0, 160),
    variantName,
    sku: selected.sku || product.sku || null,
    unitPricePesewas: pricePesewas,
    quantity: item.quantity,
    lineTotalPesewas: pricePesewas * item.quantity
  };
}

function calculateCoupon(coupon, subtotalPesewas, nowMs) {
  if (!coupon || coupon.active === false) throw new Error('COUPON_INVALID');
  if (coupon.expiresAt && new Date(coupon.expiresAt).getTime() < nowMs) throw new Error('COUPON_EXPIRED');
  if (coupon.maxUses && ((Number(coupon.usedCount) || 0) + (Number(coupon.reservedUses) || 0)) >= Number(coupon.maxUses)) throw new Error('COUPON_EXHAUSTED');
  const minOrder = coupon.minOrder == null ? 0 : moneyToPesewas(coupon.minOrder);
  if (subtotalPesewas < minOrder) throw new Error('COUPON_MINIMUM_NOT_MET');
  const value = Number(coupon.value);
  if (!Number.isFinite(value) || value <= 0) throw new Error('COUPON_INVALID');
  let discount;
  if (coupon.type === 'fixed') discount = Math.min(moneyToPesewas(value), subtotalPesewas);
  else if (coupon.type === 'percent' && value <= 100) discount = Math.min(Math.round(subtotalPesewas * value / 100), subtotalPesewas);
  else throw new Error('COUPON_INVALID');
  return discount;
}

async function createOrder(deps, input, uid) {
  const { db } = deps;
  const now = deps.now || Date.now;
  let request;
  try { request = normaliseRequest(input || {}, uid || null); }
  catch (e) { return { http: 400, json: { error: e.message } }; }

  const idempotencyRef = db.collection('orderIdempotency').doc(request.idempotencyKey);
  const prior = await idempotencyRef.get();
  if (prior.exists) {
    const saved = prior.data();
    if (saved.requestHash !== request.requestHash) return { http: 409, json: { error: 'IDEMPOTENCY_CONFLICT' } };
    return { http: 200, json: { status: 'existing', orderId: saved.orderId, orderRef: saved.orderRef, guestAccessSecret: request.guestAccessSecret } };
  }

  const reservationId = 'inv_' + crypto.randomBytes(16).toString('hex');
  const orderId = crypto.randomBytes(16).toString('hex');
  const orderRef = 'VX-' + crypto.randomBytes(5).toString('hex').toUpperCase();
  const guestSecret = request.uid ? null : request.guestAccessSecret;
  const guestSecretHash = request.guestAccessSecretHash;
  const orderRefDoc = db.collection('orders').doc(orderId);
  const accessRef = db.collection('orderAccess').doc(orderId);
  const reservationRef = db.collection('inventoryReservations').doc(reservationId);
  const couponRef = request.couponCode ? db.collection('coupons').doc(request.couponCode) : null;

  try {
    const result = await db.runTransaction(async tx => {
      // All reads happen before any writes. Inventory, order, coupon capacity and
      // idempotency are committed together as one Firestore transaction.
      const idemSnap = await tx.get(idempotencyRef);
      if (idemSnap.exists) {
        const existing = idemSnap.data();
        if (existing.requestHash !== request.requestHash) return { conflict: true };
        return { duplicate: true, orderId: existing.orderId, orderRef: existing.orderRef };
      }

      const reservationSnap = await tx.get(reservationRef);
      if (reservationSnap.exists) throw new Error('RESERVATION_ID_COLLISION');

      const productSnaps = new Map();
      for (const item of request.items) {
        if (!productSnaps.has(item.productId)) {
          const ref = db.collection('products').doc(item.productId);
          productSnaps.set(item.productId, { ref, snap: await tx.get(ref) });
        }
      }
      const couponSnap = couponRef ? await tx.get(couponRef) : null;

      const productUpdates = new Map();
      const lines = [];
      for (const item of request.items) {
        const entry = productSnaps.get(item.productId);
        if (!entry.snap.exists) throw new Error('PRODUCT_NOT_FOUND');
        let product = productUpdates.get(item.productId) || entry.snap.data();
        const line = resolveProductLine(product, item);
        const target = inventory.getStockTarget(product, item.variantId);
        if (target.stock - target.reservedStock < item.quantity) throw new Error('INSUFFICIENT_STOCK');
        product = inventory.withReservedStock(product, target, target.reservedStock + item.quantity);
        productUpdates.set(item.productId, product);
        lines.push(line);
      }

      const subtotalPesewas = lines.reduce((sum, line) => sum + line.lineTotalPesewas, 0);
      const deliveryPesewas = DELIVERY[request.deliveryMethod].pesewas;
      const discountPesewas = couponRef
        ? calculateCoupon(couponSnap && couponSnap.exists ? couponSnap.data() : null, subtotalPesewas, now())
        : 0;
      const totalPesewas = Math.max(0, subtotalPesewas - discountPesewas) + deliveryPesewas;
      if (!Number.isSafeInteger(totalPesewas)) throw new Error('INVALID_TOTAL');

      const createdAt = now();
      const reservation = {
        reservationId, orderId, items: request.items,
        status: 'RESERVED', createdAt,
        expiresAt: createdAt + inventory.DEFAULT_RESERVATION_TTL_MS,
        updatedAt: createdAt
      };
      const order = {
        schemaVersion: 1, orderId, orderRef, shopperUid: request.uid,
        customer: request.customer, items: lines,
        subtotalPesewas, discountPesewas, deliveryPesewas, totalPesewas, currency: 'GHS',
        deliveryMethod: request.deliveryMethod, paymentMethod: request.paymentMethod,
        paymentStatus: 'UNPAID',
        fulfilmentStatus: request.paymentMethod === 'cod' ? 'AWAITING_CONFIRMATION' : 'AWAITING_PAYMENT',
        reservationId, reservationExpiresAt: reservation.expiresAt,
        couponCode: request.couponCode, couponReservationStatus: couponRef ? 'RESERVED' : null,
        createdAt, updatedAt: createdAt, idempotencyKey: request.idempotencyKey
      };

      for (const [productId, product] of productUpdates) {
        tx.set(productSnaps.get(productId).ref, product, { merge: true });
      }
      tx.set(reservationRef, reservation);
      tx.create ? tx.create(orderRefDoc, order) : tx.set(orderRefDoc, order);
      if (guestSecretHash) tx.set(accessRef, { secretHash: guestSecretHash, createdAt, revokedAt: null });
      if (couponRef) {
        tx.set(couponRef, { reservedUses: (Number(couponSnap.data().reservedUses) || 0) + 1 }, { merge: true });
      }
      tx.set(idempotencyRef, { requestHash: request.requestHash, orderId, orderRef, createdAt });
      return { duplicate: false, orderId, orderRef, order };
    });

    if (result.conflict) return { http: 409, json: { error: 'IDEMPOTENCY_CONFLICT' } };
    if (result.duplicate) {
      return { http: 200, json: { status: 'existing', orderId: result.orderId, orderRef: result.orderRef, guestAccessSecret: request.guestAccessSecret } };
    }
    return {
      http: 201,
      json: {
        status: 'created', orderId, orderRef,
        totalPesewas: result.order.totalPesewas,
        currency: 'GHS', paymentStatus: result.order.paymentStatus,
        reservationExpiresAt: result.order.reservationExpiresAt,
        guestAccessSecret: guestSecret
      }
    };
  } catch (e) {
    // A transaction may have committed even if the caller observed a transport error.
    // Re-check the idempotency record before returning failure.
    try {
      const committed = await idempotencyRef.get();
      if (committed.exists && committed.data().requestHash === request.requestHash) {
        const saved = committed.data();
        return { http: 200, json: { status: 'existing', orderId: saved.orderId, orderRef: saved.orderRef, guestAccessSecret: request.guestAccessSecret } };
      }
    } catch (readError) {
      // The transaction remains atomic; report a retryable failure below.
    }
    const known = [
      'PRODUCT_NOT_FOUND','PRODUCT_UNAVAILABLE','VARIANT_NOT_FOUND','STOCK_NOT_CONFIGURED',
      'INSUFFICIENT_STOCK','INVALID_PRICE','COUPON_INVALID','COUPON_EXPIRED',
      'COUPON_EXHAUSTED','COUPON_MINIMUM_NOT_MET','INVALID_TOTAL',
      'EXPRESS_DELIVERY_AREA_RESTRICTED','INVALID_GUEST_ACCESS_SECRET'
    ];
    if (known.includes(e.message)) {
      return { http: e.message === 'INSUFFICIENT_STOCK' ? 409 : 400, json: { error: e.message } };
    }
    return { http: 500, json: { error: 'ORDER_CREATION_FAILED' } };
  }
}

module.exports = { DELIVERY, moneyToPesewas, normaliseRequest, resolveProductLine, calculateCoupon, createOrder };
