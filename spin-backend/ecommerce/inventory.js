'use strict';

// Server-only inventory reservation primitives.
// Product.stock / variant.stock represent physical sellable stock.
// reservedStock is a counter maintained only by this module.
// Available quantity = stock - reservedStock.

const crypto = require('crypto');

const DEFAULT_RESERVATION_TTL_MS = 15 * 60 * 1000;
const MAX_RESERVATION_TTL_MS = 60 * 60 * 1000;

function normaliseItems(items) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('At least one inventory item is required');
  const merged = new Map();
  for (const item of items) {
    const productId = String(item && item.productId || '').trim();
    const variantId = item && item.variantId != null ? String(item.variantId).trim() : null;
    const quantity = Number(item && item.quantity);
    if (!productId || productId.length > 128) throw new Error('Invalid productId');
    if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 99) throw new Error('Quantity must be an integer from 1 to 99');
    if (variantId !== null && (!variantId || variantId.length > 128)) throw new Error('Invalid variantId');
    const key = productId + '::' + (variantId || '');
    const current = merged.get(key) || { productId, variantId, quantity: 0 };
    current.quantity += quantity;
    if (current.quantity > 99) throw new Error('Combined item quantity exceeds 99');
    merged.set(key, current);
  }
  return [...merged.values()].sort((a, b) =>
    a.productId.localeCompare(b.productId) || String(a.variantId || '').localeCompare(String(b.variantId || ''))
  );
}

function fingerprint(items) {
  return crypto.createHash('sha256').update(JSON.stringify(items)).digest('hex');
}

function validReservationId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{12,128}$/.test(id);
}

function getStockTarget(product, variantId) {
  if (variantId === null) {
    if (!Number.isSafeInteger(product.stock) || product.stock < 0) {
      throw new Error('STOCK_NOT_CONFIGURED');
    }
    return { stock: product.stock, reservedStock: Number.isSafeInteger(product.reservedStock) && product.reservedStock >= 0 ? product.reservedStock : 0 };
  }
  const variants = Array.isArray(product.variants) ? product.variants : [];
  const index = variants.findIndex(v => String(v.id) === variantId);
  if (index < 0) throw new Error('VARIANT_NOT_FOUND');
  const variant = variants[index];
  if (!Number.isSafeInteger(variant.stock) || variant.stock < 0) {
    throw new Error('STOCK_NOT_CONFIGURED');
  }
  return {
    stock: variant.stock,
    reservedStock: Number.isSafeInteger(variant.reservedStock) && variant.reservedStock >= 0 ? variant.reservedStock : 0,
    variants,
    index
  };
}

function withReservedStock(product, target, nextReservedStock) {
  if (target.variants) {
    const variants = target.variants.map((v, i) => i === target.index ? { ...v, reservedStock: nextReservedStock } : v);
    return { ...product, variants };
  }
  return { ...product, reservedStock: nextReservedStock };
}

async function reserveInventory(deps, input) {
  const { db } = deps;
  const now = deps.now || Date.now;
  const reservationId = input && input.reservationId;
  if (!validReservationId(reservationId)) return { ok: false, code: 'INVALID_RESERVATION_ID' };

  let items;
  try { items = normaliseItems(input.items); }
  catch (e) { return { ok: false, code: 'INVALID_ITEMS', message: e.message }; }

  const ttlMs = input.ttlMs == null ? DEFAULT_RESERVATION_TTL_MS : Number(input.ttlMs);
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 60 * 1000 || ttlMs > MAX_RESERVATION_TTL_MS) {
    return { ok: false, code: 'INVALID_TTL' };
  }
  const requestHash = fingerprint(items);
  const reservationRef = db.collection('inventoryReservations').doc(reservationId);
  const productRefs = [...new Set(items.map(i => i.productId))].map(id => ({
    id, ref: db.collection('products').doc(id)
  }));

  try {
    return await db.runTransaction(async tx => {
      const existingSnap = await tx.get(reservationRef);
      if (existingSnap.exists) {
        const existing = existingSnap.data();
        if (existing.requestHash !== requestHash) return { ok: false, code: 'IDEMPOTENCY_CONFLICT' };
        return { ok: true, duplicate: true, reservation: existing };
      }

      const productSnaps = new Map();
      for (const entry of productRefs) productSnaps.set(entry.id, await tx.get(entry.ref));

      const updates = new Map();
      for (const item of items) {
        const snap = productSnaps.get(item.productId);
        if (!snap || !snap.exists) return { ok: false, code: 'PRODUCT_NOT_FOUND', productId: item.productId };
        let product = updates.get(item.productId) || snap.data();
        if (product.status && product.status !== 'active') return { ok: false, code: 'PRODUCT_UNAVAILABLE', productId: item.productId };
        let target;
        try { target = getStockTarget(product, item.variantId); }
        catch (e) { return { ok: false, code: e.message, productId: item.productId, variantId: item.variantId }; }
        if (target.stock - target.reservedStock < item.quantity) {
          return { ok: false, code: 'INSUFFICIENT_STOCK', productId: item.productId, variantId: item.variantId };
        }
        product = withReservedStock(product, target, target.reservedStock + item.quantity);
        updates.set(item.productId, product);
      }

      for (const entry of productRefs) tx.set(entry.ref, updates.get(entry.id), { merge: true });
      const createdAt = now();
      const reservation = {
        reservationId, items, requestHash, status: 'RESERVED',
        createdAt, expiresAt: createdAt + ttlMs, updatedAt: createdAt
      };
      tx.create ? tx.create(reservationRef, reservation) : tx.set(reservationRef, reservation);
      return { ok: true, duplicate: false, reservation };
    });
  } catch (e) {
    return { ok: false, code: 'RESERVATION_FAILED', message: e.message };
  }
}

async function transitionReservation(deps, reservationId, action) {
  const { db } = deps;
  const now = deps.now || Date.now;
  if (!validReservationId(reservationId)) return { ok: false, code: 'INVALID_RESERVATION_ID' };
  const reservationRef = db.collection('inventoryReservations').doc(reservationId);
  try {
    return await db.runTransaction(async tx => {
      const reservationSnap = await tx.get(reservationRef);
      if (!reservationSnap.exists) return { ok: false, code: 'RESERVATION_NOT_FOUND' };
      const reservation = reservationSnap.data();
      if (reservation.status === action) return { ok: true, duplicate: true, status: action };
      if (reservation.status !== 'RESERVED') return { ok: false, code: 'INVALID_RESERVATION_STATE', status: reservation.status };
      const timestamp = now();
      if (action === 'RELEASED' && timestamp < reservation.expiresAt) {
        return { ok: false, code: 'RESERVATION_NOT_EXPIRED' };
      }
      if (action === 'COMMITTED' && timestamp >= reservation.expiresAt) {
        return { ok: false, code: 'RESERVATION_EXPIRED' };
      }

      const productIds = [...new Set(reservation.items.map(i => i.productId))];
      const products = new Map();
      for (const id of productIds) {
        const ref = db.collection('products').doc(id);
        const snap = await tx.get(ref);
        if (!snap.exists) return { ok: false, code: 'PRODUCT_NOT_FOUND', productId: id };
        products.set(id, { ref, data: snap.data() });
      }

      const updated = new Map();
      for (const item of reservation.items) {
        let product = updated.get(item.productId) || products.get(item.productId).data;
        let target;
        try { target = getStockTarget(product, item.variantId); }
        catch (e) { return { ok: false, code: e.message, productId: item.productId }; }
        if (target.reservedStock < item.quantity) return { ok: false, code: 'RESERVATION_COUNTER_MISMATCH', productId: item.productId };
        if (action === 'COMMITTED' && target.stock < item.quantity) return { ok: false, code: 'STOCK_COUNTER_MISMATCH', productId: item.productId };
        const nextReserved = target.reservedStock - item.quantity;
        if (action === 'COMMITTED') {
          if (target.variants) {
            const variants = target.variants.map((v, i) => i === target.index ? { ...v, stock: v.stock - item.quantity, reservedStock: nextReserved } : v);
            product = { ...product, variants };
          } else {
            product = { ...product, stock: target.stock - item.quantity, reservedStock: nextReserved };
          }
        } else {
          product = withReservedStock(product, target, nextReserved);
        }
        updated.set(item.productId, product);
      }
      for (const id of productIds) tx.set(products.get(id).ref, updated.get(id), { merge: true });
      tx.set(reservationRef, { status: action, updatedAt: timestamp }, { merge: true });
      return { ok: true, duplicate: false, status: action };
    });
  } catch (e) {
    return { ok: false, code: 'RESERVATION_TRANSITION_FAILED', message: e.message };
  }
}

async function releaseExpiredReservation(deps, reservationId) {
  return transitionReservation(deps, reservationId, 'RELEASED');
}

async function commitReservation(deps, reservationId) {
  return transitionReservation(deps, reservationId, 'COMMITTED');
}

module.exports = {
  DEFAULT_RESERVATION_TTL_MS,
  normaliseItems,
  reserveInventory,
  releaseExpiredReservation,
  commitReservation
};
