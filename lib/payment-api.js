'use strict';
// lib/payment-api.js
// Dependency-injected handlers behind the new /api/* routes. Identity comes from a VERIFIED Firebase
// ID token (deps.verifyToken), never from a request field. Nothing here changes prize economics.

const crypto = require('crypto');
const catalog = require('./catalog');
const safety = require('./safety');
const ball = require('./ball-payments');

const INTENT_TTL_MS = 24 * 60 * 60 * 1000;
const RECOVER_MIN_AGE_MS = 60 * 1000;
const PRIZE_GAMES = ['foosball', 'kaisa', 'damii', 'ludo', 'sneaker'];
const DEFAULT_SNEAKER_TARGET = 15;

async function whoIs(deps, token) {
  if (!token || typeof token !== 'string') return null;
  try { const t = await deps.verifyToken(token); return t && t.uid ? t.uid : null; } catch (e) { return null; }
}

// GET /api/catalog — public authoritative catalogue + any admin-setting divergence (no secrets).
async function handleCatalog(deps) {
  let settings = {};
  try { const s = await deps.db.collection('gameSettings').doc('main').get(); if (s.exists) settings = s.data(); } catch (e) { /* ignore */ }
  return { http: 200, json: { ...catalog.publicCatalog(), divergence: catalog.checkDivergence(settings) } };
}

// POST /api/payment-quote — server decides amount, credits and owner before checkout.
async function handleQuote(deps, { token, packageId, qty }) {
  const uid = await whoIs(deps, token);
  if (!uid) return { http: 401, json: { error: 'Sign-in required' } };
  const pkg = catalog.getPackage(packageId);
  if (!pkg || pkg.purpose === 'spinCoins') return { http: 400, json: { error: 'Unknown package' } };
  const priced = catalog.priceFor(pkg.id, qty === undefined ? 1 : qty);
  if (!priced) return { http: 400, json: { error: 'Invalid quantity' } };
  const rl = await safety.rateLimit(deps, 'quote:' + uid, 20, 60 * 60 * 1000);
  if (!rl.ok) return { http: 429, json: { error: 'Too many requests, try again later' } };
  const now = (deps.now || Date.now)();
  const reference = 'VX-' + crypto.randomBytes(12).toString('hex');
  await deps.db.collection('paymentIntents').doc(reference).create({
    purpose: pkg.purpose, userId: uid, catalogId: pkg.id, packageId: priced.packageId, qty: priced.qty,
    amountPesewas: priced.pesewas, credits: priced.credits, currency: catalog.CURRENCY,
    status: 'CREATED', catalogVersion: catalog.CATALOG_VERSION, createdAt: now, expiresAt: now + INTENT_TTL_MS,
  });
  await safety.audit(deps, { type: 'quote.created', purpose: pkg.purpose, packageId: priced.packageId, amountPesewas: priced.pesewas, ref: reference, actor: uid });
  return { http: 200, json: { reference, amountPesewas: priced.pesewas, currency: catalog.CURRENCY, credits: priced.credits, packageId: priced.packageId, email: uid + '@voltix-player.app' } };
}

// POST /api/recover-payments — credits this player's paid-but-unconfirmed intents (browser closed early).
async function handleRecover(deps, { token }) {
  const uid = await whoIs(deps, token);
  if (!uid) return { http: 401, json: { error: 'Sign-in required' } };
  const rl = await safety.rateLimit(deps, 'recover:' + uid, 10, 60 * 60 * 1000);
  if (!rl.ok) return { http: 429, json: { error: 'Too many requests, try again later' } };
  const now = (deps.now || Date.now)();
  const snap = await deps.db.collection('paymentIntents').where('userId', '==', uid).where('status', '==', 'CREATED').get();
  const results = [];
  for (const d of snap.docs.slice(0, 10)) {
    const it = d.data();
    if (now - it.createdAt < RECOVER_MIN_AGE_MS) { results.push({ reference: d.id, state: 'too-recent' }); continue; }
    const r = await ball.creditBallPayment(deps, { reference: d.id });
    if (r.json && r.json.success) results.push({ reference: d.id, state: 'credited' });
    else if (it.expiresAt < now && r.http === 400) {
      await deps.db.collection('paymentIntents').doc(d.id).set({ status: 'EXPIRED', expiredAt: now }, { merge: true });
      results.push({ reference: d.id, state: 'expired' });
    } else results.push({ reference: d.id, state: r.http === 502 ? 'retry' : 'not-paid' });
  }
  return { http: 200, json: { results } };
}

const isPhone = (p) => typeof p === 'string' && /^\+?[0-9 ]{9,16}$/.test(p) && p.replace(/\D/g, '').length >= 9;
const todayKey = (ms) => safety.dayKey(ms);

// POST /api/claim-prize — one claim per player per game per day; Sneaker Sink needs the points.
// Outcomes of Foosball/Kaisa/Damii/Ludo are decided in the browser and cannot be verified here, so
// those claims are stored as PENDING REVIEW with evidence 'client-declared' (never auto-approved).
async function handleClaimPrize(deps, { token, game, phone }) {
  const uid = await whoIs(deps, token);
  if (!uid) return { http: 401, json: { error: 'Sign-in required' } };
  if (!PRIZE_GAMES.includes(game)) return { http: 400, json: { error: 'Unknown game' } };
  if (!isPhone(phone)) return { http: 400, json: { error: 'Valid phone required' } };
  const rl = await safety.rateLimit(deps, 'claim:' + uid, 5, 24 * 60 * 60 * 1000);
  if (!rl.ok) return { http: 429, json: { error: 'Too many claims today' } };
  const phoneCap = await safety.rateLimit(deps, 'claim-phone:' + phone.replace(/\D/g, ''), 3, 24 * 60 * 60 * 1000);
  if (!phoneCap.ok) return { http: 429, json: { error: 'Too many claims for this number today' } };

  const db = deps.db; const now = (deps.now || Date.now)();
  const settings = ((await db.collection('gameSettings').doc('main').get()).data()) || {};
  const prizeKey = { foosball: 'aiPrize', kaisa: 'kaisaAiPrize', damii: 'damiiAiPrize', ludo: 'ludoAiPrize', sneaker: 'sneakerPrize' }[game];
  const winnerRef = db.collection('winners').doc(uid + '_' + game + '_' + todayKey(now));
  const userRef = db.collection('users').doc(uid);
  let code = null;
  await db.runTransaction(async (tx) => {
    code = null;
    const existing = await tx.get(winnerRef);
    if (existing.exists) { code = 'DUPLICATE'; return; }
    const doc = {
      uid, game, phone, prize: settings[prizeKey] || '', status: 'pending-review',
      evidence: game === 'sneaker' ? 'server-checked-points' : 'client-declared', mode: 'ai', createdAt: now,
    };
    if (game === 'sneaker') {
      const u = await tx.get(userRef);
      const target = parseInt(settings.sneakerTarget, 10) || DEFAULT_SNEAKER_TARGET;
      const pts = u.exists ? Number(u.data().sinkPts) || 0 : 0;
      if (pts < target) { code = 'NOT_ELIGIBLE'; return; }
      doc.finalScore = { points: pts };
      tx.set(userRef, { sinkPts: 0 }, { merge: true });
    }
    tx.set(winnerRef, doc);
  });
  if (code === 'DUPLICATE') return { http: 409, json: { error: 'Already claimed today' } };
  if (code === 'NOT_ELIGIBLE') return { http: 403, json: { error: 'Not eligible' } };
  await safety.audit(deps, { type: 'prize.claimed', game, status: 'pending-review', actor: uid });
  await safety.recordGameEvent(deps, game === 'sneaker' ? 'sneaker' : game, 'claim');
  return { http: 200, json: { status: 'pending-review' } };
}

// POST /api/track-event — anonymous counters for the economics dashboard (no identifiers stored).
async function handleTrackEvent(deps, { token, game, type, credits }) {
  const uid = await whoIs(deps, token);
  if (!uid) return { http: 401, json: { error: 'Sign-in required' } };
  const rl = await safety.rateLimit(deps, 'track:' + uid, 300, 60 * 60 * 1000);
  if (!rl.ok) return { http: 429, json: { error: 'Too many events' } };
  const ok = await safety.recordGameEvent(deps, game, type, credits);
  return ok ? { http: 200, json: { ok: true } } : { http: 400, json: { error: 'Invalid event' } };
}

module.exports = { handleCatalog, handleQuote, handleRecover, handleClaimPrize, handleTrackEvent, PRIZE_GAMES };
