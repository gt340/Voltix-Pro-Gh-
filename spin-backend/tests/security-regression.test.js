'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('free starter claim uses a Firestore transaction and a one-time flag', () => {
  const start = server.indexOf("app.post('/api/claim-free-spin'");
  const end = server.indexOf('// ---------- SPIN REFERRAL CODES ----------', start);
  const block = server.slice(start, end);
  assert.match(block, /db\.runTransaction/);
  assert.match(block, /data\.claimedFreeSpin/);
  assert.match(block, /claimedFreeSpin:true/);
});

test('spin balance deduction and daily cap are enforced in one transaction', () => {
  const start = server.indexOf("app.post('/api/spin'");
  const end = server.indexOf('// ---------- RELOADLY ----------', start);
  const block = server.slice(start, end);
  assert.match(block, /db\.runTransaction/);
  assert.match(block, /currentCount >= DAILY_SPIN_CAP/);
  assert.match(block, /balance < SPIN_COST/);
  assert.match(block, /dailySpinCount: currentCount \+ 1/);
  assert.match(block, /coins: balance - SPIN_COST/);
  assert.doesNotMatch(block, /Daily spin count query failed/);
});

test('winner fulfillment requires a verified Firebase admin identity', () => {
  assert.match(server, /admin\.auth\(\)\.verifyIdToken/);
  assert.match(server, /db\.collection\('admins'\)\.doc\(decoded\.uid\)/);
  const start = server.indexOf("app.post('/api/mark-winner-fulfilled'");
  const end = server.indexOf('// ---------- SPIN ----------', start);
  const block = server.slice(start, end);
  assert.match(block, /isAdminRequest\(req\)/);
});

test('spin record uses the resolved prize after earpod eligibility checks', () => {
  const start = server.indexOf("app.post('/api/spin'");
  const end = server.indexOf('// ---------- RELOADLY ----------', start);
  const block = server.slice(start, end);
  assert.ok(block.indexOf("if(prize.type === 'earpods')") < block.indexOf('tx.set(spinRef'));
  assert.match(block, /tx\.set\(spinRef, \{ phone, prizeId:prize\.id/);
});
