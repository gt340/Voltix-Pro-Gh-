'use strict';
// lib/safety.js  (identical copy: spin-backend/safety.js)
// Minimal-PII audit trail, Firestore-backed rate limiting, and per-game economic counters.
// Never log secrets. Never log phone numbers or emails: identities are stored as short hashes.

const crypto = require('crypto');

const shortHash = (v) => crypto.createHash('sha256').update('voltix-audit:' + String(v)).digest('hex').slice(0, 12);

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
      tx.set(ref, { windowStart: nowMs, count: 1 }, { merge: false });
      return { ok: true, remaining: limit - 1 };
    }
    if (cur.count >= limit) return { ok: false, remaining: 0 };
    tx.set(ref, { windowStart: cur.windowStart, count: cur.count + 1 }, { merge: false });
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

const EVENT_TYPES = { attempt: 'attempts', completed: 'completedGames', win: 'wins', loss: 'losses', claim: 'prizeClaims' };
async function recordGameEvent(deps, game, type, credits) {
  if (!GAMES.includes(game) || !EVENT_TYPES[type]) return false;
  const inc = { [EVENT_TYPES[type]]: 1 };
  if (Number.isInteger(credits) && credits > 0 && credits <= 100) inc.creditsConsumed = credits;
  await bump(deps, game, inc);
  return true;
}

module.exports = { shortHash, audit, rateLimit, recordPayment, recordGameEvent, GAMES, dayKey };
