'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { FakeFirestore, FieldValue } = require('./fake-firestore');
const catalog = require('../lib/catalog');
const safety = require('../lib/safety');
const ball = require('../lib/ball-payments');
const api = require('../lib/payment-api');
const spin = require('../spin-backend/payments');

const SECRET = 'sk_test_unit';
let clock = 1700000000000;
const mk = (db, table, extra) => ({
  db, FieldValue, now: () => clock, sleep: async () => {}, paystackSecret: SECRET,
  verifyToken: async (t) => { if (!String(t).startsWith('tok-')) throw new Error('bad'); return { uid: String(t).slice(4) }; },
  paystackVerify: async (ref) => (table[ref] ? { found: true, data: { reference: ref, ...table[ref] } } : { found: false }),
  ...extra,
});
const paid = (pesewas, uid, extra) => ({ status: 'success', currency: 'GHS', amount: pesewas, fees: Math.round(pesewas * 0.0195), customer: { email: uid + '@voltix-player.app' }, metadata: { userId: uid }, ...extra });
const user = (db, uid) => db.read('users/' + uid) || {};
const sign = (obj) => { const raw = Buffer.from(JSON.stringify(obj)); return { rawBody: raw, signature: crypto.createHmac('sha512', SECRET).update(raw).digest('hex') }; };

// ---------- A. catalogue ----------
test('CATALOG: approved prices and credits are unchanged from Phase 1B', () => {
  const p = catalog.PACKAGES;
  assert.deepEqual([p.SPIN_100, p.SPIN_250, p.SPIN_500].map((x) => [x.pesewas, x.credits]), [[1000, 100], [2250, 250], [4500, 500]]);
  assert.deepEqual([p.BALLS_10.pesewas, p.BALLS_10.credits, p.CONTINUE_5.pesewas, p.CONTINUE_5.credits, p.SINK_50.pesewas, p.SINK_50.credits], [1000, 10, 500, 5, 1000, 50]);
  assert.equal(catalog.getPackage('PACKAGE_250').id, 'SPIN_250');           // legacy ids still resolve
  assert.equal(catalog.priceFor('BALLS_10', 21), null);                     // quantity limits
  assert.equal(catalog.priceFor('BALLS_10', 3).pesewas, 3000);
  assert.equal(catalog.resolveByAmount('balls', 500).pkg.id, 'CONTINUE_5');
  assert.equal(catalog.resolveByAmount('balls', 1500), null);
  assert.equal(catalog.resolveByAmount('sinkCoins', 2000).credits, 100);
});

test('CATALOG: shared copies in spin-backend/ are byte-identical (no silent drift)', () => {
  for (const f of ['catalog.js', 'safety.js', 'ball-payments.js']) {
    assert.equal(fs.readFileSync(path.join(__dirname, '..', 'lib', f), 'utf8'), fs.readFileSync(path.join(__dirname, '..', 'spin-backend', f), 'utf8'), f);
  }
});

test('CATALOG: admin settings that disagree with the catalogue are reported, never applied', async () => {
  const db = new FakeFirestore();
  db.seed('gameSettings/main', { ballPriceGhc: 8, ballPackage: 10, sneakerCoinPriceGhc: 15, sneakerCoinPack: 50 });
  const r = await api.handleCatalog(mk(db, {}));
  assert.equal(r.http, 200);
  assert.deepEqual(r.json.divergence.map((d) => d.setting).sort(), ['ballPriceGhc', 'sneakerCoinPriceGhc']);
  assert.equal(r.json.packages.find((x) => x.id === 'BALLS_10').amountGhs, 10);
  assert.ok(!JSON.stringify(r.json).toLowerCase().includes('secret'));
});

// ---------- B. quote + intent ----------
test('QUOTE: server sets amount/credits/owner; browser amount is irrelevant; token required', async () => {
  const db = new FakeFirestore(); const deps = mk(db, {});
  assert.equal((await api.handleQuote(deps, { packageId: 'BALLS_10', qty: 2 })).http, 401);
  assert.equal((await api.handleQuote(deps, { token: 'bad', packageId: 'BALLS_10' })).http, 401);
  const r = await api.handleQuote(deps, { token: 'tok-u1', packageId: 'BALLS_10', qty: 2, amountPesewas: 1, credits: 99999 });
  assert.equal(r.http, 200); assert.equal(r.json.amountPesewas, 2000); assert.equal(r.json.credits, 20);
  const it = db.read('paymentIntents/' + r.json.reference);
  assert.equal(it.userId, 'u1'); assert.equal(it.status, 'CREATED'); assert.equal(it.amountPesewas, 2000);
});

test('QUOTE: unknown package, spin package, bad quantity and flooding are rejected', async () => {
  const db = new FakeFirestore(); const deps = mk(db, {});
  assert.equal((await api.handleQuote(deps, { token: 'tok-u1', packageId: 'NOPE' })).http, 400);
  assert.equal((await api.handleQuote(deps, { token: 'tok-u1', packageId: 'SPIN_100' })).http, 400);
  assert.equal((await api.handleQuote(deps, { token: 'tok-u1', packageId: 'BALLS_10', qty: 0 })).http, 400);
  assert.equal((await api.handleQuote(deps, { token: 'tok-u1', packageId: 'BALLS_10', qty: 2.5 })).http, 400);
  for (let i = 0; i < 20; i++) await api.handleQuote(deps, { token: 'tok-u2', packageId: 'CONTINUE_5' });
  assert.equal((await api.handleQuote(deps, { token: 'tok-u2', packageId: 'CONTINUE_5' })).http, 429);
});

test('INTENT: exact quoted amount credits once; sink coins go to sinkCoins', async () => {
  const db = new FakeFirestore(); db.seed('users/u1', { balls: 4, sinkCoins: 1 });
  const q1 = (await api.handleQuote(mk(db, {}), { token: 'tok-u1', packageId: 'BALLS_10', qty: 2 })).json;
  const q2 = (await api.handleQuote(mk(db, {}), { token: 'tok-u1', packageId: 'SINK_50' })).json;
  const deps = mk(db, { [q1.reference]: paid(2000, 'u1'), [q2.reference]: paid(1000, 'u1') });
  assert.equal((await ball.handleVerifyBallPayment(deps, { reference: q1.reference, userId: 'u1', balls: 99999 })).http, 200);
  assert.equal((await ball.handleVerifyBallPayment(deps, { reference: q2.reference, userId: 'u1' })).http, 200);
  assert.equal(user(db, 'u1').balls, 24); assert.equal(user(db, 'u1').sinkCoins, 51);
  assert.equal(db.read('paymentIntents/' + q1.reference).status, 'CREDITED');
});

test('INTENT: paying a DIFFERENT valid amount than quoted is rejected (no silent divergence)', async () => {
  const db = new FakeFirestore();
  const q = (await api.handleQuote(mk(db, {}), { token: 'tok-u1', packageId: 'BALLS_10', qty: 1 })).json;   // quoted GHS 10
  const deps = mk(db, { [q.reference]: paid(5000, 'u1') });                                                   // paid GHS 50 (a valid ball amount)
  const r = await ball.handleVerifyBallPayment(deps, { reference: q.reference });
  assert.equal(r.http, 400); assert.equal(r.json.code, 'AMOUNT_MISMATCH'); assert.equal(user(db, 'u1').balls || 0, 0);
  assert.equal(db.read('paymentEvents/' + q.reference).status, 'FAILED');
});

test('INTENT: another player cannot claim a quoted payment', async () => {
  const db = new FakeFirestore();
  const q = (await api.handleQuote(mk(db, {}), { token: 'tok-victim', packageId: 'BALLS_10' })).json;
  const deps = mk(db, { [q.reference]: paid(1000, 'victim') });
  const r = await ball.handleVerifyBallPayment(deps, { reference: q.reference, userId: 'attacker' });
  assert.equal(r.http, 403); assert.equal(user(db, 'attacker').balls || 0, 0); assert.equal(user(db, 'victim').balls || 0, 0);
});

test('INTENT: wrong currency and failed payment credit nothing', async () => {
  const db = new FakeFirestore();
  const a = (await api.handleQuote(mk(db, {}), { token: 'tok-u1', packageId: 'BALLS_10' })).json;
  const b = (await api.handleQuote(mk(db, {}), { token: 'tok-u1', packageId: 'BALLS_10' })).json;
  const deps = mk(db, { [a.reference]: paid(1000, 'u1', { currency: 'USD' }), [b.reference]: paid(1000, 'u1', { status: 'failed' }) });
  assert.equal((await ball.handleVerifyBallPayment(deps, { reference: a.reference })).json.code, 'BAD_CURRENCY');
  assert.equal((await ball.handleVerifyBallPayment(deps, { reference: b.reference })).json.code, 'NOT_SUCCESSFUL');
  assert.equal(user(db, 'u1').balls || 0, 0);
});

// ---------- C. recovery (browser closed before verification) ----------
test('RECOVERY: webhook alone credits a paid quote; replay and manual verify add nothing', async () => {
  const db = new FakeFirestore();
  const q = (await api.handleQuote(mk(db, {}), { token: 'tok-u1', packageId: 'SINK_50' })).json;
  const deps = mk(db, { [q.reference]: paid(1000, 'u1') });
  const evt = sign({ event: 'charge.success', data: { reference: q.reference } });
  assert.equal((await spin.handleWebhook(deps, evt)).http, 200);
  assert.equal((await spin.handleWebhook(deps, evt)).http, 200);
  await ball.handleVerifyBallPayment(deps, { reference: q.reference, userId: 'u1' });
  assert.equal(user(db, 'u1').sinkCoins, 50);
});

test('RECOVERY: /recover-payments credits only the caller\'s own paid, old-enough quotes', async () => {
  const db = new FakeFirestore(); clock = 1700000000000;
  const mine = (await api.handleQuote(mk(db, {}), { token: 'tok-u1', packageId: 'BALLS_10' })).json;
  const theirs = (await api.handleQuote(mk(db, {}), { token: 'tok-u2', packageId: 'BALLS_10' })).json;
  const unpaid = (await api.handleQuote(mk(db, {}), { token: 'tok-u1', packageId: 'CONTINUE_5' })).json;
  const table = { [mine.reference]: paid(1000, 'u1'), [theirs.reference]: paid(1000, 'u2') };
  let r = await api.handleRecover(mk(db, table), { token: 'tok-u1' });
  assert.ok(r.json.results.every((x) => x.state === 'too-recent'));       // too fresh: customer may still be paying
  clock += 5 * 60 * 1000;
  r = await api.handleRecover(mk(db, table), { token: 'tok-u1' });
  assert.equal(r.json.results.find((x) => x.reference === mine.reference).state, 'credited');
  assert.equal(r.json.results.find((x) => x.reference === unpaid.reference).state, 'not-paid');
  assert.equal(user(db, 'u1').balls, 10); assert.equal(user(db, 'u2').balls || 0, 0);
  assert.equal((await api.handleRecover(mk(db, table), { token: 'nope' })).http, 401);
  clock += 25 * 60 * 60 * 1000;
  r = await api.handleRecover(mk(db, table), { token: 'tok-u1' });
  assert.equal(r.json.results.find((x) => x.reference === unpaid.reference).state, 'expired');
});

test('RECOVERY (spin): server-quoted coin purchase is credited by the webhook even if the browser never calls back', async () => {
  const db = new FakeFirestore(); const phone = '0536 193 862';
  const q = (await spin.handleQuoteCoins(mk(db, {}), { phone, packageId: 'SPIN_250' })).json;
  assert.equal(q.amountPesewas, 2250); assert.equal(q.coins, 250);
  const deps = mk(db, { [q.reference]: { status: 'success', currency: 'GHS', amount: 2250, customer: { email: '0536193862@voltix.com' } } });
  assert.equal((await spin.handleWebhook(deps, sign({ event: 'charge.success', data: { reference: q.reference } }))).http, 200);
  assert.equal(db.read('wallets/' + phone).coins, 250);
  await spin.handleVerifyPurchase(deps, { reference: q.reference });
  assert.equal(db.read('wallets/' + phone).coins, 250);
});

test('SPIN QUOTE: unknown package, bad phone, flooding rejected; webhook forgery rejected', async () => {
  const db = new FakeFirestore(); const deps = mk(db, {});
  assert.equal((await spin.handleQuoteCoins(deps, { phone: '0536193862', packageId: 'SPIN_999' })).http, 400);
  assert.equal((await spin.handleQuoteCoins(deps, { phone: '12', packageId: 'SPIN_100' })).http, 400);
  for (let i = 0; i < 10; i++) await spin.handleQuoteCoins(deps, { phone: '0200000001', packageId: 'SPIN_100' });
  assert.equal((await spin.handleQuoteCoins(deps, { phone: '0200000001', packageId: 'SPIN_100' })).http, 429);
  const bad = sign({ event: 'charge.success', data: { reference: 'COINS-ABCDEF123' } });
  assert.equal((await spin.handleWebhook(deps, { rawBody: bad.rawBody, signature: 'forged' })).http, 401);
});

// ---------- D. refunds ----------
test('REFUND: processed refund opens a manual review and the reference can never credit again', async () => {
  const db = new FakeFirestore();
  const q = (await api.handleQuote(mk(db, {}), { token: 'tok-u1', packageId: 'BALLS_10' })).json;
  const deps = mk(db, { [q.reference]: paid(1000, 'u1') });
  await ball.handleVerifyBallPayment(deps, { reference: q.reference });
  const r = await spin.handleWebhook(deps, sign({ event: 'refund.processed', data: { transaction_reference: q.reference, status: 'processed' } }));
  assert.equal(r.http, 200);
  assert.equal(db.read('paymentEvents/' + q.reference).refunded, true);
  assert.equal(db.read('reviewQueue/refund-' + q.reference).status, 'open');
  assert.equal(user(db, 'u1').balls, 10);                                        // NOT auto-reversed
  await ball.handleVerifyBallPayment(deps, { reference: q.reference });
  assert.equal(user(db, 'u1').balls, 10);                                        // no re-credit
});

// ---------- E. prize claims ----------
const claimDeps = (db) => mk(db, {});
test('CLAIM: Sneaker Sink needs server-held points, resets them, and cannot be repeated or forged', async () => {
  const db = new FakeFirestore(); db.seed('gameSettings/main', { sneakerTarget: 15, sneakerPrize: 'Test prize' });
  db.seed('users/u1', { sinkPts: 9 }); db.seed('users/u2', { sinkPts: 15 });
  const d = claimDeps(db);
  assert.equal((await api.handleClaimPrize(d, { token: 'tok-u1', game: 'sneaker', phone: '0536193862' })).http, 403);
  assert.equal((await api.handleClaimPrize(d, { game: 'sneaker', phone: '0536193862' })).http, 401);
  const ok = await api.handleClaimPrize(d, { token: 'tok-u2', game: 'sneaker', phone: '0244000111' });
  assert.equal(ok.http, 200); assert.equal(user(db, 'u2').sinkPts, 0);
  assert.equal((await api.handleClaimPrize(d, { token: 'tok-u2', game: 'sneaker', phone: '0244000111' })).http, 409);   // same-day repeat blocked
  assert.equal(user(db, 'u2').sinkPts, 0);                                                                              // points were reset, nothing left to claim
  const w = [...db.store.keys()].filter((k) => k.startsWith('winners/'));
  assert.equal(w.length, 1); assert.equal(db.read(w[0]).status, 'pending-review');
});

test('CLAIM: same-day duplicates blocked; AI-game claims are pending review and marked client-declared', async () => {
  const db = new FakeFirestore(); const d = claimDeps(db);
  const a = await api.handleClaimPrize(d, { token: 'tok-u1', game: 'damii', phone: '0536193862' });
  assert.equal(a.http, 200);
  assert.equal((await api.handleClaimPrize(d, { token: 'tok-u1', game: 'damii', phone: '0536193862' })).http, 409);
  const w = db.read([...db.store.keys()].find((k) => k.startsWith('winners/')));
  assert.equal(w.evidence, 'client-declared'); assert.equal(w.status, 'pending-review');
  assert.equal((await api.handleClaimPrize(d, { token: 'tok-u1', game: 'chess', phone: '0536193862' })).http, 400);
  assert.equal((await api.handleClaimPrize(d, { token: 'tok-u1', game: 'ludo', phone: 'abc' })).http, 400);
});

test('CLAIM: one phone number cannot collect unlimited prizes through many anonymous accounts', async () => {
  const db = new FakeFirestore(); const d = claimDeps(db); let last;
  for (let i = 0; i < 5; i++) last = await api.handleClaimPrize(d, { token: 'tok-farm' + i, game: 'kaisa', phone: '0536193862' });
  assert.equal(last.http, 429);
});

// ---------- F. audit, PII, metrics ----------
test('AUDIT: logs carry no phone numbers, emails or secrets; identities are hashed', async () => {
  const db = new FakeFirestore(); const phone = '0536193862';
  const q = (await spin.handleQuoteCoins(mk(db, {}), { phone, packageId: 'SPIN_100' })).json;
  const deps = mk(db, { [q.reference]: { status: 'success', currency: 'GHS', amount: 1000, customer: { email: phone + '@voltix.com' } } });
  await spin.handleVerifyPurchase(deps, { reference: q.reference });
  await api.handleClaimPrize(deps, { token: 'tok-u9', game: 'kaisa', phone: '0244999888' });
  const rows = [...db.store.entries()].filter(([k]) => k.startsWith('auditEvents/') || k.startsWith('metricsDaily/') || k.startsWith('rateLimits/'));
  assert.ok(rows.length >= 3);
  const text = JSON.stringify(rows);
  for (const bad of [phone, '0244999888', 'voltix.com', '@voltix-player', SECRET, 'u9']) assert.ok(!text.includes(bad), 'leaked: ' + bad);
});

test('METRICS: gross, fee and credits counted exactly once per payment even under replay', async () => {
  const db = new FakeFirestore(); clock = 1700000000000;
  const q = (await api.handleQuote(mk(db, {}), { token: 'tok-u1', packageId: 'SINK_50' })).json;
  const deps = mk(db, { [q.reference]: paid(1000, 'u1') });
  await Promise.all([1, 2, 3].map(() => ball.handleVerifyBallPayment(deps, { reference: q.reference })));
  await ball.handleVerifyBallPayment(deps, { reference: q.reference });
  const m = db.read('metricsDaily/' + safety.dayKey(clock) + '_sneaker');
  assert.equal(m.paidPurchases, 1); assert.equal(m.grossPesewas, 1000); assert.equal(m.paystackFeesPesewas, 20); assert.equal(m.creditsSold, 50);
  assert.equal(m.prizeCostPesewas, undefined);                                  // prize cost is UNKNOWN, never invented
});

test('METRICS: game events validate type, game and credit bounds', async () => {
  const db = new FakeFirestore(); const d = mk(db, {});
  assert.equal((await api.handleTrackEvent(d, { token: 'tok-u1', game: 'ludo', type: 'attempt', credits: 2 })).http, 200);
  assert.equal((await api.handleTrackEvent(d, { token: 'tok-u1', game: 'ludo', type: 'win' })).http, 200);
  assert.equal((await api.handleTrackEvent(d, { token: 'tok-u1', game: 'poker', type: 'win' })).http, 400);
  assert.equal((await api.handleTrackEvent(d, { token: 'tok-u1', game: 'ludo', type: 'jackpot' })).http, 400);
  assert.equal((await api.handleTrackEvent(d, { game: 'ludo', type: 'win' })).http, 401);
  await api.handleTrackEvent(d, { token: 'tok-u1', game: 'ludo', type: 'attempt', credits: 999999 });
  const m = db.read('metricsDaily/' + safety.dayKey(clock) + '_ludo');
  assert.equal(m.attempts, 2); assert.equal(m.wins, 1); assert.equal(m.creditsConsumed, 2);   // oversized credits ignored
});

// ---------- G. free-spin farming limiter ----------
test('ABUSE: rate limiter caps repeated free-spin style claims per key and resets per window', async () => {
  const db = new FakeFirestore(); const d = mk(db, {});
  for (let i = 0; i < 3; i++) assert.equal((await safety.rateLimit(d, 'free-spin-ip:1.2.3.4', 3, 86400000)).ok, true);
  assert.equal((await safety.rateLimit(d, 'free-spin-ip:1.2.3.4', 3, 86400000)).ok, false);
  assert.equal((await safety.rateLimit(d, 'free-spin-ip:5.6.7.8', 3, 86400000)).ok, true);   // other key unaffected
  clock += 86400001;
  assert.equal((await safety.rateLimit(d, 'free-spin-ip:1.2.3.4', 3, 86400000)).ok, true);
});
