'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeFirestore, FieldValue } = require('./fake-firestore');
const net = require('../lib/net');
const safety = require('../lib/safety');
const spin = require('../spin-backend/payments');

const TRUST = { trustPlatformHeaders: true };
const mk = (db) => ({ db, FieldValue, now: () => 1700000000000, sleep: async () => {}, paystackSecret: 's' });
const claim = (d, phone, ipKey) => spin.handleClaimFreeSpin(d, { phone, name: 'N', ipKey, perNetworkPerDay: 5 });

test('NET: private, loopback, link-local, CGNAT, documentation, multicast and reserved addresses are never an identity', () => {
  for (const bad of ['10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.0.1', '127.0.0.1', '169.254.169.254',
    '100.64.0.1', '100.127.255.255', '0.0.0.0', '192.0.2.5', '198.51.100.7', '203.0.113.9', '198.18.0.1', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fe80::1', 'fd12:3456::1', 'fc00::1', 'ff02::1', '2001:db8::1', '::ffff:10.1.2.3', '::ffff:127.0.0.1']) {
    assert.equal(net.normalize(bad), null, bad);
  }
  for (const good of ['41.66.1.2', '8.8.8.8', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '2a01:4f8:abcd:12::1']) {
    assert.notEqual(net.normalize(good), null, good);
  }
});

test('NET: malformed values never produce an identity', () => {
  for (const bad of ['', ' ', 'garbage', '300.1.1.1', '1.2.3', '1.2.3.4.5', '01.2.3.4', '1.2.3.04', '1,2,3,4', '::g', ':::', '12345::1',
    '2a01:4f8:abcd:12:1:2:3:4:5', null, undefined, 42, {}, [], '1.2.3.4/24', 'http://1.2.3.4']) {
    assert.equal(net.normalize(bad), null, String(bad));
  }
});

test('NET: client-controlled X-Forwarded-For is never used, trusted or not', () => {
  const h = { 'x-forwarded-for': '41.66.9.9, 8.8.8.8' };
  assert.equal(net.clientIp(h, '10.0.0.5', TRUST), null);
  assert.equal(net.clientIp(h, '10.0.0.5'), null);
  assert.equal(net.clientIp(h, '41.66.1.1', TRUST), '41.66.1.1');
});

test('NET: platform headers are ignored unless the caller says it is behind the platform (default is do-not-trust)', () => {
  const h = { 'x-vercel-forwarded-for': '41.66.1.2', 'x-real-ip': '41.66.1.3' };
  assert.equal(net.clientIp(h, '41.66.1.100'), '41.66.1.100');                    // default: ignore them
  assert.equal(net.clientIp(h, '41.66.1.100', { trustPlatformHeaders: false }), '41.66.1.100');
  assert.equal(net.clientIp(h, '41.66.1.100', TRUST), '41.66.1.2');
  assert.equal(net.clientIp({ 'x-real-ip': '41.66.1.3' }, null, TRUST), '41.66.1.3');
});

test('NET: a bad or private platform header falls back to a public socket address, else null', () => {
  assert.equal(net.clientIp({ 'x-vercel-forwarded-for': '10.0.0.9' }, '41.66.1.7', TRUST), '41.66.1.7');
  assert.equal(net.clientIp({ 'x-vercel-forwarded-for': 'not-an-ip' }, '41.66.1.7', TRUST), '41.66.1.7');
  assert.equal(net.clientIp({ 'x-vercel-forwarded-for': '10.0.0.9' }, '10.0.0.1', TRUST), null);
  assert.equal(net.clientIp({}, undefined, TRUST), null);
  assert.equal(net.clientIp(undefined, undefined), null);
});

test('FREE SPIN: with NO usable network identity, users do not share a quota (no network cap is applied, no rate row is written)', async () => {
  const db = new FakeFirestore(); const d = mk(db);
  const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => claim(d, '02880000' + (10 + i), net.clientIp({}, '10.0.0.1', TRUST))));
  assert.equal(rs.filter((r) => r.json.claimed).length, 12);                       // all granted; per-phone once-only still holds
  assert.equal([...db.store.keys()].filter((k) => k.startsWith('rateLimits/')).length, 0);
  assert.equal((await claim(d, '0288000010', null)).json.claimed, false);          // same phone cannot claim twice
});

test('FREE SPIN: a spoofed forwarding header cannot move a claimer into a fresh quota', async () => {
  const db = new FakeFirestore(); const d = mk(db);
  const real = '41.66.1.50';
  for (let i = 0; i < 5; i++) await claim(d, '02990000' + (10 + i), net.clientIp({ 'x-forwarded-for': '9.9.9.' + i }, real));
  const sixth = await claim(d, '0299000099', net.clientIp({ 'x-forwarded-for': '9.9.9.99' }, real));
  assert.equal(sixth.http, 429);
});

test('FREE SPIN: quota is per network bucket, enforced atomically under concurrency', async () => {
  const db = new FakeFirestore(); const d = mk(db);
  const jobs = Array.from({ length: 30 }, (_, i) => claim(d, '03110000' + String(10 + i), i % 2 ? '41.66.1.60' : '41.66.1.61'));
  const rs = await Promise.all(jobs);
  assert.equal(rs.filter((r) => r.json.claimed).length, 10);                       // 5 per bucket x 2 buckets
});

test('HASHING: keyed, deterministic, non-reversible-looking, and never contains the input', () => {
  delete process.env.AUDIT_PEPPER;
  const a = safety.shortHash('41.66.1.2');
  assert.equal(a, safety.shortHash('41.66.1.2'));
  assert.ok(!a.includes('41') || /^[0-9a-f]{16}$/.test(a));
  assert.match(a, /^[0-9a-f]{16}$/);
  process.env.AUDIT_PEPPER = 'pepper-one-pepper-one-pepper-one-xx';
  const b = safety.shortHash('41.66.1.2');
  process.env.AUDIT_PEPPER = 'pepper-two-pepper-two-pepper-two-xx';
  const c = safety.shortHash('41.66.1.2');
  delete process.env.AUDIT_PEPPER;
  assert.notEqual(a, b); assert.notEqual(b, c); assert.notEqual(safety.shortHash('41.66.1.3'), a);
});
