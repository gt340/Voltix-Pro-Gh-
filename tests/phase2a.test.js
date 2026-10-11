'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { FakeFirestore, FieldValue } = require('./fake-firestore');
const safety = require('../lib/safety');
const net = require('../lib/net');
const api = require('../lib/payment-api');
const ball = require('../lib/ball-payments');
const spin = require('../spin-backend/payments');

const SECRET = 'sk_test_unit';
let clock = 1700000000000;
const mk = (db, table) => ({
  db, FieldValue, now: () => clock, sleep: async () => {}, paystackSecret: SECRET,
  verifyToken: async (t) => ({ uid: String(t).replace('tok-', '') }),
  paystackVerify: async (ref) => (table && table[ref] ? { found: true, data: { reference: ref, ...table[ref] } } : { found: false }),
});
const claim = (d, phone, ipKey, cap = 5) => spin.handleClaimFreeSpin(d, { phone, name: 'N', ipKey, perNetworkPerDay: cap });
const coins = (db, phone) => (db.read('wallets/' + phone) || {}).coins || 0;

// ---------- free-spin limit ----------
test('FREE SPIN: 20 simultaneous claims for ONE phone pay out exactly once', async () => {
  const db = new FakeFirestore(); const d = mk(db);
  const rs = await Promise.all(Array.from({ length: 20 }, () => claim(d, '0536193862', '1.2.3.4', 1000)));
  assert.equal(rs.filter((r) => r.json.claimed).length, 1);
  assert.equal(coins(db, '0536193862'), 20);
});

test('FREE SPIN: account rotation from one network is capped atomically (20 parallel phones, cap 5)', async () => {
  const db = new FakeFirestore(); const d = mk(db);
  const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => claim(d, '02440000' + String(10 + i), '9.9.9.9')));
  assert.equal(rs.filter((r) => r.json.claimed).length, 5);
  assert.equal(rs.filter((r) => r.http === 429).length, 15);
});

test('FREE SPIN: other networks are unaffected; a phone that already claimed never burns network quota', async () => {
  const db = new FakeFirestore(); const d = mk(db);
  for (let i = 0; i < 5; i++) await claim(d, '02550000' + (10 + i), '5.5.5.5');
  assert.equal((await claim(d, '0255000099', '5.5.5.5')).http, 429);
  assert.equal((await claim(d, '0255000099', '6.6.6.6')).json.claimed, true);      // different network
  for (let i = 0; i < 10; i++) assert.equal((await claim(d, '0255000010', '5.5.5.5')).json.claimed, false); // repeats are not rate-limited
  assert.equal(coins(db, '0255000010'), 20);
});

test('FREE SPIN: window resets after 24h; invalid phone rejected', async () => {
  const db = new FakeFirestore(); const d = mk(db); clock = 1700000000000;
  for (let i = 0; i < 5; i++) await claim(d, '02660000' + (10 + i), '7.7.7.7');
  assert.equal((await claim(d, '0266000090', '7.7.7.7')).http, 429);
  clock += 24 * 60 * 60 * 1000 + 1;
  assert.equal((await claim(d, '0266000090', '7.7.7.7')).json.claimed, true);
  assert.equal((await claim(d, '12', '7.7.7.7')).http, 400);
});

// ---------- network identity / proxy bypass / privacy ----------
test('NETWORK: spoofed X-Forwarded-For is ignored; platform headers win only when trusted; IPv6 is bucketed by /64', () => {
  const trust = { trustPlatformHeaders: true };
  assert.equal(net.clientIp({ 'x-forwarded-for': '6.6.6.6, 7.7.7.7' }, '41.66.1.1', trust), '41.66.1.1');          // spoof cannot choose the identity
  assert.equal(net.clientIp({ 'x-forwarded-for': '6.6.6.6', 'x-vercel-forwarded-for': '41.66.1.2' }, '10.0.0.1', trust), '41.66.1.2');
  assert.equal(net.clientIp({ 'x-real-ip': '41.66.1.3' }, null, trust), '41.66.1.3');
  assert.equal(net.clientIp({ 'x-vercel-forwarded-for': '2a01:4f8:abcd:12:1:2:3:4' }, null, trust), '2a01:4f8:abcd:12');
  assert.equal(net.clientIp({ 'x-vercel-forwarded-for': '2a01:4f8:abcd:12:ffff:ffff:ffff:ffff' }, null, trust), '2a01:4f8:abcd:12');
  assert.equal(net.clientIp({}, '::ffff:41.66.1.9'), '41.66.1.9');
  assert.equal(net.clientIp({ 'x-vercel-forwarded-for': 'garbage' }, null, trust), null);
});

test('PRIVACY: the network address is never stored raw, and a secret pepper changes the stored hash', async () => {
  const db = new FakeFirestore(); const d = mk(db);
  await claim(d, '0277000001', '41.66.1.200');
  const text = JSON.stringify([...db.store.entries()].filter(([k]) => !k.startsWith('wallets/')));   // the wallet itself is keyed by phone by design
  for (const bad of ['41.66.1.200', '0277000001']) assert.ok(!text.includes(bad), 'leaked ' + bad);
  const k1 = safety.shortHash('41.66.1.200');
  process.env.AUDIT_PEPPER = 'pepper-for-test';
  const k2 = safety.shortHash('41.66.1.200');
  delete process.env.AUDIT_PEPPER;
  assert.notEqual(k1, k2); assert.equal(k1.length, 16);
  const ttl = [...db.store.entries()].find(([k]) => k.startsWith('rateLimits/'))[1].ttlAt;
  assert.ok(ttl, 'rate-limit rows carry a TTL timestamp for automatic cleanup');
});

// ---------- metrics: separation, refunds, honest report ----------
test('METRICS: client-reported events can never change revenue or refund counters', async () => {
  const db = new FakeFirestore(); const d = mk(db);
  for (let i = 0; i < 50; i++) await api.handleTrackEvent(d, { token: 'tok-u1', game: 'sneaker', type: 'win', credits: 5 });
  assert.equal(db.read('metricsDaily/' + safety.dayKey(clock) + '_sneaker'), undefined);
  const rep = db.read('reportedEventsDaily/' + safety.dayKey(clock) + '_sneaker');
  assert.equal(rep.wins, 50); assert.equal(rep.grossPesewas, undefined);
});

test('METRICS: refund is counted once even if the webhook is replayed, and netted against gross', async () => {
  const db = new FakeFirestore(); clock = 1700000000000;
  const q = (await api.handleQuote(mk(db), { token: 'tok-u1', packageId: 'SINK_50' })).json;
  const paid = { status: 'success', currency: 'GHS', amount: 1000, fees: 20, customer: { email: 'u1@voltix-player.app' }, metadata: { userId: 'u1' } };
  const d = mk(db, { [q.reference]: paid });
  await ball.handleVerifyBallPayment(d, { reference: q.reference });
  const raw = Buffer.from(JSON.stringify({ event: 'refund.processed', data: { transaction_reference: q.reference, status: 'processed' } }));
  const evt = { rawBody: raw, signature: crypto.createHmac('sha512', SECRET).update(raw).digest('hex') };
  await spin.handleWebhook(d, evt); await spin.handleWebhook(d, evt); await spin.handleWebhook(d, evt);
  const m = db.read('metricsDaily/' + safety.dayKey(clock) + '_sneaker');
  assert.equal(m.refundCount, 1); assert.equal(m.refundedPesewas, 1000); assert.equal(m.grossPesewas, 1000);
  const rep = safety.economicsReport(m, {});
  assert.equal(rep.netRevenuePesewas, 0);
});

test('REPORT: contribution is UNKNOWN unless every cost input is known; refunds and fees are separate lines', () => {
  const doc = { grossPesewas: 10000, refundedPesewas: 1000, paystackFeesPesewas: 195, paidPurchases: 1, feeKnownPurchases: 1 };
  let r = safety.economicsReport(doc, {});
  assert.equal(r.prizeCostPesewas, 'UNKNOWN'); assert.equal(r.contributionPesewas, 'UNKNOWN'); assert.equal(r.contributionMarginPct, 'UNKNOWN');
  assert.equal(r.netRevenuePesewas, 9000); assert.equal(r.paystackFeesPesewas, 195);
  r = safety.economicsReport(doc, { prizeCostPesewas: 3000 });
  assert.equal(r.contributionPesewas, 'UNKNOWN');                                // other variable costs still unknown
  r = safety.economicsReport(doc, { prizeCostPesewas: 3000, otherVariableCostPesewas: 0 });
  assert.equal(r.contributionPesewas, 10000 - 1000 - 195 - 3000); assert.equal(r.contributionMarginPct, 58.1);
  r = safety.economicsReport({ ...doc, paidPurchases: 2 }, { prizeCostPesewas: 0, otherVariableCostPesewas: 0 });
  assert.equal(r.paystackFeesPesewas, 'UNKNOWN'); assert.equal(r.contributionPesewas, 'UNKNOWN');   // a payment without fee data
});
