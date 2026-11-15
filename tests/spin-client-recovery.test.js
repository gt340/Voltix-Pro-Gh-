'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '..', 'spin.html'), 'utf8');

function extract(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, 'start marker exists: ' + startMarker);
  assert.notEqual(end, -1, 'end marker exists: ' + endMarker);
  return source.slice(start, end);
}
function makeContext(overrides = {}) {
  const store = new Map();
  const toasts = [];
  const context = {
    localStorage: {
      getItem: key => store.has(key) ? store.get(key) : null,
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: key => store.delete(key),
    },
    showToast: message => toasts.push(String(message)),
    currentUser: { phone: '0536193862', name: 'Test Shopper', uid: 'test-shopper-1' },
    getShopperAuthHeaders: async () => ({ Authorization: 'Bearer test' }),
    BUY_COINS_URL: '/api/buy-coins',
    VERIFY_PURCHASE_URL: '/api/verify-purchase',
    document: { getElementById: () => ({ classList: { remove() {} } }) },
    loadCoinBalance() {},
    fetch: async () => { throw new Error('Unexpected fetch'); },
    ...overrides,
  };
  vm.createContext(context);
  vm.runInContext(extract(html,
    'function readPendingCoinPurchases(){',
    'async function claimFreeSpinIfEligible(){'), context);
  return { context, store, toasts };
}

test('client recovery reads legacy single-record storage and migrates when saving', () => {
  const { context, store } = makeContext();
  store.set('voltixPendingCoinPurchase', JSON.stringify({
    reference: 'COINS-OLD0001', coins: 100, priceGHC: 10
  }));
  assert.equal(context.readPendingCoinPurchases().length, 1);
  context.savePendingCoinPurchase({
    reference: 'COINS-NEW0001', coins: 250, priceGHC: 22.5
  });
  const records = JSON.parse(store.get('voltixPendingCoinPurchase'));
  assert.deepEqual(records.map(x => x.reference), ['COINS-OLD0001', 'COINS-NEW0001']);
});

test('client recovery retains multiple unresolved references and removes only the settled one', () => {
  const { context, store } = makeContext();
  context.savePendingCoinPurchase({ reference: 'COINS-ONE0001', coins: 100, priceGHC: 10 });
  context.savePendingCoinPurchase({ reference: 'COINS-TWO0002', coins: 250, priceGHC: 22.5 });
  context.removePendingCoinPurchase('COINS-ONE0001');
  assert.deepEqual(
    JSON.parse(store.get('voltixPendingCoinPurchase')).map(x => x.reference),
    ['COINS-TWO0002']
  );
});

test('client recovery rejects a 21st unresolved reference without overwriting existing records', () => {
  const { context, store } = makeContext();
  for (let i = 1; i <= 20; i++) {
    context.savePendingCoinPurchase({
      reference: 'COINS-' + String(i).padStart(7, '0'), coins: 100, priceGHC: 10
    });
  }
  assert.throws(() => context.savePendingCoinPurchase({
    reference: 'COINS-0000021', coins: 100, priceGHC: 10
  }), /Too many unresolved payment references/);
  assert.equal(JSON.parse(store.get('voltixPendingCoinPurchase')).length, 20);
});

test('client recovery clears corrupt JSON and warns the shopper', () => {
  const { context, store, toasts } = makeContext();
  store.set('voltixPendingCoinPurchase', '{broken');
  assert.equal(context.readPendingCoinPurchases().length, 0);
  assert.equal(store.has('voltixPendingCoinPurchase'), false);
  assert.match(toasts[0], /damaged pending payment record/i);
});

function loadCompletion(overrides = {}) {
  const harness = makeContext(overrides);
  vm.runInContext(extract(html,
    'async function completeCoinPurchase(reference, coins, priceGHC){',
    '/* ---------- SPIN ---------- */'), harness.context);
  return harness;
}
const response = (ok, body) => ({ ok, json: async () => body });

test('client keeps reference when Paystack verification reports NOT_SUCCESSFUL', async () => {
  const { context, store } = loadCompletion({
    fetch: async url => url === '/api/buy-coins'
      ? response(true, { status: 'pending' })
      : response(false, { code: 'NOT_SUCCESSFUL' }),
  });
  context.savePendingCoinPurchase({ reference: 'COINS-FAIL0001', coins: 100, priceGHC: 10 });
  await context.completeCoinPurchase('COINS-FAIL0001', 100, 10);
  assert.equal(context.readPendingCoinPurchases().length, 1);
  assert.ok(store.has('voltixPendingCoinPurchase'));
});

test('client removes only the matching reference after successful verification', async () => {
  const { context, store } = loadCompletion({
    fetch: async url => url === '/api/buy-coins'
      ? response(true, { status: 'pending' })
      : response(true, { coins: 100 }),
  });
  context.savePendingCoinPurchase({ reference: 'COINS-SETTLE01', coins: 100, priceGHC: 10 });
  context.savePendingCoinPurchase({ reference: 'COINS-KEEP0002', coins: 250, priceGHC: 22.5 });
  await context.completeCoinPurchase('COINS-SETTLE01', 100, 10);
  assert.deepEqual(
    JSON.parse(store.get('voltixPendingCoinPurchase')).map(x => x.reference),
    ['COINS-KEEP0002']
  );
});

test('client retains reference when verification network request throws', async () => {
  const { context } = loadCompletion({
    fetch: async url => {
      if (url === '/api/buy-coins') return response(true, { status: 'pending' });
      throw new Error('network unavailable');
    },
  });
  context.savePendingCoinPurchase({ reference: 'COINS-NETWORK1', coins: 100, priceGHC: 10 });
  await context.completeCoinPurchase('COINS-NETWORK1', 100, 10);
  assert.equal(context.readPendingCoinPurchases().length, 1);
});

test('client recovery retries every queued reference for the current session', async () => {
  const attempted = [];
  const { context } = makeContext({
    completeCoinPurchase: async reference => attempted.push(reference),
  });
  context.savePendingCoinPurchase({ reference: 'COINS-RETRY01', coins: 100, priceGHC: 10 });
  context.savePendingCoinPurchase({ reference: 'COINS-RETRY02', coins: 250, priceGHC: 22.5 });
  await context.recoverPendingPurchase();
  assert.deepEqual(attempted, ['COINS-RETRY01', 'COINS-RETRY02']);
});

test('client recovery skips pending references owned by a different shopper account', async () => {
  const attempted = [];
  const { context, toasts } = makeContext({
    currentUser: { phone: '0240000000', name: 'Other Shopper', uid: 'other-shopper' },
    completeCoinPurchase: async reference => attempted.push(reference),
  });
  context.savePendingCoinPurchase({
    reference: 'COINS-OTHER001', coins: 100, priceGHC: 10,
    shopperUid: 'original-shopper', phone: '0536193862'
  });
  await context.recoverPendingPurchase();
  assert.deepEqual(attempted, []);
  assert.match(toasts[0], /belong to another shopper account/i);
});

test('client recovery processes only references scoped to the active shopper', async () => {
  const attempted = [];
  const { context, toasts } = makeContext({
    completeCoinPurchase: async reference => attempted.push(reference),
  });
  context.savePendingCoinPurchase({
    reference: 'COINS-MINE0001', coins: 100, priceGHC: 10,
    shopperUid: 'test-shopper-1', phone: '0536193862'
  });
  context.savePendingCoinPurchase({
    reference: 'COINS-THEIRS02', coins: 250, priceGHC: 22.5,
    shopperUid: 'different-shopper', phone: '0240000000'
  });
  await context.recoverPendingPurchase();
  assert.deepEqual(attempted, ['COINS-MINE0001']);
  assert.match(toasts[0], /other account references were skipped/i);
});
