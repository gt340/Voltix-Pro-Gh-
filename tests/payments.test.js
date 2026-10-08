'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { FakeFirestore, FieldValue } = require('./fake-firestore');
const spin = require('../spin-backend/payments');
const ball = require('../lib/ball-payments');

const SECRET = 'sk_test_unit';
const PHONE = '0536 193 862';

function paystack(table) {
  const calls = [];
  const fn = async (ref) => {
    calls.push(ref);
    const row = table[ref];
    if (row === 'THROW') throw new Error('network');
    return row ? { found: true, data: { reference: ref, ...row } } : { found: false };
  };
  fn.calls = calls;
  return fn;
}
const mkDeps = (db, table) => ({
  db, FieldValue, paystackVerify: paystack(table), now: () => 1700000000000,
  sleep: async () => {}, paystackSecret: SECRET,
});
const paid = (pesewas, extra) => ({ status: 'success', currency: 'GHS', amount: pesewas, customer: { email: '0536193862@voltix.com' }, ...extra });
const buy = (deps, ref, extra) => spin.handleBuyCoins(deps, { phone: PHONE, ref, name: 'Ama', ...extra });
const walletCoins = (db) => (db.read('wallets/' + PHONE) || {}).coins || 0;

// ======================= SPIN =======================
test('SPIN 1-3: each package credits exactly its server-defined coins', async () => {
  for (const [pesewas, coins, ref] of [[1000, 100, 'COINS-1000001'], [2250, 250, 'COINS-1000002'], [4500, 500, 'COINS-1000003']]) {
    const db = new FakeFirestore();
    const deps = mkDeps(db, { [ref]: paid(pesewas) });
    await buy(deps, ref);
    const r = await spin.handleVerifyPurchase(deps, { reference: ref });
    assert.equal(r.http, 200); assert.equal(r.json.status, 'confirmed');
    assert.equal(walletCoins(db), coins);
    assert.equal(db.read('paymentEvents/' + ref).status, 'SUCCESS');
  }
});

test('SPIN 4: altered browser coin quantity is ignored', async () => {
  const db = new FakeFirestore(); const ref = 'COINS-2000001';
  const deps = mkDeps(db, { [ref]: paid(1000) });
  await buy(deps, ref, { coins: 1000000, priceGHC: 10 });
  const r = await spin.handleVerifyPurchase(deps, { reference: ref });
  assert.equal(r.http, 200);
  assert.equal(walletCoins(db), 100);
});

test('SPIN 5: altered browser price / package request is rejected or ignored, never over-credits', async () => {
  const db = new FakeFirestore(); const ref = 'COINS-3000001';
  const deps = mkDeps(db, { [ref]: paid(1000) });                       // paid GHS10
  await buy(deps, ref, { packageId: 'PACKAGE_500', coins: 500, priceGHC: 1 });
  const r = await spin.handleVerifyPurchase(deps, { reference: ref });  // asked for 500, paid 10
  assert.equal(r.http, 400); assert.equal(r.json.code, 'AMOUNT_MISMATCH');
  assert.equal(walletCoins(db), 0);
  // legacy client lying about price only: credit follows what was actually paid
  const ref2 = 'COINS-3000002';
  const deps2 = mkDeps(db, { [ref2]: paid(1000) });
  await buy(deps2, ref2, { coins: 500, priceGHC: 1 });
  await spin.handleVerifyPurchase(deps2, { reference: ref2 });
  assert.equal(walletCoins(db), 100);
});

test('SPIN 5b: unknown package id rejected at buy-coins', async () => {
  const db = new FakeFirestore(); const deps = mkDeps(db, {});
  const r = await buy(deps, 'COINS-3100001', { packageId: 'PACKAGE_999999' });
  assert.equal(r.http, 400);
  assert.equal(db.read('coinPurchases/COINS-3100001'), undefined);
});

test('SPIN 6: incorrect Paystack amount is rejected (no coins) and recorded for review', async () => {
  for (const [i, pesewas] of [100, 1500, 999, 2251, 10000].entries()) {
    const db = new FakeFirestore(); const ref = 'COINS-400000' + i;
    const deps = mkDeps(db, { [ref]: paid(pesewas) });
    await buy(deps, ref);
    const r = await spin.handleVerifyPurchase(deps, { reference: ref });
    assert.equal(r.http, 400); assert.equal(r.json.code, 'AMOUNT_MISMATCH');
    assert.equal(walletCoins(db), 0);
    const ev = db.read('paymentEvents/' + ref);
    assert.equal(ev.status, 'FAILED'); assert.equal(ev.details.amountPesewas, pesewas);
  }
});

test('SPIN 6b: wrong currency / other person\'s payment rejected', async () => {
  const db = new FakeFirestore();
  const deps = mkDeps(db, {
    'COINS-4100001': paid(1000, { currency: 'USD' }),
    'COINS-4100002': paid(1000, { customer: { email: '0244000000@voltix.com' } }),
  });
  await buy(deps, 'COINS-4100001'); await buy(deps, 'COINS-4100002');
  assert.equal((await spin.handleVerifyPurchase(deps, { reference: 'COINS-4100001' })).json.code, 'BAD_CURRENCY');
  assert.equal((await spin.handleVerifyPurchase(deps, { reference: 'COINS-4100002' })).json.code, 'IDENTITY_MISMATCH');
  assert.equal(walletCoins(db), 0);
});

test('SPIN 7: invalid reference (bad format, unknown to server, unknown to Paystack)', async () => {
  const db = new FakeFirestore(); const deps = mkDeps(db, {});
  assert.equal((await spin.handleVerifyPurchase(deps, { reference: '../x' })).http, 400);
  assert.equal((await spin.handleVerifyPurchase(deps, {})).http, 400);
  assert.equal((await spin.handleVerifyPurchase(deps, { reference: 'COINS-9999999' })).http, 404); // no purchase record
  await buy(deps, 'COINS-5000001');                                                               // record exists, Paystack never heard of it
  const r = await spin.handleVerifyPurchase(deps, { reference: 'COINS-5000001' });
  assert.equal(r.http, 400); assert.equal(r.json.code, 'INVALID_REFERENCE');
  assert.equal(walletCoins(db), 0);
});

test('SPIN 8: failed / abandoned payment credits nothing; a later success still works', async () => {
  const db = new FakeFirestore(); const ref = 'COINS-6000001';
  const table = { [ref]: paid(1000, { status: 'failed' }) };
  const deps = mkDeps(db, table);
  await buy(deps, ref);
  const r = await spin.handleVerifyPurchase(deps, { reference: ref });
  assert.equal(r.http, 400); assert.equal(r.json.code, 'NOT_SUCCESSFUL'); assert.equal(walletCoins(db), 0);
  table[ref] = paid(1000);                                   // customer retries and it succeeds
  assert.equal((await spin.handleVerifyPurchase(deps, { reference: ref })).http, 200);
  assert.equal(walletCoins(db), 100);
});

test('SPIN 8b: Paystack unreachable is retryable and credits nothing', async () => {
  const db = new FakeFirestore(); const ref = 'COINS-6100001';
  const table = { [ref]: 'THROW' }; const deps = mkDeps(db, table);
  await buy(deps, ref);
  const r = await spin.handleVerifyPurchase(deps, { reference: ref });
  assert.equal(r.http, 502); assert.equal(walletCoins(db), 0);
  table[ref] = paid(1000);
  assert.equal((await spin.handleVerifyPurchase(deps, { reference: ref })).http, 200);
  assert.equal(walletCoins(db), 100);
});

test('SPIN 9: repeated and simultaneous verification credit once', async () => {
  const db = new FakeFirestore(); const ref = 'COINS-7000001';
  const deps = mkDeps(db, { [ref]: paid(2250) });
  await buy(deps, ref);
  const results = await Promise.all(Array.from({ length: 6 }, () => spin.handleVerifyPurchase(deps, { reference: ref })));
  assert.ok(results.every((r) => r.http === 200));
  await spin.handleVerifyPurchase(deps, { reference: ref });
  assert.equal(walletCoins(db), 250);
});

test('SPIN 10: webhook + verification for the same transaction credit once', async () => {
  const db = new FakeFirestore(); const ref = 'COINS-8000001';
  const deps = mkDeps(db, { [ref]: paid(1000) });
  await buy(deps, ref);
  const raw = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: ref } }));
  const sig = crypto.createHmac('sha512', SECRET).update(raw).digest('hex');
  const [w1, v1, w2] = await Promise.all([
    spin.handleWebhook(deps, { rawBody: raw, signature: sig }),
    spin.handleVerifyPurchase(deps, { reference: ref }),
    spin.handleWebhook(deps, { rawBody: raw, signature: sig }),
  ]);
  assert.equal(w1.http, 200); assert.equal(w2.http, 200); assert.equal(v1.http, 200);
  assert.equal(walletCoins(db), 100);
});

test('SPIN webhook: bad / missing signature is rejected and credits nothing', async () => {
  const db = new FakeFirestore(); const ref = 'COINS-8100001';
  const deps = mkDeps(db, { [ref]: paid(1000) });
  await buy(deps, ref);
  const raw = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: ref } }));
  assert.equal((await spin.handleWebhook(deps, { rawBody: raw, signature: 'deadbeef' })).http, 401);
  assert.equal((await spin.handleWebhook(deps, { rawBody: raw, signature: undefined })).http, 401);
  assert.equal(walletCoins(db), 0);
});

test('SPIN: buy-coins cannot reset an already confirmed purchase (no re-credit loop)', async () => {
  const db = new FakeFirestore(); const ref = 'COINS-9000001';
  const deps = mkDeps(db, { [ref]: paid(1000) });
  await buy(deps, ref); await spin.handleVerifyPurchase(deps, { reference: ref });
  const again = await buy(deps, ref, { coins: 99999, priceGHC: 1 });
  assert.equal(again.json.status, 'confirmed');
  await spin.handleVerifyPurchase(deps, { reference: ref });
  assert.equal(walletCoins(db), 100);
  const other = await spin.handleBuyCoins(deps, { phone: '0200000000', ref, name: 'X' });
  assert.equal(other.http, 409);
});

test('SPIN: purchases confirmed BEFORE this change are never credited again', async () => {
  const db = new FakeFirestore(); const ref = 'COINS-9100001';
  db.seed('wallets/' + PHONE, { coins: 37, totalSpend: 10, hasPurchasedBefore: true });
  db.seed('coinPurchases/' + ref, { phone: PHONE, coins: 100, status: 'confirmed' });
  const deps = mkDeps(db, { [ref]: paid(1000) });
  const r = await spin.handleVerifyPurchase(deps, { reference: ref });
  assert.equal(r.json.status, 'already_confirmed'); assert.equal(walletCoins(db), 37);
  assert.equal(deps.paystackVerify.calls.length, 0);
});

test('SPIN: a reference that already paid for balls cannot be reused for coins', async () => {
  const db = new FakeFirestore(); const ref = 'COINS-9200001';
  db.seed('transactions/t1', { reference: ref, status: 'completed', balls: 10 });
  const deps = mkDeps(db, { [ref]: paid(1000) });
  await buy(deps, ref);
  assert.equal((await spin.handleVerifyPurchase(deps, { reference: ref })).http, 409);
  assert.equal(walletCoins(db), 0);
});

test('SPIN: existing balances untouched; only the buyer wallet changes; referral bonus pays once', async () => {
  const db = new FakeFirestore();
  db.seed('wallets/' + PHONE, { coins: 37, totalSpend: 0 });
  db.seed('wallets/0244111222', { coins: 55, name: 'Kofi' });
  db.seed('wallets/0200999888', { coins: 12 });
  db.seed('spinReferralCodes/VLX1234ABC', { phone: '0244111222' });
  const t = { 'COINS-9300001': paid(1000), 'COINS-9300002': paid(1000) };
  const deps = mkDeps(db, t);
  await buy(deps, 'COINS-9300001', { spinRefCode: 'VLX1234ABC' });
  await spin.handleVerifyPurchase(deps, { reference: 'COINS-9300001' });
  assert.equal(walletCoins(db), 37 + 100 + 40);                      // pack + referral bonus
  assert.equal(db.read('wallets/0244111222').coins, 55 + 40);
  assert.equal(db.read('wallets/0200999888').coins, 12);
  await buy(deps, 'COINS-9300002', { spinRefCode: 'VLX1234ABC' });
  await spin.handleVerifyPurchase(deps, { reference: 'COINS-9300002' });
  assert.equal(walletCoins(db), 37 + 100 + 40 + 100);                // no second bonus
  assert.equal(db.read('wallets/0244111222').coins, 95);
});

// ======================= FOOSBALL =======================
const bdeps = (db, table) => mkDeps(db, table);
const bpaid = (pesewas, uid, extra) => ({
  status: 'success', currency: 'GHS', amount: pesewas,
  customer: { email: uid + '@voltix-player.app' }, metadata: { userId: uid, balls: 'whatever' }, ...extra,
});
const balls = (db, uid) => (db.read('users/' + uid) || {}).balls || 0;
const verifyBall = (deps, body) => ball.handleVerifyBallPayment(deps, body);

test('BALLS 1: GHS10 -> 10 balls (and existing balance preserved)', async () => {
  const db = new FakeFirestore(); db.seed('users/u1', { balls: 4, wins: 7, name: 'Kwame' });
  const deps = bdeps(db, { REF0000001: bpaid(1000, 'u1') });
  const r = await verifyBall(deps, { reference: 'REF0000001', userId: 'u1', balls: 10, amountGhc: 10 });
  assert.equal(r.http, 200); assert.equal(r.json.ballsAdded, 10);
  assert.equal(balls(db, 'u1'), 14); assert.equal(db.read('users/u1').wins, 7);
  assert.equal(db.read('paymentEvents/REF0000001').status, 'SUCCESS');
});

test('BALLS 2: GHS5 continue -> 5 balls', async () => {
  const db = new FakeFirestore();
  const deps = bdeps(db, { REF0000002: bpaid(500, 'u1') });
  const r = await verifyBall(deps, { reference: 'REF0000002', userId: 'u1', balls: 5, amountGhc: 5, type: 'continue' });
  assert.equal(r.http, 200); assert.equal(balls(db, 'u1'), 5);
});

test('BALLS: multi-package buy (existing feature) credits 10 per GHS10, max 20 packages', async () => {
  const db = new FakeFirestore();
  const deps = bdeps(db, { REF0000003: bpaid(3000, 'u1'), REF0000004: bpaid(20000, 'u1'), REF0000005: bpaid(21000, 'u1') });
  await verifyBall(deps, { reference: 'REF0000003', userId: 'u1' }); assert.equal(balls(db, 'u1'), 30);
  await verifyBall(deps, { reference: 'REF0000004', userId: 'u1' }); assert.equal(balls(db, 'u1'), 230);
  assert.equal((await verifyBall(deps, { reference: 'REF0000005', userId: 'u1' })).http, 400);
  assert.equal(balls(db, 'u1'), 230);
});

test('BALLS 3: altered browser ball quantity is ignored', async () => {
  const db = new FakeFirestore();
  const deps = bdeps(db, { REF0000006: bpaid(1000, 'u1') });
  const r = await verifyBall(deps, { reference: 'REF0000006', userId: 'u1', balls: 10000, amountGhc: 1000, type: 'continue' });
  assert.equal(r.http, 200); assert.equal(balls(db, 'u1'), 10);
});

test('BALLS 4: "I paid GHS1" with altered amountGhc/balls gets nothing', async () => {
  const db = new FakeFirestore();
  const deps = bdeps(db, { REF0000007: bpaid(100, 'u1') });
  const r = await verifyBall(deps, { reference: 'REF0000007', userId: 'u1', balls: 10000, amountGhc: 1 });
  assert.equal(r.http, 400); assert.equal(r.json.code, 'AMOUNT_MISMATCH');
  assert.equal(balls(db, 'u1'), 0);
});

test('BALLS 5: incorrect Paystack amounts are rejected', async () => {
  for (const [i, p] of [50, 100, 700, 999, 1001, 1500, 2500].entries()) {
    const db = new FakeFirestore(); const ref = 'REF10000' + i;
    const r = await verifyBall(bdeps(db, { [ref]: bpaid(p, 'u1') }), { reference: ref, userId: 'u1' });
    assert.equal(r.http, 400, 'amount ' + p); assert.equal(balls(db, 'u1'), 0);
  }
});

test('BALLS 6: invalid reference', async () => {
  const db = new FakeFirestore(); const deps = bdeps(db, {});
  assert.equal((await verifyBall(deps, { reference: 'bad ref!', userId: 'u1' })).http, 400);
  assert.equal((await verifyBall(deps, { reference: 'NOPE000001', userId: 'u1' })).http, 400);
  assert.equal((await verifyBall(deps, { userId: 'u1' })).http, 400);
  assert.equal((await verifyBall(deps, { reference: 'REF0000008' })).http, 400);
  assert.equal(balls(db, 'u1'), 0);
});

test('BALLS 7: failed payment credits nothing and does not block a later success', async () => {
  const db = new FakeFirestore(); const ref = 'REF0000009';
  const table = { [ref]: bpaid(1000, 'u1', { status: 'abandoned' }) }; const deps = bdeps(db, table);
  assert.equal((await verifyBall(deps, { reference: ref, userId: 'u1' })).http, 400);
  assert.equal(balls(db, 'u1'), 0);
  table[ref] = bpaid(1000, 'u1');
  assert.equal((await verifyBall(deps, { reference: ref, userId: 'u1' })).http, 200);
  assert.equal(balls(db, 'u1'), 10);
});

test('BALLS 8: repeated and simultaneous verification credit once', async () => {
  const db = new FakeFirestore(); const ref = 'REF0000010';
  const deps = bdeps(db, { [ref]: bpaid(1000, 'u1') });
  const rs = await Promise.all(Array.from({ length: 8 }, () => verifyBall(deps, { reference: ref, userId: 'u1' })));
  assert.ok(rs.every((r) => r.http === 200));
  await verifyBall(deps, { reference: ref, userId: 'u1' });
  assert.equal(balls(db, 'u1'), 10);
  assert.equal((await db.collection('transactions').where('reference', '==', ref).get()).size, 1);
});

test('BALLS: payment made by one player cannot be claimed by another', async () => {
  const db = new FakeFirestore();
  const deps = bdeps(db, { REF0000011: bpaid(1000, 'victim') });
  const r = await verifyBall(deps, { reference: 'REF0000011', userId: 'attacker' });
  assert.equal(r.http, 400); assert.equal(r.json.code, 'IDENTITY_MISMATCH');
  assert.equal(balls(db, 'attacker'), 0); assert.equal(balls(db, 'victim'), 0);
});

test('BALLS: purchases credited BEFORE this change are not credited again; old failed rows do not block', async () => {
  const db = new FakeFirestore();
  db.seed('users/u1', { balls: 3 });
  db.seed('transactions/old1', { reference: 'REF0000012', status: 'completed', balls: 10, userId: 'u1' });
  db.seed('transactions/old2', { reference: 'REF0000013', status: 'failed', userId: 'u1' });
  const deps = bdeps(db, { REF0000012: bpaid(1000, 'u1'), REF0000013: bpaid(1000, 'u1') });
  assert.equal((await verifyBall(deps, { reference: 'REF0000012', userId: 'u1' })).json.note, 'Already processed');
  assert.equal(balls(db, 'u1'), 3);
  assert.equal((await verifyBall(deps, { reference: 'REF0000013', userId: 'u1' })).http, 200);
  assert.equal(balls(db, 'u1'), 13);
});

test('CROSS-PATH: one reference cannot credit both balls and coins', async () => {
  const db = new FakeFirestore(); const ref = 'REF0000014';
  const deps = bdeps(db, { [ref]: { ...bpaid(1000, 'u1'), customer: { email: 'u1@voltix-player.app' } } });
  assert.equal((await verifyBall(deps, { reference: ref, userId: 'u1' })).http, 200);
  await spin.handleBuyCoins(deps, { phone: PHONE, ref });
  assert.equal((await spin.handleVerifyPurchase(deps, { reference: ref })).http, 409);
  assert.equal(walletCoins(db), 0); assert.equal(balls(db, 'u1'), 10);
});

test('SECURITY: no secrets or provider internals leak in responses', async () => {
  const db = new FakeFirestore(); const deps = bdeps(db, { REF0000015: 'THROW' });
  const r = await verifyBall(deps, { reference: 'REF0000015', userId: 'u1' });
  assert.ok(!JSON.stringify(r).includes(SECRET)); assert.ok(!JSON.stringify(r).includes('network'));
});
