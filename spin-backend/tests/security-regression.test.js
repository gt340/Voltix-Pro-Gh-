'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
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

test('shopper wallet and spin endpoints require verified Firebase phone identity', () => {
  assert.match(server, /async function requireVerifiedShopper/);
  assert.ok(server.includes('admin.auth().verifyIdToken(match[1])'));
  assert.ok(server.includes('decoded.phone_number'));
  for (const route of [
    "app.get('/api/wallet'",
    "app.post('/api/claim-free-spin'",
    "app.get('/api/spin-referral-code'",
    "app.post('/api/spin'",
    "app.post('/api/buy-coins'",
    "app.post('/api/verify-purchase'"
  ]) {
    const start = server.indexOf(route);
    assert.notEqual(start, -1, 'route exists: ' + route);
    const block = server.slice(start, start + 650);
    assert.match(block, /requireVerifiedShopper/, 'route is guarded: ' + route);
  }
});

test('purchase creation and browser verification are bound to verified shopper UID', () => {
  const payments = fs.readFileSync(path.join(__dirname, '..', 'payments.js'), 'utf8');
  assert.ok(payments.includes('async function handleBuyCoins(deps, body, shopper)'));
  assert.ok(payments.includes('shopperUid: shopper.uid'));
  assert.ok(payments.includes('async function handleVerifyPurchase(deps, body, shopper)'));
  assert.match(payments, /This purchase does not belong to the authenticated shopper/);
});

test('Paystack webhook remains provider-signature authenticated, not browser-token authenticated', () => {
  const start = server.indexOf("app.post('/api/paystack-webhook'");
  const end = server.indexOf("app.listen(", start);
  const block = server.slice(start, end);
  assert.match(block, /handleWebhook/);
  assert.doesNotMatch(block, /requireVerifiedShopper/);
});

test('shopper phone-auth client and protected Spin calls are syntactically valid', () => {
  const root = path.join(__dirname, '..', '..');
  const appJs = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.doesNotThrow(() => new vm.Script(appJs), 'app.js must parse');
  const account = fs.readFileSync(path.join(root, 'account.html'), 'utf8');
  const spin = fs.readFileSync(path.join(root, 'spin.html'), 'utf8');
  assert.match(account, /sendShopperPhoneCode/);
  assert.match(account, /confirmShopperPhoneCode/);
  assert.match(spin, /getShopperAuthHeaders/);
  for (const [file, html] of [['account.html', account], ['spin.html', spin]]) {
    const scripts = [...html.matchAll(/<script\\b[^>]*>([\\s\\S]*?)<\\/script>/gi)]
      .map(match => match[1]).filter(code => code.trim());
    for (const [index, code] of scripts.entries()) {
      assert.doesNotThrow(() => new vm.Script(code), file + ' inline script ' + (index + 1) + ' must parse');
    }
  }
});
