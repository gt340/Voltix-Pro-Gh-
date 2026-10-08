'use strict';
// lib/ball-payments.js
// Server-authoritative ball credit. The number of balls is decided ONLY from the
// amount Paystack reports as paid. Anything the browser sends (balls, amountGhc,
// type) is ignored for pricing.
//   GHS 5.00           -> 5 balls   (draw "continue")
//   GHS 10.00 x n      -> 10 x n balls, n = 1..20 (the existing multi-package buy)

const crypto = require('crypto');

const BALLS_PER_PACKAGE = 10;
const PACKAGE_PRICE_PESEWAS = 1000;
const MAX_PACKAGES = 20;
const CONTINUE_PESEWAS = 500;
const CONTINUE_BALLS = 5;
const LEASE_MS = 60 * 1000;
const REF_RE = /^[A-Za-z0-9_-]{6,64}$/;

function packageForPesewas(paid) {
  if (!Number.isInteger(paid)) return null;
  if (paid === CONTINUE_PESEWAS) return { id: 'CONTINUE_5', balls: CONTINUE_BALLS, type: 'continue', priceGhs: 5 };
  if (paid >= PACKAGE_PRICE_PESEWAS && paid <= PACKAGE_PRICE_PESEWAS * MAX_PACKAGES &&
      paid % PACKAGE_PRICE_PESEWAS === 0) {
    const n = paid / PACKAGE_PRICE_PESEWAS;
    return { id: n === 1 ? 'BALLS_10' : 'BALLS_10_X' + n, balls: BALLS_PER_PACKAGE * n, type: 'purchase', priceGhs: 10 * n };
  }
  return null;
}

const isValidReference = (r) => typeof r === 'string' && REF_RE.test(r);
const isValidUserId = (u) => typeof u === 'string' && u.length >= 1 && u.length <= 128 && !/[\/\\]/.test(u);

async function claimReference(db, reference, purpose, nowMs) {
  const evRef = db.collection('paymentEvents').doc(reference);
  const token = crypto.randomBytes(12).toString('hex');
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(evRef);
    const prev = snap.exists ? snap.data() : null;
    if (prev && prev.status === 'SUCCESS') return { state: 'ALREADY_PROCESSED' };
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
  const { reference, userId } = body || {};   // balls / amountGhc / type are deliberately ignored

  if (!isValidReference(reference)) return { http: 400, json: { success: false, error: 'Invalid reference' } };
  if (!isValidUserId(userId)) return { http: 400, json: { success: false, error: 'Missing required fields' } };

  // Already credited before this change? Only COMPLETED legacy records count
  // (a failed attempt must not block a later legitimate verification).
  const legacy = await db.collection('transactions').where('reference', '==', reference).get();
  if (legacy.docs.some((d) => (d.data() || {}).status === 'completed')) {
    return { http: 200, json: { success: true, note: 'Already processed' } };
  }
  // A reference that already paid for spin coins can never pay for balls.
  const spin = await db.collection('coinPurchases').doc(reference).get();
  if (spin.exists) return { http: 409, json: { success: false, error: 'Reference already used' } };

  const claim = await claimReference(db, reference, 'balls', now());
  if (claim.state === 'ALREADY_PROCESSED') return { http: 200, json: { success: true, note: 'Already processed' } };
  if (claim.state === 'IN_PROGRESS') return { http: 409, code: 'IN_PROGRESS', json: { success: false, error: 'Processing, retry shortly' } };
  const token = claim.token;
  const fail = async (http, code, error, details) => {
    await failReference(db, reference, token, code, details, now());
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
  if (data.currency !== 'GHS') return fail(400, 'BAD_CURRENCY', 'Unsupported currency');
  const paid = Number(data.amount);
  const pkg = packageForPesewas(paid);
  if (!pkg) return fail(400, 'AMOUNT_MISMATCH', 'Amount does not match a ball package', { amountPesewas: paid });

  // The payment must belong to this player when Paystack tells us who paid.
  const meta = data.metadata && typeof data.metadata === 'object' ? data.metadata : {};
  const email = String((data.customer && data.customer.email) || '');
  const ownerHint = meta.userId || (/@voltix-player\.app$/i.test(email) ? email.split('@')[0] : null);
  if (ownerHint && ownerHint !== userId) return fail(400, 'IDENTITY_MISMATCH', 'Payment does not belong to this player');

  const evRef = db.collection('paymentEvents').doc(reference);
  const userRef = db.collection('users').doc(userId);
  let lostLease = false;
  await db.runTransaction(async (tx) => {
    lostLease = false;
    const evSnap = await tx.get(evRef);
    const ev = evSnap.exists ? evSnap.data() : null;
    if (!ev || ev.status !== 'PROCESSING' || ev.leaseToken !== token) { lostLease = true; return; }
    tx.set(userRef, { balls: FieldValue.increment(pkg.balls) }, { merge: true });
    tx.set(db.collection('transactions').doc(), {
      userId, type: pkg.type, balls: pkg.balls, amountGhc: pkg.priceGhs, reference,
      packageId: pkg.id, status: 'completed', createdAt: FieldValue.serverTimestamp(),
    });
    tx.set(evRef, {
      status: 'SUCCESS', purpose: 'balls', packageId: pkg.id, amountPesewas: paid,
      credited: pkg.balls, userId, leaseExpiresAt: 0, updatedAt: now(),
    }, { merge: true });
  });
  if (lostLease) return { http: 409, code: 'IN_PROGRESS', json: { success: false, error: 'Processing, retry shortly' } };
  return { http: 200, json: { success: true, ballsAdded: pkg.balls } };
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

module.exports = { packageForPesewas, creditBallPayment, handleVerifyBallPayment, claimReference, failReference };
