'use strict';

const crypto = require('crypto');

const WINDOW_MS = 15 * 60 * 1000;
const IP_LIMIT = 12;
const PHONE_LIMIT = 5;
const ALLOWED_STATUSES = new Set(['Processing', 'Packed', 'Shipped', 'Delivered', 'Cancelled']);

function normalizePhone(value) {
  if (typeof value !== 'string') return '';
  let digits = value.replace(/\\D/g, '');
  if (digits.startsWith('00233') && digits.length === 14) digits = '0' + digits.slice(5);
  else if (digits.startsWith('233') && digits.length === 12) digits = '0' + digits.slice(3);
  return digits;
}

function hashKey(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function validReference(value) {
  return typeof value === 'string' && /^#?[A-Z0-9-]{4,32}$/i.test(value.trim());
}

async function consumeRateLimit(db, ip, phone, now) {
  const limits = [
    { key: 'ip_' + hashKey(ip || 'unknown'), max: IP_LIMIT },
    { key: 'phone_' + hashKey(phone), max: PHONE_LIMIT },
  ];
  return db.runTransaction(async (tx) => {
    const refs = limits.map((x) => db.collection('orderStatusRateLimits').doc(x.key));
    const snaps = [];
    for (const ref of refs) snaps.push(await tx.get(ref));
    for (let i = 0; i < snaps.length; i++) {
      const data = snaps[i].exists ? snaps[i].data() : {};
      if (data.windowStartedAt && now - data.windowStartedAt < WINDOW_MS && data.count >= limits[i].max) {
        return false;
      }
    }
    for (let i = 0; i < refs.length; i++) {
      const data = snaps[i].exists ? snaps[i].data() : {};
      const sameWindow = data.windowStartedAt && now - data.windowStartedAt < WINDOW_MS;
      tx.set(refs[i], {
        windowStartedAt: sameWindow ? data.windowStartedAt : now,
        count: sameWindow ? data.count + 1 : 1,
        updatedAt: now,
      });
    }
    return true;
  });
}

async function lookupOrderStatus(deps, input) {
  const { db } = deps;
  const now = deps.now || Date.now;
  const body = input || {};
  const reference = typeof body.reference === 'string' ? body.reference.trim() : '';
  const phone = normalizePhone(body.phone);
  if (!validReference(reference) || phone.length < 9 || phone.length > 15) {
    return { http: 400, json: { found: false, error: 'Enter a valid order reference and phone number.' } };
  }

  const allowed = await consumeRateLimit(db, body.ip, phone, now());
  if (!allowed) return { http: 429, json: { found: false, error: 'Too many lookup attempts. Try again in 15 minutes.' } };

  const snapshot = await db.collection('orders').where('ref', '==', reference).get();
  const match = snapshot.docs.find((doc) => normalizePhone((doc.data().customer || {}).phone) === phone);
  if (!match) return { http: 404, json: { found: false, error: 'Order not found. Check the reference and phone number.' } };

  const rawStatus = match.data().status;
  if (!ALLOWED_STATUSES.has(rawStatus)) {
    return { http: 404, json: { found: false, error: 'Order not found. Check the reference and phone number.' } };
  }
  // Intentionally return only the current status. Do not disclose address, items,
  // totals, payment details, or the full order document to unauthenticated callers.
  return { http: 200, json: { found: true, reference, status: rawStatus } };
}

module.exports = { lookupOrderStatus, normalizePhone, validReference, consumeRateLimit };
