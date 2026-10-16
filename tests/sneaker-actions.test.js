'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeFirestore } = require('./fake-firestore');
const { handleSneakerAction } = require('../lib/sneaker-actions');

const deps = (db) => ({ db, now: () => 1700000000000 });
const req = (action, requestId = 'request_123456789012') => ({ action, requestId });

test('spendDrop decrements exactly one coin and rejects insufficient balance', async () => {
  const db = new FakeFirestore();
  db.seed('users/u1', { sinkCoins: 2, sinkGems: 0, sinkPower: 1, sinkAim: 0 });
  const ok = await handleSneakerAction(deps(db), 'u1', req('spendDrop'));
  assert.equal(ok.http, 200);
  assert.equal(ok.json.sinkCoins, 1);
  const denied = await handleSneakerAction(deps(db), 'u1', req('spendDrop', 'request_223456789012'));
  assert.equal(denied.http, 200);
  assert.equal(denied.json.sinkCoins, 0);
  const empty = await handleSneakerAction(deps(db), 'u1', req('spendDrop', 'request_323456789012'));
  assert.equal(empty.http, 409);
});

test('operation ID replay does not spend twice', async () => {
  const db = new FakeFirestore();
  db.seed('users/u1', { sinkCoins: 3 });
  const body = req('spendDrop');
  const [a, b] = await Promise.all([
    handleSneakerAction(deps(db), 'u1', body),
    handleSneakerAction(deps(db), 'u1', body),
  ]);
  assert.equal(a.http, 200);
  assert.equal(b.http, 200);
  assert.equal(db.read('users/u1').sinkCoins, 2);
});

test('power and aim upgrades use server-calculated costs and enforce caps', async () => {
  const db = new FakeFirestore();
  db.seed('users/u1', { sinkCoins: 0, sinkGems: 20, sinkPower: 1, sinkAim: 0 });
  const power = await handleSneakerAction(deps(db), 'u1', req('upgradePower'));
  assert.deepEqual(
    { gems: power.json.sinkGems, power: power.json.sinkPower, cost: power.json.cost },
    { gems: 16, power: 2, cost: 4 },
  );
  const aim = await handleSneakerAction(deps(db), 'u1', req('upgradeAim', 'request_223456789012'));
  assert.deepEqual(
    { gems: aim.json.sinkGems, aim: aim.json.sinkAim, cost: aim.json.cost },
    { gems: 10, aim: 1, cost: 6 },
  );
  db.seed('users/u1', { sinkGems: 100, sinkPower: 10, sinkAim: 5 });
  assert.equal((await handleSneakerAction(deps(db), 'u1', req('upgradePower', 'request_323456789012'))).http, 409);
  assert.equal((await handleSneakerAction(deps(db), 'u1', req('upgradeAim', 'request_423456789012'))).http, 409);
});

test('client cannot select another user or send arbitrary costs or balances', async () => {
  const db = new FakeFirestore();
  db.seed('users/u1', { sinkCoins: 4, sinkGems: 20, sinkPower: 1, sinkAim: 0 });
  db.seed('users/victim', { sinkCoins: 99, sinkGems: 99, sinkPower: 1, sinkAim: 0 });
  const body = { ...req('upgradePower'), uid: 'victim', cost: 0, sinkGems: 9999, sinkPower: 10 };
  const r = await handleSneakerAction(deps(db), 'u1', body);
  assert.equal(r.http, 200);
  assert.equal(db.read('users/victim').sinkCoins, 99);
  assert.equal(db.read('users/u1').sinkGems, 16);
});

test('unsupported action and malformed operation IDs are rejected', async () => {
  const db = new FakeFirestore();
  db.seed('users/u1', { sinkCoins: 1, sinkGems: 1, sinkPower: 1, sinkAim: 0 });
  assert.equal((await handleSneakerAction(deps(db), 'u1', req('setScore'))).http, 400);
  assert.equal((await handleSneakerAction(deps(db), 'u1', { action: 'spendDrop', requestId: 'x' })).http, 400);
});
