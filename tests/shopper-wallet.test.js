'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeFirestore } = require('./fake-firestore');
const wallet = require('../spin-backend/shopper-wallet');

const PHONE = '0536193862';
const UID = 'shopper-uid';
const code = () => 'VLX1234ABC';

test('WALLET OWNERSHIP: new referral code stores authenticated owner UID', async () => {
  const db = new FakeFirestore();
  const result = await wallet.getOrCreateReferralCode(db, PHONE, UID, code);
  assert.equal(result.http, 200);
  assert.equal(result.json.code, 'VLX1234ABC');
  assert.deepEqual(db.read('spinReferralCodes/VLX1234ABC'), { phone: PHONE, ownerUid: UID });
  assert.equal(db.read('wallets/' + PHONE).ownerUid, UID);
});

test('WALLET OWNERSHIP: existing referral code owned by another UID is rejected', async () => {
  const db = new FakeFirestore();
  db.seed('wallets/' + PHONE, { ownerUid: UID, spinReferralCode: 'VLX1234ABC' });
  db.seed('spinReferralCodes/VLX1234ABC', { phone: PHONE, ownerUid: 'other-uid' });
  const result = await wallet.getOrCreateReferralCode(db, PHONE, UID, code);
  assert.equal(result.http, 409);
  assert.equal(result.json.code, 'REFERRAL_CODE_OWNED_BY_ANOTHER_ACCOUNT');
});

test('WALLET OWNERSHIP: legacy referral code is not silently claimed or regenerated', async () => {
  const db = new FakeFirestore();
  db.seed('wallets/' + PHONE, { ownerUid: UID, spinReferralCode: 'OLD123ABC' });
  db.seed('spinReferralCodes/OLD123ABC', { phone: PHONE });
  const result = await wallet.getOrCreateReferralCode(db, PHONE, UID, code);
  assert.equal(result.http, 409);
  assert.equal(result.json.code, 'LEGACY_REFERRAL_CODE_RECOVERY_REQUIRED');
  assert.equal(db.read('spinReferralCodes/OLD123ABC').ownerUid, undefined);
});

test('WALLET OWNERSHIP: new starter wallet stores authenticated owner UID', async () => {
  const db = new FakeFirestore();
  const result = await wallet.claimFreeSpin(db, PHONE, UID, 'Ama');
  assert.equal(result.http, 200);
  assert.equal(result.json.claimed, true);
  assert.equal(result.json.coins, 20);
  assert.deepEqual(db.read('wallets/' + PHONE), {
    ownerUid: UID, coins: 20, claimedFreeSpin: true, name: 'Ama'
  });
});

test('WALLET OWNERSHIP: starter claim cannot modify another UID wallet', async () => {
  const db = new FakeFirestore();
  db.seed('wallets/' + PHONE, { ownerUid: 'other-uid', coins: 8 });
  const result = await wallet.claimFreeSpin(db, PHONE, UID, 'Ama');
  assert.equal(result.http, 409);
  assert.equal(result.json.code, 'WALLET_OWNED_BY_ANOTHER_ACCOUNT');
  assert.equal(db.read('wallets/' + PHONE).coins, 8);
  assert.equal(db.read('wallets/' + PHONE).claimedFreeSpin, undefined);
});

test('WALLET OWNERSHIP: starter claim cannot silently claim an unowned legacy wallet', async () => {
  const db = new FakeFirestore();
  db.seed('wallets/' + PHONE, { coins: 12 });
  const result = await wallet.claimFreeSpin(db, PHONE, UID, 'Ama');
  assert.equal(result.http, 409);
  assert.equal(result.json.code, 'LEGACY_WALLET_RECOVERY_REQUIRED');
  assert.equal(db.read('wallets/' + PHONE).coins, 12);
  assert.equal(db.read('wallets/' + PHONE).ownerUid, undefined);
});

test('WALLET OWNERSHIP: wallet lookup never discloses another UID balance', async () => {
  const db = new FakeFirestore();
  db.seed('wallets/' + PHONE, { ownerUid: 'other-uid', coins: 999, totalSpend: 200 });
  const result = await wallet.getWallet(db, PHONE, UID);
  assert.equal(result.http, 409);
  assert.equal(result.json.code, 'WALLET_OWNED_BY_ANOTHER_ACCOUNT');
  assert.equal(JSON.stringify(result.json).includes('999'), false);
});

test('WALLET OWNERSHIP: legacy wallet lookup explicitly requires recovery', async () => {
  const db = new FakeFirestore();
  db.seed('wallets/' + PHONE, { coins: 50 });
  const result = await wallet.getWallet(db, PHONE, UID);
  assert.equal(result.http, 409);
  assert.equal(result.json.code, 'LEGACY_WALLET_RECOVERY_REQUIRED');
  assert.equal(JSON.stringify(result.json).includes('50'), false);
});

test('WALLET OWNERSHIP: same UID can read wallet and starter reward remains one-time', async () => {
  const db = new FakeFirestore();
  await wallet.claimFreeSpin(db, PHONE, UID, 'Ama');
  const lookup = await wallet.getWallet(db, PHONE, UID);
  assert.equal(lookup.http, 200);
  assert.equal(lookup.json.coins, 20);
  const second = await wallet.claimFreeSpin(db, PHONE, UID, 'Ama');
  assert.equal(second.http, 200);
  assert.equal(second.json.claimed, false);
  assert.equal(db.read('wallets/' + PHONE).coins, 20);
});
