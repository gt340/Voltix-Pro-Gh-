'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { FakeFirestore, FieldValue } = require('./fake-firestore');
const spin = require('../spin-backend/payments');
const ball = require('../lib/ball-payments');

const SECRET = 'sk_test_unit';
const PHONE = '0536 193 862';
const SHOPPER = { uid: 'test-shopper-1', phone_number: PHONE };

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
const buy = (deps, ref, extra) => spin.handleBuyCoins(deps, { phone: PHONE, ref, name: 'Ama', ...extra }, SHOPPER);
const verifyPurchase = (deps, reference, shopper = SHOPPER) => spin.handleVerifyPurchase(deps, { reference }, shopper);
const walletCoins = (db) => (db.read('wallets/' + PHONE) || {}).coins || 0;

// ======================= SPIN =======================
test('SPIN 1-3: each package credits exactly its server-defined coins', async () => {
  for (const [pesewas, coins, ref] of [[1000, 100, 'COINS-1000001'], [2250, 250, 'COINS-1000002'], [4500, 500, 'COINS-1000003']]) {
    const db = new FakeFirestore();
    const deps = mkDeps(db, { [ref]: paid(pesewas) });
    await buy(deps, ref);
    const r = await verifyPurchase(deps, ref );
    assert.equal(r.http, 200); assert.equal(r.json.status, 'confirmed');
    assert.equal(walletCoins(db), coins);
    assert.equal(db.read('paymentEvents/' + ref).status, 'SUCCESS');
  }
});

test('SPIN 4: altered browser coin quantity is ignored', async () => {
  const db = new FakeFirestore(); const ref = 'COINS-2000001';
  const deps = mkDeps(db, { [ref]: paid(1000) });
  await buy(deps, ref, { coins: 1000000, priceGHC: 10 });
  const r = await verifyPurchase(deps, ref );
  assert.equal(r.http, 200);
  assert.equal(walletCoins(db), 100);
});

test('SPIN 5: altered browser price / package request is rejected or ignored, never over-credits', async () => {
  const db = new FakeFirestore(); const ref = 'COINS-3000001';
  const deps = mkDeps(db, { [ref]: paid(1000) });                       // paid GHS10
  await buy(deps, ref, { packageId: 'PACKAGE_500', coins: 500, priceGHC: 1 });
  const r = await verifyPurchase(deps, ref );  // asked for 500, paid 10
  assert.equal(r.http, 400); assert.equal(r.json.code, 'AMOUNT_MISMATCH');
  assert.equal(walletCoins(db), 0);
  // legacy client lying about price only: credit follows what was actually paid
  const ref2 = 'COINS-3000002';
  const deps2 = mkDeps(db, { [ref2]: paid(1000) });
  await buy(deps2, ref2, { coins: 500, priceGHC: 1 });
  await verifyPurchase(deps2, ref2);
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
    const r = await verifyPurchase(deps, ref );
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
  assert.equal((await verifyPurchase(deps, 'COINS-4100001' )).json.code, 'BAD_CURRENCY');
  assert.equal((await verifyPurchase(deps, 'COINS-4100002' )).json.code, 'IDENTITY_MISMATCH');
  assert.equal(walletCoins(db), 0);
});

test('SPIN 7: invalid reference (bad format, unknown to server, unknown to Paystack)', async () => {
  const db = new FakeFirestore(); const deps = mkDeps(db, {});
  assert.equal((await verifyPurchase(deps, '../x' )).http, 400);
  assert.equal((await spin.handleVerifyPurchase(deps, {}, SHOPPER)).http, 400);
  assert.equal((await verifyPurchase(deps, 'COINS-9999999' )).http, 404); // no purchase record
  await buy(deps, 'COINS-5000001');                                                               // record exists, Paystack never heard of it
  const r = await verifyPurchase(deps, 'COINS-5000001' );
  assert.equal(r.http, 400); assert.equal(r.json.code, 'INVALID_REFERENCE');
  assert.equal(walletCoins(db), 0);
});

test('SPIN 8: failed / abandoned payment credits nothing; a later success still works', async () => {
  const db = new FakeFirestore(); const ref = 'COINS-6000001';
  const table = { [ref]: paid(1000, { status: 'failed' }) };
  const deps = mkDeps(db, table);
  await buy(deps, ref);
  const r = await verifyPurchase(deps, ref );
  assert.equal(r.http, 400); assert.equal(r.json.code, 'NOT_SUCCESSFUL'); assert.equal(walletCoins(db), 0);
  table[ref] = paid(1000);                                   // customer retries and it succeeds
  assert.equal((await verifyPurchase(deps, ref )).http, 200);
  assert.equal(walletCoins(db), 100);
});

test('SPIN 8b: Paystack unreachable is retryable and credits nothing', async () => {
  const db = new FakeFirestore(); const ref = 'COINS-6100001';
  const table = { [ref]: 'THROW' }; const deps = mkDeps(db, table);
  await buy(deps, ref);
  const r = await verifyPurchase(deps, ref );
  assert.equal(r.http, 502); assert.equal(walletCoins(db), 0);
  table[ref] = paid(1000);
  assert.equal((await verifyPurchase(deps, ref )).http, 200);
  assert.equal(walletCoins(db), 100);
});

test('SPIN 9: repeated and simultaneous verification credit once', async () => {
  const db = new FakeFirestore(); const ref = 'COINS-7000001';
  const deps = mkDeps(db, { [ref]: paid(2250) });
  await buy(deps, ref);
  const results = await Promise.all(Array.from({ length: 6 }, () => verifyPurchase(deps, ref )));
  assert.ok(results.every((r) => r.http === 200));
  await verifyPurchase(deps, ref );
  assert.equal(walletCoins(db), 250);
});

test('SPIN 10: webhook + verification retry safely and credit once', async () => {
  const db = new FakeFirestore(); const ref = 'COINS-8000001';
  const deps = mkDeps(db, { [ref]: paid(1000) });
  await buy(deps, ref);
  const raw = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: ref } }));
  const sig = crypto.createHmac('sha512', SECRET).update(raw).digest('hex');
  const [w1, v1, w2] = await Promise.all([
    spin.handleWebhook(deps, { rawBody: raw, signature: sig }),
    verifyPurchase(deps, ref ),
    spin.handleWebhook(deps, { rawBody: raw, signature: sig }),
  ]);
  // A concurrent webhook must ask Paystack to retry rather than acknowledge
  // a reference whose processing lease is held by another worker.
  assert.ok([200, 500].includes(w1.http));
  assert.ok([200, 409].includes(v1.http));
  assert.ok([200, 500].includes(w2.http));
  // Once the concurrent worker finishes, either entry point can safely retry.
  const retried = await verifyPurchase(deps, ref);
  assert.equal(retried.http, 200);
  const webhookRetry = await spin.handleWebhook(deps, { rawBody: raw, signature: sig });
  assert.equal(webhookRetry.http, 200);
  assert.equal(walletCoins(db), 100);
});

test('SPIN webhook: verified webhook arriving before purchase is durably reconciled after purchase creation', async () => {
  const db = new FakeFirestore(); const ref = 'COINS-INBOX0001';
  const deps = mkDeps(db, { [ref]: paid(1000) });
  const raw = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: ref, amount: 1000, currency: 'GHS', status: 'success' } }));
  const sig = crypto.createHmac('sha512', SECRET).update(raw).digest('hex');

  const webhook = await spin.handleWebhook(deps, { rawBody: raw, signature: sig });
  assert.equal(webhook.http, 500);
  assert.equal(webhook.outcome, 'UNMATCHED');
  assert.match(webhook.text, /retry later/i);
  assert.equal(db.read('paymentWebhookInbox/' + ref).status, 'RECEIVED_UNMATCHED');
  assert.equal(db.read('paymentWebhookInbox/' + ref).signatureVerified, true);
  assert.equal(walletCoins(db), 0);
  assert.equal(deps.paystackVerify.calls.length, 0);

  const purchase = await buy(deps, ref);
  assert.equal(purchase.http, 200);
  assert.equal(purchase.json.status, 'confirmed');
  assert.equal(walletCoins(db), 100);
  assert.equal(db.read('coinPurchases/' + ref).status, 'confirmed');
  assert.equal(db.read('paymentEvents/' + ref).status, 'SUCCESS');
  assert.equal(db.read('paymentWebhookInbox/' + ref).status, 'PROCESSED');
});

test('SPIN webhook inbox: duplicate unmatched deliveries are idempotent and later credit once', async () => {
  const db = new FakeFirestore(); const ref = 'COINS-INBOX0002';
  const deps = mkDeps(db, { [ref]: paid(1000) });
  const raw = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: ref, amount: 1000, currency: 'GHS', status: 'success' } }));
  const sig = crypto.createHmac('sha512', SECRET).update(raw).digest('hex');

  const firstDelivery = await spin.handleWebhook(deps, { rawBody: raw, signature: sig });
  const secondDelivery = await spin.handleWebhook(deps, { rawBody: raw, signature: sig });
  assert.equal(firstDelivery.http, 500);
  assert.equal(firstDelivery.outcome, 'UNMATCHED');
  assert.equal(secondDelivery.http, 500);
  assert.equal(secondDelivery.outcome, 'UNMATCHED');
  assert.equal(db.read('paymentWebhookInbox/' + ref).deliveryCount, 2);
  assert.equal(walletCoins(db), 0);

  await buy(deps, ref);
  assert.equal(walletCoins(db), 100);
  await spin.handleWebhook(deps, { rawBody: raw, signature: sig });
  assert.equal(walletCoins(db), 100);
  assert.equal(db.read('paymentWebhookInbox/' + ref).status, 'PROCESSED');
});

test('SPIN webhook reconciler: admin batch processes matched receipts and retains unmatched receipts', async () => {
  const db = new FakeFirestore();
  const matchedRef = 'COINS-RECON0001';
  const unmatchedRef = 'COINS-RECON0002';
  const deps = mkDeps(db, {
    [matchedRef]: paid(1000),
    [unmatchedRef]: paid(1000),
  });
  const makeWebhook = async (ref) => {
    const raw = Buffer.from(JSON.stringify({
      event: 'charge.success',
      data: { reference: ref, amount: 1000, currency: 'GHS', status: 'success' }
    }));
    const signature = crypto.createHmac('sha512', SECRET).update(raw).digest('hex');
    return spin.handleWebhook(deps, { rawBody: raw, signature });
  };

  assert.equal((await makeWebhook(matchedRef)).http, 500);
  assert.equal((await makeWebhook(unmatchedRef)).http, 500);
  await db.collection('coinPurchases').doc(matchedRef).create({
    phone: PHONE,
    shopperUid: SHOPPER.uid,
    requestedPackageId: 'PACKAGE_100',
    status: 'pending',
  });

  const summary = await spin.reconcileWebhookInbox(deps, { limit: 10 });
  assert.deepEqual(summary, {
    scanned: 2, processed: 1, unmatched: 1, recoveryRequired: 0,
    requiresReview: 0, retryable: 0, failed: 0,
  });
  assert.equal(walletCoins(db), 100);
  assert.equal(db.read('paymentWebhookInbox/' + matchedRef).status, 'PROCESSED');
  assert.equal(db.read('paymentWebhookInbox/' + unmatchedRef).status, 'RECEIVED_UNMATCHED');
  assert.equal(deps.paystackVerify.calls.filter((ref) => ref === matchedRef).length, 1);
  assert.equal(deps.paystackVerify.calls.includes(unmatchedRef), false);
});

test('SPIN webhook reconciler: batch limit is enforced and repeated runs remain idempotent', async () => {
  const db = new FakeFirestore();
  const refs = ['COINS-RECON0011', 'COINS-RECON0012', 'COINS-RECON0013'];
  const deps = mkDeps(db, {});
  let clock = 1700000000100;
  deps.now = () => ++clock;
  for (const ref of refs) {
    await spin.persistWebhookReceipt(db, ref, {
      event: 'charge.success',
      data: { reference: ref, amount: 1000, currency: 'GHS', status: 'success' },
    }, 1700000000000);
  }

  const first = await spin.reconcileWebhookInbox(deps, { limit: 2 });
  assert.equal(first.scanned, 2);
  assert.equal(first.unmatched, 2);
  const second = await spin.reconcileWebhookInbox(deps, { limit: 1 });
  assert.equal(second.scanned, 1);
  assert.equal(second.unmatched, 1);
  assert.equal(walletCoins(db), 0);
  assert.equal(db.read('paymentWebhookInbox/' + refs[0]).status, 'RECEIVED_UNMATCHED');
  assert.equal(db.read('paymentWebhookInbox/' + refs[1]).status, 'RECEIVED_UNMATCHED');
  assert.equal(db.read('paymentWebhookInbox/' + refs[2]).status, 'RECEIVED_UNMATCHED');
  assert.ok(db.read('paymentWebhookInbox/' + refs[2]).lastReconciliationAttemptAt,
    'the oldest untouched receipt must be reached on the next bounded run');
});

test('SPIN webhook inbox: terminal Paystack amount mismatch is retained for review without credit', async () => {
  const db = new FakeFirestore(); const ref = 'COINS-INBOX0003';
  const deps = mkDeps(db, { [ref]: paid(2250) });
  await buy(deps, ref, { packageId: 'PACKAGE_100' });
  const raw = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: ref, amount: 2250, currency: 'GHS', status: 'success' } }));
  const sig = crypto.createHmac('sha512', SECRET).update(raw).digest('hex');

  const result = await spin.handleWebhook(deps, { rawBody: raw, signature: sig });
  assert.equal(result.http, 200);
  assert.equal(result.outcome, 'REQUIRES_REVIEW');
  assert.equal(db.read('paymentWebhookInbox/' + ref).status, 'REQUIRES_REVIEW');
  assert.equal(db.read('paymentWebhookInbox/' + ref).resultCode, 'AMOUNT_MISMATCH');
  assert.equal(db.read('coinPurchases/' + ref).status, 'pending');
  assert.equal(walletCoins(db), 0);
  const verificationCalls = deps.paystackVerify.calls.length;
  await spin.handleWebhook(deps, { rawBody: raw, signature: sig });
  assert.equal(deps.paystackVerify.calls.length, verificationCalls);
  assert.equal(walletCoins(db), 0);
});

test('SPIN webhook inbox: durable receipt write failure is not acknowledged', async () => {
  const db = new FakeFirestore(); const ref = 'COINS-INBOX0004';
  const deps = mkDeps(db, { [ref]: paid(1000) });
  db.runTransaction = async () => { throw new Error('storage unavailable'); };
  const raw = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: ref } }));
  const sig = crypto.createHmac('sha512', SECRET).update(raw).digest('hex');
  await assert.rejects(() => spin.handleWebhook(deps, { rawBody: raw, signature: sig }), /storage unavailable/);
  assert.equal(db.read('paymentWebhookInbox/' + ref), undefined);
});

test('SPIN webhook: bad / missing signature is rejected and credits nothing', async () => {
  const db = new FakeFirestore(); const ref = 'COINS-8100001';
  const deps = mkDeps(db, { [ref]: paid(1000) });
  await buy(deps, ref);
  const raw = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: ref } }));
  assert.equal((await spin.handleWebhook(deps, { rawBody: raw, signature: 'deadbeef' })).http, 401);
  assert.equal((await spin.handleWebhook(deps, { rawBody: raw, signature: undefined })).http, 401);
  assert.equal(walletCoins(db), 0);
  assert.equal(db.read('paymentWebhookInbox/' + ref), undefined);
});

test('SPIN: buy-coins cannot reset an already confirmed purchase (no re-credit loop)', async () => {
  const db = new FakeFirestore(); const ref = 'COINS-9000001';
  const deps = mkDeps(db, { [ref]: paid(1000) });
  await buy(deps, ref); await verifyPurchase(deps, ref );
  const again = await buy(deps, ref, { coins: 99999, priceGHC: 1 });
  assert.equal(again.json.status, 'confirmed');
  await verifyPurchase(deps, ref );
  assert.equal(walletCoins(db), 100);
  const other = await spin.handleBuyCoins(deps, { phone: '0200000000', ref, name: 'X' }, { uid: 'test-shopper-2', phone_number: '0200000000' });
  assert.equal(other.http, 409);
});

test('SPIN: purchases confirmed BEFORE this change are never credited again', async () => {
  const db = new FakeFirestore(); const ref = 'COINS-9100001';
  db.seed('wallets/' + PHONE, { coins: 37, totalSpend: 10, hasPurchasedBefore: true });
  db.seed('coinPurchases/' + ref, { phone: PHONE, shopperUid: SHOPPER.uid, coins: 100, status: 'confirmed' });
  const deps = mkDeps(db, { [ref]: paid(1000) });
  const r = await verifyPurchase(deps, ref );
  assert.equal(r.json.status, 'already_confirmed'); assert.equal(walletCoins(db), 37);
  assert.equal(deps.paystackVerify.calls.length, 0);
});

test('SPIN: a reference that already paid for balls cannot be reused for coins', async () => {
  const db = new FakeFirestore(); const ref = 'COINS-9200001';
  db.seed('transactions/t1', { reference: ref, status: 'completed', balls: 10 });
  const deps = mkDeps(db, { [ref]: paid(1000) });
  await buy(deps, ref);
  assert.equal((await verifyPurchase(deps, ref )).http, 409);
  assert.equal(walletCoins(db), 0);
});

test('SPIN referral: simultaneous first purchases award one buyer bonus and one referrer bonus', async () => {
  const db = new FakeFirestore();
  db.seed('wallets/0244111222', { ownerUid: 'referrer-concurrent', coins: 10, name: 'Kofi' });
  db.seed('spinReferralCodes/VLXCONC123', { phone: '0244111222', ownerUid: 'referrer-concurrent' });
  const refs = ['COINS-CONC0001', 'COINS-CONC0002'];
  const deps = mkDeps(db, {
    [refs[0]]: paid(1000),
    [refs[1]]: paid(1000),
  });
  await Promise.all(refs.map((ref) => buy(deps, ref, { spinRefCode: 'VLXCONC123' })));
  const results = await Promise.all(refs.map((ref) => verifyPurchase(deps, ref)));
  assert.ok(results.every((result) => result.http === 200));
  // Exactly one referral reward is recorded. The referred shopper receives
  // one 40-coin bonus in addition to both 100-coin package credits.
  assert.equal(walletCoins(db), 240);
  assert.equal(db.read('wallets/0244111222').coins, 50);
  const rewards = await db.collection('spinReferrals')
    .where('referredPhone', '==', PHONE).where('status', '==', 'rewarded').get();
  assert.equal(rewards.size, 1);
  assert.equal(rewards.docs[0].data().coinsAwarded, 40);
});

test('SPIN: existing balances untouched; only the buyer wallet changes; referral bonus pays once', async () => {
  const db = new FakeFirestore();
  db.seed('wallets/' + PHONE, { ownerUid: SHOPPER.uid, coins: 37, totalSpend: 0 });
  db.seed('wallets/0244111222', { ownerUid: 'referrer-test-1', coins: 55, name: 'Kofi' });
  db.seed('wallets/0200999888', { coins: 12 });
  db.seed('spinReferralCodes/VLX1234ABC', { phone: '0244111222', ownerUid: 'referrer-test-1' });
  const t = { 'COINS-9300001': paid(1000), 'COINS-9300002': paid(1000) };
  const deps = mkDeps(db, t);
  await buy(deps, 'COINS-9300001', { spinRefCode: 'VLX1234ABC' });
  await verifyPurchase(deps, 'COINS-9300001' );
  assert.equal(walletCoins(db), 37 + 100 + 40);                      // pack + referral bonus
  assert.equal(db.read('wallets/0244111222').coins, 55 + 40);
  assert.equal(db.read('wallets/0200999888').coins, 12);
  await buy(deps, 'COINS-9300002', { spinRefCode: 'VLX1234ABC' });
  await verifyPurchase(deps, 'COINS-9300002' );
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
  await spin.handleBuyCoins(deps, { phone: PHONE, ref }, SHOPPER);
  assert.equal((await verifyPurchase(deps, ref )).http, 409);
  assert.equal(walletCoins(db), 0); assert.equal(balls(db, 'u1'), 10);
});

test('CROSS-PATH: a successful ball payment cannot be reported as a confirmed coin purchase', async () => {
  const db = new FakeFirestore();
  const ref = 'CROSS-BALL001';
  db.seed('coinPurchases/' + ref, {
    phone: PHONE, shopperUid: SHOPPER.uid, status: 'pending'
  });
  db.seed('paymentEvents/' + ref, {
    status: 'SUCCESS', purpose: 'balls', credited: 10
  });
  const deps = mkDeps(db, { [ref]: paid(1000) });
  const result = await verifyPurchase(deps, ref);
  assert.equal(result.http, 409);
  assert.equal(result.json.code, 'REFERENCE_PURPOSE_MISMATCH');
  assert.equal(walletCoins(db), 0);
  assert.equal(db.read('coinPurchases/' + ref).status, 'pending');
});

test('CROSS-PATH: a successful coin payment cannot be reported as a completed ball purchase', async () => {
  const db = new FakeFirestore();
  const ref = 'CROSS-COIN001';
  db.seed('paymentEvents/' + ref, {
    status: 'SUCCESS', purpose: 'spinCoins', credited: 100
  });
  const deps = bdeps(db, { [ref]: bpaid(1000, 'player-1') });
  const result = await verifyBall(deps, { reference: ref, userId: 'player-1' });
  assert.equal(result.http, 409);
  assert.equal(result.json.code, 'REFERENCE_PURPOSE_MISMATCH');
  assert.equal(balls(db, 'player-1'), 0);
  assert.equal((await db.collection('transactions').where('reference', '==', ref).get()).size, 0);
});

test('CROSS-PATH: an active lease held by another payment flow is not treated as ordinary contention', async () => {
  const db = new FakeFirestore();
  const ref = 'CROSS-LEASE01';
  db.seed('coinPurchases/' + ref, {
    phone: PHONE, shopperUid: SHOPPER.uid, status: 'pending'
  });
  db.seed('paymentEvents/' + ref, {
    status: 'PROCESSING', purpose: 'balls', leaseToken: 'ball-worker',
    leaseExpiresAt: 1700000030000, attempts: 1
  });
  const deps = mkDeps(db, { [ref]: paid(1000) });
  const result = await verifyPurchase(deps, ref);
  assert.equal(result.http, 409);
  assert.equal(result.json.code, 'REFERENCE_PURPOSE_MISMATCH');
  assert.equal(walletCoins(db), 0);
});

test('SECURITY: no secrets or provider internals leak in responses', async () => {
  const db = new FakeFirestore(); const deps = bdeps(db, { REF0000015: 'THROW' });
  const r = await verifyBall(deps, { reference: 'REF0000015', userId: 'u1' });
  assert.ok(!JSON.stringify(r).includes(SECRET)); assert.ok(!JSON.stringify(r).includes('network'));
});


// ======================= SHOPPER WALLET OWNERSHIP =======================
test('SECURITY: another Firebase UID cannot verify a shopper purchase', async () => {
  const db = new FakeFirestore(); const ref = 'COINS-OWN0001';
  const deps = mkDeps(db, { [ref]: paid(1000) });
  await buy(deps, ref);
  const attacker = await verifyPurchase(deps, ref, { uid: 'attacker-uid', phone_number: PHONE });
  assert.equal(attacker.http, 403);
  assert.equal(walletCoins(db), 0);
  assert.equal(db.read('coinPurchases/' + ref).status, 'pending');
});

test('SECURITY: wallet owned by another UID rejects buyer and referral credits', async () => {
  const db = new FakeFirestore(); const ref = 'COINS-OWN0002';
  db.seed('wallets/' + PHONE, { ownerUid: 'different-shopper', coins: 25 });
  db.seed('wallets/0244111222', { ownerUid: 'referrer-owner', coins: 60 });
  db.seed('spinReferralCodes/VLXOWN02', { phone: '0244111222', ownerUid: 'referrer-owner' });
  const deps = mkDeps(db, { [ref]: paid(1000) });
  const r = await buy(deps, ref, { spinRefCode: 'VLXOWN02' });
  assert.equal(r.http, 409);
  assert.equal(r.json.code, 'WALLET_OWNED_BY_ANOTHER_ACCOUNT');
  assert.equal(db.read('coinPurchases/' + ref), undefined);
  assert.equal(walletCoins(db), 25);
  assert.equal(db.read('wallets/0244111222').coins, 60);
  assert.equal((await db.collection('spinReferrals').get()).size, 0);
  assert.equal(db.read('paymentEvents/' + ref), undefined);
});

test('SECURITY: legacy wallet without ownerUid requires recovery and receives no credits', async () => {
  const db = new FakeFirestore(); const ref = 'COINS-OWN0003';
  db.seed('wallets/' + PHONE, { coins: 31 });
  const deps = mkDeps(db, { [ref]: paid(1000) });
  const r = await buy(deps, ref);
  assert.equal(r.http, 409);
  assert.equal(r.json.code, 'LEGACY_WALLET_RECOVERY_REQUIRED');
  assert.equal(db.read('coinPurchases/' + ref), undefined);
  assert.equal(walletCoins(db), 31);
});

test('SECURITY: a paid purchase blocked by a wallet ownership change becomes a durable recovery case', async () => {
  const db = new FakeFirestore();
  const ref = 'COINS-RECOV001';
  const deps = mkDeps(db, { [ref]: paid(1000) });
  await buy(deps, ref);
  // Ownership changes after checkout preflight but before provider verification.
  db.seed('wallets/' + PHONE, { ownerUid: 'different-account', coins: 17 });
  const result = await verifyPurchase(deps, ref);
  assert.equal(result.http, 409);
  assert.equal(result.code, 'RECOVERY_REQUIRED');
  assert.equal(result.json.status, 'recovery_required');
  assert.equal(walletCoins(db), 17);
  assert.equal(db.read('coinPurchases/' + ref).status, 'recovery_required');
  assert.equal(db.read('paymentEvents/' + ref).status, 'RECOVERY_REQUIRED');
  const recovery = db.read('paymentRecoveryCases/' + ref);
  assert.equal(recovery.status, 'OPEN');
  assert.equal(recovery.reason, 'WALLET_OWNED_BY_ANOTHER_ACCOUNT');
  assert.equal(recovery.shopperUid, SHOPPER.uid);
  assert.equal(recovery.phone, PHONE);
});

test('SECURITY: ownership-blocked paid purchase is durably queued and webhook can acknowledge it', async () => {
  const db = new FakeFirestore();
  const ref = 'COINS-RECOV002';
  const deps = mkDeps(db, { [ref]: paid(1000) });
  await buy(deps, ref);
  db.seed('wallets/' + PHONE, { coins: 12 }); // legacy wallet without ownerUid
  const raw = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: ref } }));
  const sig = crypto.createHmac('sha512', SECRET).update(raw).digest('hex');
  const webhook = await spin.handleWebhook(deps, { rawBody: raw, signature: sig });
  assert.equal(webhook.http, 200);
  assert.equal(db.read('paymentEvents/' + ref).status, 'RECOVERY_REQUIRED');
  assert.equal(db.read('coinPurchases/' + ref).status, 'recovery_required');
  assert.equal(db.read('paymentRecoveryCases/' + ref).status, 'OPEN');
  // Repeated webhook/verification attempts do not auto-credit or erase the case.
  assert.equal((await spin.handleWebhook(deps, { rawBody: raw, signature: sig })).http, 200);
  const retry = await verifyPurchase(deps, ref);
  assert.equal(retry.http, 409);
  assert.equal(retry.code, 'RECOVERY_REQUIRED');
  assert.equal(walletCoins(db), 12);
  assert.equal(db.read('paymentRecoveryCases/' + ref).status, 'OPEN');
});

test('SECURITY: purchase without shopperUid requires ownership recovery', async () => {
  const db = new FakeFirestore(); const ref = 'COINS-OWN0004';
  db.seed('coinPurchases/' + ref, { phone: PHONE, coins: 100, status: 'pending' });
  const deps = mkDeps(db, { [ref]: paid(1000) });
  const r = await spin.creditSpinPurchase(deps, ref);
  assert.equal(r.http, 409);
  assert.equal(r.json.code, 'OWNER_RECOVERY_REQUIRED');
  assert.equal(walletCoins(db), 0);
  assert.equal(db.read('paymentEvents/' + ref), undefined);
});

test('SECURITY: referral code UID mismatch suppresses bonus but preserves buyer package credit', async () => {
  const db = new FakeFirestore(); const ref = 'COINS-OWN0005';
  db.seed('wallets/0244111222', { ownerUid: 'actual-referrer-owner', coins: 70 });
  db.seed('spinReferralCodes/VLXOWN05', { phone: '0244111222', ownerUid: 'different-code-owner' });
  const deps = mkDeps(db, { [ref]: paid(1000) });
  await buy(deps, ref, { spinRefCode: 'VLXOWN05' });
  const r = await verifyPurchase(deps, ref);
  assert.equal(r.http, 200);
  assert.equal(walletCoins(db), 100);
  assert.equal(db.read('wallets/0244111222').coins, 70);
  assert.equal((await db.collection('spinReferrals').get()).size, 0);
});

test('SECURITY: ownership-blocked paid purchase stays queued after wallet metadata changes', async () => {
  const db = new FakeFirestore(); const ref = 'COINS-OWN0006';
  db.seed('wallets/' + PHONE, { ownerUid: 'old-owner', coins: 9 });
  const deps = mkDeps(db, { [ref]: paid(1000) });
  // Simulate the narrow race where wallet ownership changes after purchase
  // preparation but before Paystack verification completes.
  db.seed('coinPurchases/' + ref, { phone: PHONE, shopperUid: SHOPPER.uid, status: 'pending' });
  const rejected = await verifyPurchase(deps, ref);
  assert.equal(rejected.http, 409);
  assert.equal(rejected.json.code, 'WALLET_OWNED_BY_ANOTHER_ACCOUNT');
  assert.equal(walletCoins(db), 9);
  // Once payment is durably queued, automatic retries must not bypass the
  // support-review gate even if wallet metadata later changes.
  await db.collection('wallets').doc(PHONE).set({ ownerUid: SHOPPER.uid }, { merge: true });
  const retried = await verifyPurchase(deps, ref);
  assert.equal(retried.http, 409);
  assert.equal(retried.code, 'RECOVERY_REQUIRED');
  assert.equal(retried.json.status, 'recovery_required');
  assert.equal(walletCoins(db), 9);
  assert.equal(db.read('paymentEvents/' + ref).status, 'RECOVERY_REQUIRED');
  assert.equal(db.read('paymentRecoveryCases/' + ref).status, 'OPEN');
});


test('SECURITY: coin purchase is rejected before payment for a wallet owned by another UID', async () => {
  const db = new FakeFirestore();
  db.seed('wallets/' + PHONE, { ownerUid: 'different-shopper', coins: 25 });
  const deps = mkDeps(db, {});
  const r = await buy(deps, 'COINS-PRE0001');
  assert.equal(r.http, 409);
  assert.equal(r.json.code, 'WALLET_OWNED_BY_ANOTHER_ACCOUNT');
  assert.equal(db.read('coinPurchases/COINS-PRE0001'), undefined);
});

test('SECURITY: coin purchase is rejected before payment for an unowned legacy wallet', async () => {
  const db = new FakeFirestore();
  db.seed('wallets/' + PHONE, { coins: 31 });
  const deps = mkDeps(db, {});
  const r = await buy(deps, 'COINS-PRE0002');
  assert.equal(r.http, 409);
  assert.equal(r.json.code, 'LEGACY_WALLET_RECOVERY_REQUIRED');
  assert.equal(db.read('coinPurchases/COINS-PRE0002'), undefined);
});

test('SECURITY: new shopper with no wallet can prepare a coin purchase', async () => {
  const db = new FakeFirestore();
  const deps = mkDeps(db, {});
  const r = await buy(deps, 'COINS-PRE0003');
  assert.equal(r.http, 200);
  assert.equal(r.json.status, 'pending');
  assert.equal(db.read('coinPurchases/COINS-PRE0003').shopperUid, SHOPPER.uid);
});

test('SPIN webhook: active credit lease returns retryable response', async () => {
  const db = new FakeFirestore();
  const ref = 'COINS-LEASE0001';
  const deps = mkDeps(db, { [ref]: paid(1000) });
  await buy(deps, ref);
  db.seed('paymentEvents/' + ref, {
    status: 'PROCESSING',
    purpose: 'spinCoins',
    leaseToken: 'another-worker',
    leaseExpiresAt: deps.now() + 30000,
    attempts: 1,
  });
  const raw = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: ref } }));
  const sig = crypto.createHmac('sha512', SECRET).update(raw).digest('hex');
  const result = await spin.handleWebhook(deps, { rawBody: raw, signature: sig });
  assert.equal(result.http, 500);
  assert.equal(result.text, 'Retry later');
  assert.equal(walletCoins(db), 0);
});


// ======================= ADMIN PAYMENT RECOVERY =======================
function seedOpenRecovery(db, reference, walletOwner = SHOPPER.uid) {
  db.seed('wallets/' + PHONE, { ownerUid: walletOwner, coins: 7, totalSpend: 0 });
  db.seed('coinPurchases/' + reference, {
    phone: PHONE, shopperUid: SHOPPER.uid, requestedPackageId: 'PACKAGE_100',
    status: 'recovery_required', name: 'Ama'
  });
  db.seed('paymentEvents/' + reference, {
    status: 'RECOVERY_REQUIRED', purpose: 'spinCoins', recoveryCode: 'WALLET_OWNED_BY_ANOTHER_ACCOUNT'
  });
  db.seed('paymentRecoveryCases/' + reference, {
    status: 'OPEN', phone: PHONE, shopperUid: SHOPPER.uid,
    reason: 'WALLET_OWNED_BY_ANOTHER_ACCOUNT'
  });
}

test('RECOVERY ADMIN: verified payment and restored original wallet ownership credit exactly once with audit', async () => {
  const db = new FakeFirestore();
  const ref = 'COINS-ADMIN0001';
  seedOpenRecovery(db, ref);
  const deps = mkDeps(db, { [ref]: paid(1000) });
  const input = { reference: ref, resolutionId: 'resolution-00000001', adminUid: 'trusted-admin-1' };
  const first = await spin.resolveRecoveryCase(deps, input);
  assert.equal(first.http, 200);
  assert.equal(first.json.coinsCredited, 100);
  assert.equal(walletCoins(db), 107);
  assert.equal(db.read('coinPurchases/' + ref).status, 'confirmed');
  assert.equal(db.read('paymentEvents/' + ref).status, 'SUCCESS');
  assert.equal(db.read('paymentRecoveryCases/' + ref).status, 'RESOLVED');
  assert.equal(db.read('paymentRecoveryAudit/' + input.resolutionId).adminUid, 'trusted-admin-1');
  assert.equal(db.read('paymentRecoveryAudit/' + input.resolutionId).coinsCredited, 100);
  const replay = await spin.resolveRecoveryCase(deps, input);
  assert.equal(replay.http, 409);
  assert.equal(walletCoins(db), 107);
  assert.equal((await db.collection('paymentRecoveryAudit').get()).size, 1);
});

test('RECOVERY ADMIN: refuses credit while wallet ownership is not proven', async () => {
  const db = new FakeFirestore();
  const ref = 'COINS-ADMIN0002';
  seedOpenRecovery(db, ref, 'different-owner');
  const deps = mkDeps(db, { [ref]: paid(1000) });
  const result = await spin.resolveRecoveryCase(deps, {
    reference: ref, resolutionId: 'resolution-00000002', adminUid: 'trusted-admin-1'
  });
  assert.equal(result.http, 409);
  assert.equal(walletCoins(db), 7);
  assert.equal(db.read('paymentRecoveryCases/' + ref).status, 'OPEN');
  assert.equal((await db.collection('paymentRecoveryAudit').get()).size, 0);
});

test('RECOVERY ADMIN: refuses payment amount, status, currency or shopper mismatch', async () => {
  const cases = [
    paid(2250),
    paid(1000, { status: 'abandoned' }),
    paid(1000, { currency: 'USD' }),
    paid(1000, { customer: { email: '0240000000@voltix.com' } })
  ];
  for (let i = 0; i < cases.length; i++) {
    const db = new FakeFirestore();
    const ref = 'COINS-ADMIN1' + i;
    seedOpenRecovery(db, ref);
    const deps = mkDeps(db, { [ref]: cases[i] });
    const result = await spin.resolveRecoveryCase(deps, {
      reference: ref, resolutionId: 'resolution-0000001' + i, adminUid: 'trusted-admin-1'
    });
    assert.equal(result.http, 409);
    assert.equal(walletCoins(db), 7);
    assert.equal(db.read('paymentRecoveryCases/' + ref).status, 'OPEN');
  }
});

test('RECOVERY ADMIN: invalid or missing administrator and malformed resolution IDs are rejected', async () => {
  const db = new FakeFirestore();
  const ref = 'COINS-ADMIN0003';
  seedOpenRecovery(db, ref);
  const deps = mkDeps(db, { [ref]: paid(1000) });
  assert.equal((await spin.resolveRecoveryCase(deps, {
    reference: ref, resolutionId: 'resolution-00000003'
  })).http, 400);
  assert.equal((await spin.resolveRecoveryCase(deps, {
    reference: ref, resolutionId: 'bad id', adminUid: 'trusted-admin-1'
  })).http, 400);
  assert.equal(walletCoins(db), 7);
});

test('RECOVERY ADMIN: resolution ID cannot be reused for a different payment', async () => {
  const db = new FakeFirestore();
  const firstRef = 'COINS-ADMIN0004';
  const secondRef = 'COINS-ADMIN0005';
  seedOpenRecovery(db, firstRef);
  seedOpenRecovery(db, secondRef);
  const deps = mkDeps(db, { [firstRef]: paid(1000), [secondRef]: paid(1000) });
  const resolutionId = 'resolution-00000004';
  assert.equal((await spin.resolveRecoveryCase(deps, {
    reference: firstRef, resolutionId, adminUid: 'trusted-admin-1'
  })).http, 200);
  const second = await spin.resolveRecoveryCase(deps, {
    reference: secondRef, resolutionId, adminUid: 'trusted-admin-1'
  });
  assert.equal(second.http, 409);
  assert.equal(walletCoins(db), 107);
  assert.equal(db.read('paymentRecoveryCases/' + secondRef).status, 'OPEN');
});
