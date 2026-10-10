'use strict';
// lib/ball-payments.js  (identical copy: spin-backend/ball-payments.js)
// Server-authoritative credit for balls and Sneaker Sink coins.
// Two ways in, both converge on ONE idempotent credit path keyed by the Paystack reference:
//   1) INTENT path  (new): the server created paymentIntents/{reference} with the exact amount,
//      package, quantity and owner BEFORE the customer paid. The verified Paystack amount must
//      equal the intent exactly. Works from the webhook and from recovery with no browser at all.
//   2) LEGACY path (unchanged behaviour): no intent exists, so the package is derived from the
//      verified amount using the catalogue, and the owner must match when Paystack names one.
// Anything the browser sends (balls, amountGhc, type) never decides what is credited.

const crypto = require('crypto');
const catalog = require('./catalog');
const safety = require('./safety');

const LEASE_MS = 60 * 1000;
const REF_RE = /^[A-Za-z0-9_-]{6,64}$/;
const isValidReference = (r) => typeof r === 'string' && REF_RE.test(r);
const isValidUserId = (u) => typeof u === 'string' && u.length >= 1 && u.length <= 128 && !/[\/\\]/.test(u);

// Kept for compatibility with Phase 1B callers/tests.
function packageForPesewas(paid) {
  const r = catalog.resolveByAmount('balls', paid);
  return r ? { id: r.packageId, balls: r.credits, type: r.pkg.kind === 'continue' ? 'continue' : 'purchase', priceGhs: r.pesewas / 100 } : null;
}
function sinkPackageForPesewas(paid) {
  const r = catalog.resolveByAmount('sinkCoins', paid);
  return r ? { id: r.packageId, balls: r.credits, type: 'sinkCoins', priceGhs: r.pesewas / 100, field: 'sinkCoins' } : null;
}

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

async function creditBallPayment(deps, body) {
  const { db, FieldValue, paystackVerify } = deps;
  const now = deps.now || Date.now;
  const reference = body && body.reference;
  if (!isValidReference(reference)) return { http: 400, json: { success: false, error: 'Invalid reference' } };

  // Intent (server-created quote) takes precedence over anything the browser says.
  const intentRef = db.collection('paymentIntents').doc(reference);
  const intentSnap = await intentRef.get();
  const intent = intentSnap.exists ? intentSnap.data() : null;
  const userId = intent ? intent.userId : (body && body.userId);
  if (!isValidUserId(userId)) return { http: 400, json: { success: false, error: 'Missing required fields' } };
  if (intent && body && body.userId && body.userId !== intent.userId) {
    await safety.audit(deps, { type: 'payment.rejected', code: 'INTENT_OWNER_MISMATCH', ref: reference, actor: body.userId });
    return { http: 403, json: { success: false, error: 'Payment does not belong to this player' } };
  }

  // Already credited before this change? Only COMPLETED legacy records count.
  const legacy = await db.collection('transactions').where('reference', '==', reference).get();
  if (legacy.docs.some((d) => (d.data() || {}).status === 'completed')) {
    return { http: 200, json: { success: true, note: 'Already processed' } };
  }
  // A reference that already paid for spin coins can never pay for balls.
  const spin = await db.collection('coinPurchases').doc(reference).get();
  if (spin.exists) return { http: 409, json: { success: false, error: 'Reference already used' } };

  const purposeHint = intent ? intent.purpose : null;
  const claim = await claimReference(db, reference, purposeHint || 'balls', now());
  if (claim.state === 'ALREADY_PROCESSED') return { http: 200, json: { success: true, note: 'Already processed' } };
  if (claim.state === 'IN_PROGRESS') return { http: 409, code: 'IN_PROGRESS', json: { success: false, error: 'Processing, retry shortly' } };
  const token = claim.token;
  const fail = async (http, code, error, details) => {
    await failReference(db, reference, token, code, details, now());
    await safety.audit(deps, { type: 'payment.rejected', code, ref: reference, actor: userId, amountPesewas: details && details.amountPesewas });
    return { http, json: { success: false, error, code } };
  };

  let verified;
  try {
    verified = await paystackVerify(reference);
  } catch (e) {
    await failReference(db, reference, token, 'VERIFY_UNAVAILABLE', null, now());
    return { http: 502, json: { success: false, error: 'Could not reach payment provider, try again' } };
  }
  if (!verified || !verified.found || !verified.data) return fail(400, 'INVALID_REFERENCE', 'Invalid reference');
  const data = verified.data;
  if (data.reference && data.reference !== reference) return fail(400, 'REFERENCE_MISMATCH', 'Reference mismatch');
  if (data.status !== 'success') return fail(400, 'NOT_SUCCESSFUL', 'Payment not verified as successful', { paystackStatus: String(data.status) });
  if (data.currency !== catalog.CURRENCY) return fail(400, 'BAD_CURRENCY', 'Unsupported currency');
  const paid = Number(data.amount);
  const meta = data.metadata && typeof data.metadata === 'object' ? data.metadata : {};

  let priced; // { packageId, credits, pesewas, purpose, field }
  if (intent) {
    const expected = catalog.priceFor(intent.catalogId || String(intent.packageId).split('_X')[0], intent.qty);
    if (!expected || expected.pesewas !== intent.amountPesewas || expected.credits !== intent.credits) {
      return fail(400, 'INTENT_INVALID', 'Payment intent is not valid', { amountPesewas: paid });
    }
    if (paid !== expected.pesewas) return fail(400, 'AMOUNT_MISMATCH', 'Amount does not match the quote', { amountPesewas: paid });
    priced = { packageId: expected.packageId, credits: expected.credits, pesewas: expected.pesewas, purpose: expected.pkg.purpose, kind: expected.pkg.kind };
  } else {
    const isSink = meta.type === 'sinkCoins';
    const r = catalog.resolveByAmount(isSink ? 'sinkCoins' : 'balls', paid);
    if (!r) return fail(400, 'AMOUNT_MISMATCH', 'Amount does not match a ball package', { amountPesewas: paid });
    priced = { packageId: r.packageId, credits: r.credits, pesewas: r.pesewas, purpose: r.pkg.purpose, kind: r.pkg.kind };
    // The payment must belong to this player when Paystack tells us who paid.
    const email = String((data.customer && data.customer.email) || '');
    const ownerHint = meta.userId || (/@voltix-player\.app$/i.test(email) ? email.split('@')[0] : null);
    if (ownerHint && ownerHint !== userId) return fail(400, 'IDENTITY_MISMATCH', 'Payment does not belong to this player');
  }
  const field = catalog.WALLET_FIELD[priced.purpose];
  const isSink = priced.purpose === 'sinkCoins';

  const evRef = db.collection('paymentEvents').doc(reference);
  const userRef = db.collection('users').doc(userId);
  let lostLease = false;
  await db.runTransaction(async (tx) => {
    lostLease = false;
    const evSnap = await tx.get(evRef);
    const ev = evSnap.exists ? evSnap.data() : null;
    if (!ev || ev.status !== 'PROCESSING' || ev.leaseToken !== token) { lostLease = true; return; }
    tx.set(userRef, { [field]: FieldValue.increment(priced.credits) }, { merge: true });
    tx.set(db.collection('transactions').doc(), {
      userId, type: isSink ? 'sinkCoins' : (priced.kind === 'continue' ? 'continue' : 'purchase'),
      balls: priced.credits, amountGhc: priced.pesewas / 100, reference,
      packageId: priced.packageId, status: 'completed', createdAt: FieldValue.serverTimestamp(),
    });
    if (intent) tx.set(intentRef, { status: 'CREDITED', creditedAt: now() }, { merge: true });
    tx.set(evRef, {
      status: 'SUCCESS', purpose: priced.purpose, packageId: priced.packageId, amountPesewas: paid,
      credited: priced.credits, userId, viaIntent: !!intent, leaseExpiresAt: 0, updatedAt: now(),
    }, { merge: true });
  });
  if (lostLease) return { http: 409, code: 'IN_PROGRESS', json: { success: false, error: 'Processing, retry shortly' } };

  await safety.audit(deps, { type: 'payment.credited', purpose: priced.purpose, packageId: priced.packageId, amountPesewas: paid, credits: priced.credits, ref: reference, actor: userId });
  await safety.recordPayment(deps, { purpose: priced.purpose, amountPesewas: paid, feesPesewas: Number.isInteger(data.fees) ? data.fees : undefined, credits: priced.credits });
  return { http: 200, json: { success: true, ballsAdded: priced.credits, coinsAdded: isSink ? priced.credits : 0 } };
}

async function handleVerifyBallPayment(deps, body) {
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let result;
  for (let i = 0; i < 6; i++) {
    result = await creditBallPayment(deps, body);
    if (result.code !== 'IN_PROGRESS') break;
    await sleep(1000);
  }
  return result;
}

module.exports = { packageForPesewas, sinkPackageForPesewas, creditBallPayment, handleVerifyBallPayment, claimReference, failReference, isValidReference, isValidUserId };
