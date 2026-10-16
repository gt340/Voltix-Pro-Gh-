'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeFirestore } = require('./fake-firestore');
const { lookupOrderStatus, normalizePhone } = require('../lib/order-status');

function seedOrder(db, data) {
  db.seed('orders/order-1', {
    ref: 'VOLTIX-AB12CD34',
    status: 'Shipped',
    customer: { name: 'Customer Name', phone: '024 123 4567', address: 'Private address' },
    total: 250,
    items: [{ name: 'Private item' }],
    ...data,
  });
}

test('order lookup returns only status for matching reference and phone', async () => {
  const db = new FakeFirestore();
  seedOrder(db, {});
  const result = await lookupOrderStatus({ db, now: () => 1700000000000 }, {
    reference: 'VOLTIX-AB12CD34', phone: '+233 24 123 4567', ip: '127.0.0.1',
  });
  assert.equal(result.http, 200);
  assert.deepEqual(result.json, { found: true, reference: 'VOLTIX-AB12CD34', status: 'Shipped' });
  assert.equal('address' in result.json, false);
  assert.equal('items' in result.json, false);
  assert.equal('total' in result.json, false);
});

test('wrong phone and unknown reference do not reveal order details', async () => {
  const db = new FakeFirestore();
  seedOrder(db, {});
  const wrongPhone = await lookupOrderStatus({ db, now: () => 1700000000000 }, {
    reference: 'VOLTIX-AB12CD34', phone: '0240000000', ip: '127.0.0.1',
  });
  assert.equal(wrongPhone.http, 404);
  assert.equal(wrongPhone.json.found, false);
  const wrongRef = await lookupOrderStatus({ db, now: () => 1700000000000 }, {
    reference: 'VOLTIX-ZZZZZZZZ', phone: '0241234567', ip: '127.0.0.2',
  });
  assert.equal(wrongRef.http, 404);
});

test('lookup rate-limits repeated attempts for a phone number', async () => {
  const db = new FakeFirestore();
  seedOrder(db, {});
  const deps = { db, now: () => 1700000000000 };
  let last;
  for (let i = 0; i < 6; i++) {
    last = await lookupOrderStatus(deps, {
      reference: 'VOLTIX-AB12CD34', phone: '0241234567', ip: '127.0.0.' + (i + 1),
    });
  }
  assert.equal(last.http, 429);
});

test('normalizes Ghana phone formats and rejects malformed lookup inputs', async () => {
  assert.equal(normalizePhone('+233 24 123 4567'), '0241234567');
  const result = await lookupOrderStatus({ db: new FakeFirestore() }, { reference: '#1', phone: '1', ip: 'x' });
  assert.equal(result.http, 400);
});
