'use strict';

// This integration test runs inside firebase emulators:exec and uses the
// real Firestore transaction engine through the Admin SDK, not FakeFirestore.
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const admin = require('firebase-admin');
const { creditSpinPurchase } = require('../spin-backend/payments');

const PROJECT_ID = 'demo-voltix-wallet-rules';
const suffix = String(process.pid).padStart(6, '0');
const buyerPhone = '055' + suffix + '1';
const referrerPhone = '024' + suffix + '2';
const buyerUid = 'concurrency-buyer-' + suffix;
const referrerUid = 'concurrency-referrer-' + suffix;
const referralCode = 'VLX' + suffix.toUpperCase();
const refs = ['COINSCONC' + suffix + 'A', 'COINSCONC' + suffix + 'B'];

let app;
let db;

before(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error('FIRESTORE_EMULATOR_HOST is required; run through firebase emulators:exec');
  }
  app = admin.initializeApp({ projectId: PROJECT_ID }, 'referral-concurrency-' + suffix);
  db = admin.firestore(app);
});

after(async () => {
  if (!db) return;
  const paths = [
    'wallets/' + buyerPhone,
    'wallets/' + referrerPhone,
    'spinReferralCodes/' + referralCode,
    'coinPurchases/' + refs[0],
    'coinPurchases/' + refs[1],
    'paymentEvents/' + refs[0],
    'paymentEvents/' + refs[1]
  ];
  for (const path of paths) await db.doc(path).delete().catch(() => {});
  const rewards = await db.collection('spinReferrals').where('referredPhone', '==', buyerPhone).get();
  for (const reward of rewards.docs) await reward.ref.delete();
  await app.delete();
});

test('real Firestore concurrency: two simultaneous first purchases award one referral bonus', async () => {
  await db.collection('wallets').doc(referrerPhone).set({
    ownerUid: referrerUid, coins: 10, name: 'Referrer'
  });
  await db.collection('spinReferralCodes').doc(referralCode).set({
    phone: referrerPhone, ownerUid: referrerUid
  });
  for (const reference of refs) {
    await db.collection('coinPurchases').doc(reference).set({
      phone: buyerPhone, shopperUid: buyerUid, status: 'pending',
      requestedPackageId: 'PACKAGE_100', spinRefCode: referralCode, name: 'Buyer'
    });
  }

  const deps = {
    db,
    FieldValue: admin.firestore.FieldValue,
    now: () => Date.now(),
    paystackVerify: async (reference) => ({
      found: true,
      data: {
        reference, status: 'success', currency: 'GHS', amount: 1000,
        customer: { email: buyerPhone + '@voltix.com' }
      }
    })
  };

  const results = await Promise.all(refs.map((reference) => creditSpinPurchase(deps, reference)));
  assert.ok(results.every((result) => result.http === 200), JSON.stringify(results));

  const buyer = await db.collection('wallets').doc(buyerPhone).get();
  const referrer = await db.collection('wallets').doc(referrerPhone).get();
  const rewards = await db.collection('spinReferrals')
    .where('referredPhone', '==', buyerPhone)
    .where('status', '==', 'rewarded').get();

  assert.equal(buyer.data().coins, 240, 'two 100-coin packages plus exactly one 40-coin buyer bonus');
  assert.equal(referrer.data().coins, 50, 'referrer receives exactly one 40-coin bonus');
  assert.equal(rewards.size, 1, 'exactly one rewarded referral record exists');
  assert.equal(rewards.docs[0].data().coinsAwarded, 40);
  for (const reference of refs) {
    const purchase = await db.collection('coinPurchases').doc(reference).get();
    assert.equal(purchase.data().status, 'confirmed');
  }
});
