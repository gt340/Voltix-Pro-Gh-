'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeFirestore } = require('./fake-firestore');
const inventory = require('../spin-backend/ecommerce/inventory');

const depsFor = db => ({ db, now: () => 1700000000000 });
const seedProduct = (db, id, stock, extra = {}) => db.seed('products/' + id, { name: id, stock, reservedStock: 0, ...extra });
const rid = n => 'reservation_' + String(n).padStart(4, '0');

test('inventory: reserves available stock without reducing physical stock', async () => {
  const db = new FakeFirestore(); seedProduct(db, 'earpods', 5);
  const r = await inventory.reserveInventory(depsFor(db), { reservationId: rid(1), items: [{ productId: 'earpods', quantity: 2 }] });
  assert.equal(r.ok, true); assert.equal(db.read('products/earpods').stock, 5);
  assert.equal(db.read('products/earpods').reservedStock, 2);
  assert.equal(db.read('inventoryReservations/' + rid(1)).status, 'RESERVED');
});

test('inventory: concurrent reservations cannot oversell final unit', async () => {
  const db = new FakeFirestore(); seedProduct(db, 'last-unit', 1);
  const [a, b] = await Promise.all([
    inventory.reserveInventory(depsFor(db), { reservationId: rid(2), items: [{ productId: 'last-unit', quantity: 1 }] }),
    inventory.reserveInventory(depsFor(db), { reservationId: rid(3), items: [{ productId: 'last-unit', quantity: 1 }] })
  ]);
  assert.equal([a, b].filter(x => x.ok).length, 1);
  assert.equal(db.read('products/last-unit').reservedStock, 1);
});

test('inventory: same idempotency key returns same reservation; changed cart conflicts', async () => {
  const db = new FakeFirestore(); seedProduct(db, 'earpods', 5);
  const deps = depsFor(db); const items = [{ productId: 'earpods', quantity: 1 }];
  const first = await inventory.reserveInventory(deps, { reservationId: rid(4), items });
  const retry = await inventory.reserveInventory(deps, { reservationId: rid(4), items });
  const conflict = await inventory.reserveInventory(deps, { reservationId: rid(4), items: [{ productId: 'earpods', quantity: 2 }] });
  assert.equal(first.ok, true); assert.equal(retry.duplicate, true); assert.equal(conflict.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(db.read('products/earpods').reservedStock, 1);
});

test('inventory: variant stock is reserved independently', async () => {
  const db = new FakeFirestore();
  seedProduct(db, 'pods', null, { variants: [{ id: 'black', stock: 2, reservedStock: 0 }, { id: 'white', stock: 1, reservedStock: 0 }] });
  const r = await inventory.reserveInventory(depsFor(db), { reservationId: rid(5), items: [{ productId: 'pods', variantId: 'white', quantity: 1 }] });
  assert.equal(r.ok, true);
  assert.equal(db.read('products/pods').variants[1].reservedStock, 1);
  assert.equal(db.read('products/pods').variants[0].reservedStock, 0);
});

test('inventory: unconfigured stock fails closed', async () => {
  const db = new FakeFirestore(); seedProduct(db, 'legacy', null);
  const r = await inventory.reserveInventory(depsFor(db), { reservationId: rid(6), items: [{ productId: 'legacy', quantity: 1 }] });
  assert.equal(r.ok, false); assert.equal(r.code, 'STOCK_NOT_CONFIGURED');
});

test('inventory: expiry releases only reserved quantity and is idempotent', async () => {
  const db = new FakeFirestore(); seedProduct(db, 'pods', 5);
  let now = 1700000000000; const deps = { db, now: () => now };
  await inventory.reserveInventory(deps, { reservationId: rid(7), items: [{ productId: 'pods', quantity: 2 }], ttlMs: 60000 });
  now += 60001;
  const release = await inventory.releaseExpiredReservation(deps, rid(7));
  const retry = await inventory.releaseExpiredReservation(deps, rid(7));
  assert.equal(release.ok, true); assert.equal(retry.duplicate, true);
  assert.equal(db.read('products/pods').stock, 5); assert.equal(db.read('products/pods').reservedStock, 0);
});

test('inventory: commit consumes stock exactly once', async () => {
  const db = new FakeFirestore(); seedProduct(db, 'pods', 4);
  const deps = depsFor(db);
  await inventory.reserveInventory(deps, { reservationId: rid(8), items: [{ productId: 'pods', quantity: 3 }] });
  const commit = await inventory.commitReservation(deps, rid(8));
  const retry = await inventory.commitReservation(deps, rid(8));
  assert.equal(commit.ok, true); assert.equal(retry.duplicate, true);
  assert.equal(db.read('products/pods').stock, 1); assert.equal(db.read('products/pods').reservedStock, 0);
});

test('inventory: cannot commit or release a reservation after its expiry window incorrectly', async () => {
  const db = new FakeFirestore(); seedProduct(db, 'pods', 4);
  let now = 1700000000000; const deps = { db, now: () => now };
  await inventory.reserveInventory(deps, { reservationId: rid(9), items: [{ productId: 'pods', quantity: 1 }], ttlMs: 60000 });
  now += 60001;
  assert.equal((await inventory.commitReservation(deps, rid(9))).code, 'RESERVATION_EXPIRED');
  assert.equal((await inventory.releaseExpiredReservation(deps, rid(9))).ok, true);
});

test('inventory: release cannot occur before expiry', async () => {
  const db = new FakeFirestore(); seedProduct(db, 'pods', 2);
  const deps = depsFor(db);
  await inventory.reserveInventory(deps, { reservationId: rid(10), items: [{ productId: 'pods', quantity: 1 }] });
  assert.equal((await inventory.releaseExpiredReservation(deps, rid(10))).code, 'RESERVATION_NOT_EXPIRED');
});

test('inventory: compensating cancellation releases a fresh hold immediately', async () => {
  const db = new FakeFirestore(); seedProduct(db, 'pods', 3);
  const deps = depsFor(db);
  await inventory.reserveInventory(deps, { reservationId: rid(11), items: [{ productId: 'pods', quantity: 2 }] });
  const cancelled = await inventory.cancelReservation(deps, rid(11));
  const retry = await inventory.cancelReservation(deps, rid(11));
  assert.equal(cancelled.ok, true);
  assert.equal(retry.duplicate, true);
  assert.equal(db.read('inventoryReservations/' + rid(11)).status, 'CANCELLED');
  assert.equal(db.read('products/pods').reservedStock, 0);
  assert.equal(db.read('products/pods').stock, 3);
});

test('inventory: malformed reserved-stock counters fail closed', async () => {
  const db = new FakeFirestore();
  seedProduct(db, 'pods', 5, { reservedStock: '2' });
  const r = await inventory.reserveInventory(depsFor(db), {
    reservationId: rid(12), items: [{ productId: 'pods', quantity: 1 }]
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'RESERVED_STOCK_NOT_CONFIGURED');
  assert.equal(db.read('products/pods').reservedStock, '2');
});

test('inventory: Firestore document paths cannot be injected through product IDs', async () => {
  const db = new FakeFirestore();
  const r = await inventory.reserveInventory(depsFor(db), {
    reservationId: rid(13), items: [{ productId: 'products/other', quantity: 1 }]
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INVALID_ITEMS');
});
