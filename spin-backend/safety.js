'use strict';
// lib/safety.js  (identical copy: spin-backend/safety.js)
// Minimal-PII audit trail, Firestore-backed rate limiting, and per-game economic counters.
// Never log secrets. Never log phone numbers or emails: identities are stored as short hashes.

const crypto = require('crypto');

// Keyed hash: set AUDIT_PEPPER (random secret) in the server environment so short identifiers such as an IP
// address cannot be reversed by brute force. Without it a fixed key is used (weaker, still never raw data).
const shortHash = (v) => crypto.createHmac('sha256', process.env.AUDIT_PEPPER || 'voltix-audit').update(String(v)).digest('hex').slice(0, 16);

const AUDIT_FIELDS = ['type', 'purpose', 'packageId', 'amountPesewas', 'credits', 'status', 'code', 'ref', 'game'];

// Best-effort: an audit failure must never block or fail a payment.
async function audit(deps, evt) {
  try {
    const row = { ts: (deps.now || Date.now)() };
    for (const k of AUDIT_FIELDS) if (evt[k] !== undefined && evt[k] !== null) row[k] = evt[k];
    if (evt.actor) row.actor = shortHash(evt.actor);
    await deps.db.collection('auditEvents').add(row);
  } catch (e) { /* ignore */ }
}

// Fixed-window limiter. Returns { ok, remaining }. Keys are hashed before storage.
async function rateLimit(deps, key, limit, windowMs) {
  const nowMs = (deps.now || Date.now)();
  const ref = deps.db.collection('rateLimits').doc(shortHash(key));
  return deps.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.exists ? snap.data() : null;
    if (!cur || nowMs - cur.windowStart >= windowMs) {
      tx.set(ref, { windowStart: nowMs, count: 1, ttlAt: new Date(nowMs + windowMs * 2) }, { merge: false });
      return { ok: true, remaining: limit - 1 };
    }
    if (cur.count >= limit) return { ok: false, remaining: 0 };
    tx.set(ref, { windowStart: cur.windowStart, count: cur.count + 1, ttlAt: new Date(cur.windowStart + windowMs * 2) }, { merge: false });
    return { ok: true, remaining: limit - cur.count - 1 };
  });
}

const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
const GAMES = ['spin', 'foosball', 'sneaker', 'ludo', 'damii', 'kaisa'];
// Balls are shared by four games and cannot be attributed to one at purchase time.
const PURPOSE_GAME = { spinCoins: 'spin', sinkCoins: 'sneaker', balls: 'balls_shared' };

// Counters only (no player identifiers). Cost fields are intentionally absent: prize cost is UNKNOWN.
async function bump(deps, game, inc) {
  try {
    const ref = deps.db.collection('metricsDaily').doc(dayKey((deps.now || Date.now)()) + '_' + game);
    const data = { game, day: dayKey((deps.now || Date.now)()) };
    for (const [k, v] of Object.entries(inc)) data[k] = deps.FieldValue.increment(v);
    await ref.set(data, { merge: true });
  } catch (e) { /* ignore */ }
}

async function recordPayment(deps, { purpose, amountPesewas, feesPesewas, credits }) {
  await bump(deps, PURPOSE_GAME[purpose] || 'unknown', {
    paidPurchases: 1, grossPesewas: amountPesewas || 0,
    paystackFeesPesewas: Number.isInteger(feesPesewas) ? feesPesewas : 0,
    feeKnownPurchases: Number.isInteger(feesPesewas) ? 1 : 0, creditsSold: credits || 0,
  });
}

// CLIENT-REPORTED behaviour (attempts, wins, losses, credits used). Untrusted by nature, so it lives in
// its own collection and is never mixed into the server-verified money counters in metricsDaily.
const EVENT_TYPES = { attempt: 'attempts', completed: 'completedGames', win: 'wins', loss: 'losses' };
async function recordReportedEvent(deps, game, type, credits) {
  if (!GAMES.includes(game) || !EVENT_TYPES[type]) return false;
  try {
    const day = dayKey((deps.now || Date.now)());
    const data = { game, day, [EVENT_TYPES[type]]: deps.FieldValue.increment(1) };
    if (Number.isInteger(credits) && credits > 0 && credits <= 100) data.creditsConsumed = deps.FieldValue.increment(credits);
    await deps.db.collection('reportedEventsDaily').doc(day + '_' + game).set(data, { merge: true });
  } catch (e) { /* ignore */ }
  return true;
}

// SERVER-OBSERVED events (a prize claim reached the server). Still counters only.
async function recordServerEvent(deps, game, field) {
  if (!GAMES.includes(game) || field !== 'prizeClaimsSubmitted') return false;
  await bump(deps, game, { [field]: 1 });
  return true;
}

// Refund processed by Paystack for an already-credited reference (money out, never netted silently).
async function recordRefund(deps, { purpose, amountPesewas }) {
  await bump(deps, PURPOSE_GAME[purpose] || 'unknown', { refundCount: 1, refundedPesewas: amountPesewas || 0 });
}

// Turns one metricsDaily document into an honest report. Prize cost and other costs are UNKNOWN unless the
// caller supplies them; a contribution number is produced ONLY when every input is known.
function economicsReport(doc, costs) {
  const d = doc || {}; const c = costs || {};
  const gross = d.grossPesewas || 0, refunds = d.refundedPesewas || 0;
  const feesComplete = (d.paidPurchases || 0) === (d.feeKnownPurchases || 0);
  const out = {
    grossPesewas: gross, refundedPesewas: refunds, netRevenuePesewas: gross - refunds,
    paystackFeesPesewas: feesComplete ? (d.paystackFeesPesewas || 0) : 'UNKNOWN',
    prizeCostPesewas: Number.isFinite(c.prizeCostPesewas) ? c.prizeCostPesewas : 'UNKNOWN',
    otherVariableCostPesewas: Number.isFinite(c.otherVariableCostPesewas) ? c.otherVariableCostPesewas : 'UNKNOWN',
    contributionPesewas: 'UNKNOWN', contributionMarginPct: 'UNKNOWN',
  };
  if (feesComplete && Number.isFinite(c.prizeCostPesewas) && Number.isFinite(c.otherVariableCostPesewas)) {
    out.contributionPesewas = gross - refunds - out.paystackFeesPesewas - c.prizeCostPesewas - c.otherVariableCostPesewas;
    out.contributionMarginPct = gross > 0 ? Math.round((out.contributionPesewas / gross) * 1000) / 10 : 'UNKNOWN';
  }
  return out;
}

module.exports = { shortHash, audit, rateLimit, recordPayment, recordReportedEvent, recordServerEvent, recordRefund, economicsReport, GAMES, dayKey };
