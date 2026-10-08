'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeFirestore, FieldValue } = require('./fake-firestore');
const ball = require('../lib/ball-payments');

const deps = (db, table) => ({
  db, FieldValue, now: () => 1700000000000, sleep: async () => {},
  paystackVerify: async (ref) => (table[ref] ? { found: true, data: { reference: ref, ...table[ref] } } : { found: false }),
});
const sinkPaid = (pesewas, uid, type) => ({
  status: 'success', currency: 'GHS', amount: pesewas,
  customer: { email: uid + '@voltix-player.app' }, metadata: { userId: uid, type },
});
const user = (db, uid) => db.read('users/' + uid) || {};

test('SNEAKER: GHS10 with sinkCoins metadata -> 50 sink coins, balls untouched', async () => {
  const db = new FakeFirestore(); db.seed('users/u1', { balls: 7, sinkCoins: 3 });
  const r = await ball.handleVerifyBallPayment(deps(db, { SNK0000001: sinkPaid(1000, 'u1', 'sinkCoins') }),
    { reference: 'SNK0000001', userId: 'u1', type: 'sinkCoins', amountGhc: 10 });
  assert.equal(r.http, 200); assert.equal(user(db, 'u1').sinkCoins, 53); assert.equal(user(db, 'u1').balls, 7);
});

test('SNEAKER: altered browser values and repeats cannot inflate coins', async () => {
  const db = new FakeFirestore(); const d = deps(db, { SNK0000002: sinkPaid(1000, 'u1', 'sinkCoins') });
  const body = { reference: 'SNK0000002', userId: 'u1', balls: 99999, coins: 99999, amountGhc: 1, type: 'sinkCoins' };
  await Promise.all([1, 2, 3, 4].map(() => ball.handleVerifyBallPayment(d, body)));
  assert.equal(user(db, 'u1').sinkCoins, 50);
});

test('SNEAKER: wrong amount rejected; ordinary ball payments never become sink coins', async () => {
  const db = new FakeFirestore();
  const d = deps(db, { SNK0000003: sinkPaid(700, 'u1', 'sinkCoins'), SNK0000004: sinkPaid(1000, 'u1', undefined) });
  assert.equal((await ball.handleVerifyBallPayment(d, { reference: 'SNK0000003', userId: 'u1' })).http, 400);
  await ball.handleVerifyBallPayment(d, { reference: 'SNK0000004', userId: 'u1', type: 'sinkCoins' }); // browser says sinkCoins, Paystack record does not
  assert.equal(user(db, 'u1').sinkCoins || 0, 0); assert.equal(user(db, 'u1').balls, 10);
});
