'use strict';
// spin-backend/payments.js
// Server-authoritative Spin coin purchases. The browser may ask for a package,
// but price and coin quantity are defined HERE and checked against the amount
// Paystack itself reports. One idempotent credit path serves both
// /api/verify-purchase and the Paystack webhook.

const crypto = require('crypto');

const catalog = require('./catalog');
const safety = require('./safety');
const ball = require('./ball-payments');

// Derived from the canonical catalogue (legacy ids kept for the existing client).
const SPIN_PACKAGES = Object.freeze(Object.fromEntries(['SPIN_100', 'SPIN_250', 'SPIN_500'].map((id) => {
  const p = catalog.PACKAGES[id];
  return [p.legacyId, Object.freeze({ id: p.legacyId, priceGhs: p.pesewas / 100, pesewas: p.pesewas, coins: p.credits })];
})));
const PACKAGE_BY_PESEWAS = Object.freeze(
  Object.values(SPIN_PACKAGES).reduce((m, p) => { m[p.pesewas] = p; return m; }, {})
);

const LEASE_MS = 60 * 1000;
const REFERRAL_BONUS_COINS = 40;
const REFERRAL_MIN_PRICE_GHS = 10;
const REF_RE = /^[A-Za-z0-9_-]{6,64}$/;
const REFCODE_RE = /^[A-Za-z0-9]{3,32}$/;

const digitsOf = (s) => String(s == null ? '' : s).replace(/\D/g, '');
const isValidReference = (r) => typeof r === 'string' && REF_RE.test(r);
const isValidPhone = (p) =>
  typeof p === 'string' && p.length <= 24 && !/[\/\\]/.test(p) && digitsOf(p).length >= 7;
const isAlreadyExists = (e) => !!e && (e.code === 6 || /already exists/i.test(String(e.message || '')));

// ---------- idempotency (shared by every payment purpose) ----------
// paymentEvents/{reference}: PROCESSING -> SUCCESS | FAILED.
async function claimReference(db, reference, purpose, nowMs) {
  const evRef = db.collection('paymentEvents').doc(reference);
  const token = crypto.randomBytes(12).toString('hex');
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(evRef);
    const prev = snap.exists ? snap.data() : null;
    if (prev && (prev.status === 'SUCCESS' || prev.status === 'REFUNDED')) return { state: 'ALREADY_PROCESSED' };
    if (prev && prev.status === 'PROCESSING' && prev.leaseExpiresAt > nowMs) return { state: 'IN_PROGRESS' };
    tx.set(evRef, {
      status: 'PROCESSING', purpose, leaseToken: token, leaseExpiresAt: nowMs + LEASE_MS,
      attempts: ((prev && prev.attempts) || 0) + 1,
      createdAt: (prev && prev.createdAt) || nowMs, updatedAt: nowMs,
    }, { merge: true });
    return { state: 'CLAIMED', token };
  });
}

async function failReference(db, reference, token, code, details, nowMs) {
  const evRef = db.collection('paymentEvents').doc(reference);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(evRef);
    if (!snap.exists || snap.data().leaseToken !== token || snap.data().status !== 'PROCESSING') return;
    tx.set(evRef, { status: 'FAILED', failureCode: code, details: details || null, leaseExpiresAt: 0, updatedAt: nowMs }, { merge: true });
  });
}

// ---------- credit ----------
async function creditSpinPurchase(deps, reference) {
  const { db, FieldValue, paystackVerify } = deps;
  const now = deps.now || Date.now;
  const inc = (n) => FieldValue.increment(n);

  if (!isValidReference(reference)) return { http: 400, json: { error: 'Invalid reference' } };

  const purchaseRef = db.collection('coinPurchases').doc(reference);
  const purchaseSnap = await purchaseRef.get();
  if (!purchaseSnap.exists) return { http: 404, json: { error: 'Purchase record not found' } };
  const purchase = purchaseSnap.data();
  const walletOf = async () => {
    const w = await db.collection('wallets').doc(purchase.phone).get();
    return w.exists ? (w.data().coins || 0) : 0;
  };

  // Purchases confirmed before this change are already credited.
  if (purchase.status === 'confirmed') {
    return { http: 200, json: { status: 'already_confirmed', coins: await walletOf() } };
  }

  // A reference that already paid for balls can never pay for coins.
  const used = await db.collection('transactions').where('reference', '==', reference).get();
  if (used.docs.some((d) => (d.data() || {}).status === 'completed')) {
    return { http: 409, json: { error: 'Reference already used' } };
  }

  const claim = await claimReference(db, reference, 'spinCoins', now());
  if (claim.state === 'ALREADY_PROCESSED') {
    return { http: 200, json: { status: 'already_confirmed', coins: await walletOf() } };
  }
  if (claim.state === 'IN_PROGRESS') return { http: 409, code: 'IN_PROGRESS', json: { status: 'processing' } };
  const token = claim.token;
  const fail = async (http, code, error, details, extra) => {
    await failReference(db, reference, token, code, details, now());
    return Object.assign({ http, json: { error, code } }, extra || {});
  };

  let verified;
  try {
    verified = await paystackVerify(reference);
  } catch (e) {
    await failReference(db, reference, token, 'VERIFY_UNAVAILABLE', null, now());
    return { http: 502, transient: true, json: { error: 'Could not reach payment provider, try again' } };
  }
  if (!verified || !verified.found || !verified.data) return fail(400, 'INVALID_REFERENCE', 'Invalid reference');
  const data = verified.data;
  if (data.reference && data.reference !== reference) return fail(400, 'REFERENCE_MISMATCH', 'Reference mismatch');
  if (data.status !== 'success') {
    return fail(400, 'NOT_SUCCESSFUL', 'Payment not successful', { paystackStatus: String(data.status) });
  }
  if (data.currency !== 'GHS') return fail(400, 'BAD_CURRENCY', 'Unsupported currency');
  const paid = Number(data.amount);
  const pkg = Number.isInteger(paid) ? PACKAGE_BY_PESEWAS[paid] : null;
  if (!pkg) return fail(400, 'AMOUNT_MISMATCH', 'Amount does not match a coin package', { amountPesewas: paid });
  if (purchase.requestedPackageId && purchase.requestedPackageId !== pkg.id) {
    return fail(400, 'AMOUNT_MISMATCH', 'Amount does not match the requested package', { amountPesewas: paid });
  }
  const emailLocal = String((data.customer && data.customer.email) || '').split('@')[0];
  if (!digitsOf(emailLocal) || digitsOf(emailLocal) !== digitsOf(purchase.phone)) {
    return fail(400, 'IDENTITY_MISMATCH', 'Payment does not belong to this wallet');
  }

  const evRef = db.collection('paymentEvents').doc(reference);
  const walletRef = db.collection('wallets').doc(purchase.phone);
  let lostLease = false;
  await db.runTransaction(async (tx) => {
    lostLease = false;
    // ---- all reads first ----
    const evSnap = await tx.get(evRef);
    const ev = evSnap.exists ? evSnap.data() : null;
    if (!ev || ev.status !== 'PROCESSING' || ev.leaseToken !== token) { lostLease = true; return; }
    const walletSnap = await tx.get(walletRef);
    const wasFirstPurchase = !walletSnap.exists || !walletSnap.data().hasPurchasedBefore;
    let referral = null;
    if (wasFirstPurchase && pkg.priceGhs >= REFERRAL_MIN_PRICE_GHS &&
        purchase.spinRefCode && REFCODE_RE.test(purchase.spinRefCode)) {
      const codeSnap = await tx.get(db.collection('spinReferralCodes').doc(purchase.spinRefCode));
      if (codeSnap.exists) {
        const referrerPhone = codeSnap.data().phone;
        if (referrerPhone && referrerPhone !== purchase.phone) {
          const prior = await tx.get(db.collection('spinReferrals')
            .where('referredPhone', '==', purchase.phone).where('status', '==', 'rewarded'));
          if (prior.empty) {
            const referrerRef = db.collection('wallets').doc(referrerPhone);
            const referrerSnap = await tx.get(referrerRef);
            referral = {
              referrerPhone, referrerRef,
              referrerName: referrerSnap.exists ? (referrerSnap.data().name || 'Unknown') : 'Unknown',
            };
          }
        }
      }
    }
    // ---- writes ----
    const bonus = referral ? REFERRAL_BONUS_COINS : 0;
    tx.set(walletRef, {
      coins: inc(pkg.coins + bonus), totalSpend: inc(pkg.priceGhs), hasPurchasedBefore: true,
    }, { merge: true });
    if (referral) {
      tx.set(referral.referrerRef, { coins: inc(REFERRAL_BONUS_COINS) }, { merge: true });
      tx.set(db.collection('spinReferrals').doc(), {
        referrerPhone: referral.referrerPhone, referrerName: referral.referrerName,
        referredPhone: purchase.phone,
        referredName: purchase.name || (walletSnap.exists ? walletSnap.data().name : null) || 'Unknown',
        coinsAwarded: REFERRAL_BONUS_COINS, status: 'rewarded', rewardedAt: new Date(now()).toISOString(),
      });
    }
    tx.update(purchaseRef, {
      status: 'confirmed', confirmedAt: new Date(now()).toISOString(),
      packageId: pkg.id, coinsCredited: pkg.coins, amountPesewas: paid,
    });
    tx.set(evRef, {
      status: 'SUCCESS', purpose: 'spinCoins', packageId: pkg.id, amountPesewas: paid,
      credited: pkg.coins, leaseExpiresAt: 0, updatedAt: now(),
    }, { merge: true });
  });
  if (lostLease) return { http: 409, code: 'IN_PROGRESS', json: { status: 'processing' } };
  await safety.audit(deps, { type: 'payment.credited', purpose: 'spinCoins', packageId: pkg.id, amountPesewas: paid, credits: pkg.coins, ref: reference, actor: purchase.phone });
  await safety.recordPayment(deps, { purpose: 'spinCoins', amountPesewas: paid, feesPesewas: Number.isInteger(data.fees) ? data.fees : undefined, credits: pkg.coins });
  return { http: 200, json: { status: 'confirmed', coins: await walletOf() } };
}

// ---------- endpoint handlers (thin wrappers in server.js call these) ----------
async function handleBuyCoins(deps, body) {
  const { db } = deps;
  const { phone, ref, spinRefCode, name, packageId, coins, priceGHC } = body || {};
  if (!isValidReference(ref)) return { http: 400, json: { error: 'Invalid reference' } };
  if (!isValidPhone(phone)) return { http: 400, json: { error: 'Valid phone required' } };
  let requested = null;
  if (packageId !== undefined && packageId !== null) {
    const cp = catalog.getPackage(packageId);
    if (!cp || cp.purpose !== 'spinCoins') return { http: 400, json: { error: 'Unknown package' } };
    requested = cp.legacyId;
  }
  const purchaseRef = db.collection('coinPurchases').doc(ref);
  const record = {
    phone,
    name: typeof name === 'string' ? name.slice(0, 80) : null,
    spinRefCode: typeof spinRefCode === 'string' && REFCODE_RE.test(spinRefCode) ? spinRefCode : null,
    requestedPackageId: requested,
    // Audit only. Never used to decide price or coins.
    clientClaim: { coins: Number(coins) || null, priceGHC: Number(priceGHC) || null },
    status: 'pending',
    createdAt: new Date((deps.now || Date.now)()).toISOString(),
  };
  try {
    await purchaseRef.create(record);
  } catch (e) {
    if (!isAlreadyExists(e)) throw e;
    const existing = (await purchaseRef.get()).data() || {};
    if (existing.phone !== phone) return { http: 409, json: { error: 'Reference already used' } };
    return { http: 200, json: { status: existing.status === 'confirmed' ? 'confirmed' : 'pending' } };
  }
  return { http: 200, json: { status: 'pending' } };
}

async function handleVerifyPurchase(deps, body) {
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const reference = body && body.reference;
  let result;
  for (let i = 0; i < 6; i++) {
    result = await creditSpinPurchase(deps, reference);
    if (result.code !== 'IN_PROGRESS') break;
    await sleep(1000);
  }
  return result;
}

function verifyWebhookSignature(rawBody, signature, secret) {
  if (!secret || !signature || !rawBody) return false;
  const expected = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Server-created purchase: the SERVER picks the reference and the amount, and records the purchase
// BEFORE the customer pays, so the webhook can credit it even if the browser closes mid-checkout.
async function handleQuoteCoins(deps, body) {
  const { phone, packageId, spinRefCode, name } = body || {};
  if (!isValidPhone(phone)) return { http: 400, json: { error: 'Valid phone required' } };
  const cp = catalog.getPackage(packageId);
  if (!cp || cp.purpose !== 'spinCoins') return { http: 400, json: { error: 'Unknown package' } };
  const rl = await safety.rateLimit(deps, 'quote-coins:' + digitsOf(phone), 10, 60 * 60 * 1000);
  if (!rl.ok) return { http: 429, json: { error: 'Too many requests, try again later' } };
  const reference = 'COINS-' + crypto.randomBytes(10).toString('hex');
  const res = await handleBuyCoins(deps, { phone, ref: reference, spinRefCode, name, packageId: cp.legacyId });
  if (res.http !== 200) return res;
  return { http: 200, json: { reference, packageId: cp.id, amountPesewas: cp.pesewas, currency: catalog.CURRENCY, coins: cp.credits, email: digitsOf(phone) + '@voltix.com' } };
}

// Webhook: signature is verified over the raw body with HMAC-SHA512 (timing-safe) BEFORE anything
// else happens. charge.success -> the same idempotent credit path as manual verification.
// refund.* -> never auto-debits: marks the reference and opens a manual review item.
async function handleWebhook(deps, { rawBody, signature }) {
  if (!verifyWebhookSignature(rawBody, signature, deps.paystackSecret)) {
    return { http: 401, text: 'Invalid signature' };
  }
  let event;
  try { event = JSON.parse(rawBody.toString('utf8')); } catch (e) { return { http: 400, text: 'Bad payload' }; }
  const type = event && event.event;
  const d = (event && event.data) || {};
  const { db } = deps;

  if (type === 'charge.success' && isValidReference(d.reference)) {
    const ref = d.reference;
    if ((await db.collection('coinPurchases').doc(ref).get()).exists) {
      const r = await creditSpinPurchase(deps, ref);
      if (r.transient) return { http: 500, text: 'Retry later' };
    } else if ((await db.collection('paymentIntents').doc(ref).get()).exists) {
      const r = await ball.creditBallPayment(deps, { reference: ref });
      if (r.http === 502) return { http: 500, text: 'Retry later' };
    }
    return { http: 200, text: 'OK' };
  }

  if (typeof type === 'string' && type.startsWith('refund.')) {
    const ref = d.transaction_reference || (d.transaction && d.transaction.reference);
    if (isValidReference(ref)) {
      const evRef = db.collection('paymentEvents').doc(ref);
      const ev = await evRef.get();
      if (ev.exists && type === 'refund.processed') {
        // status stays SUCCESS so the reference can never be credited again; credits are NOT clawed back automatically.
        await evRef.set({ refunded: true, refundedAt: (deps.now || Date.now)() }, { merge: true });
        await db.collection('reviewQueue').doc('refund-' + ref).set({
          type: 'refund', ref, purpose: ev.data().purpose || null, credited: ev.data().credited || 0,
          status: 'open', note: 'Refund processed by Paystack. Credits were NOT reversed automatically.',
          createdAt: (deps.now || Date.now)(),
        }, { merge: true });
      }
      await safety.audit(deps, { type: type, ref, status: d.status });
    }
    return { http: 200, text: 'OK' };
  }
  return { http: 200, text: 'OK' };
}

module.exports = {
  SPIN_PACKAGES, PACKAGE_BY_PESEWAS, claimReference, failReference, creditSpinPurchase,
  handleBuyCoins, handleQuoteCoins, handleVerifyPurchase, handleWebhook, verifyWebhookSignature,
  isValidReference, isValidPhone,
};
