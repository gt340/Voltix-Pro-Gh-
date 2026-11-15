const test = require('node:test');
const assert = require('node:assert/strict');
const { handleAdminWebhookReconciliation } = require('../spin-backend/admin-reconciliation');

function response() {
  return {
    code: null,
    body: null,
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function fixture({ adminUid = 'admin-1', createError = null, updateError = null, reconcileError = null } = {}) {
  const calls = [];
  const record = {};
  const runRef = {
    async create(data) { calls.push(['create', data]); if (createError) throw createError; Object.assign(record, data); },
    async update(data) { calls.push(['update', data]); if (updateError) throw updateError; Object.assign(record, data); },
  };
  const db = { collection(name) { assert.equal(name, 'paymentWebhookReconciliationRuns'); return { doc() { return runRef; } }; } };
  const payments = { async reconcileWebhookInbox(_deps, options) {
    calls.push(['reconcile', options]);
    if (reconcileError) throw reconcileError;
    return { scanned: 3, processed: 1, unmatched: 2, recoveryRequired: 0, requiresReview: 0, retryable: 0, failed: 0 };
  } };
  const getAdminUid = async () => adminUid;
  return { calls, record, db, payments, getAdminUid };
}

test('admin webhook reconciliation rejects non-admin before audit or processing', async () => {
  const f = fixture({ adminUid: null }); const res = response();
  await handleAdminWebhookReconciliation({ req: { body: { limit: 4 } }, res, ...f, payDeps: {}, now: () => 100 });
  assert.equal(res.code, 403);
  assert.equal(f.calls.length, 0);
});

test('admin webhook reconciliation writes RUNNING audit before bounded processing', async () => {
  const f = fixture(); const res = response();
  await handleAdminWebhookReconciliation({ req: { body: { limit: 999 } }, res, ...f, payDeps: {}, now: () => 100 });
  assert.equal(res.code, 200);
  assert.deepEqual(f.calls.map((call) => call[0]), ['create', 'reconcile', 'update']);
  assert.equal(f.calls[0][1].status, 'RUNNING');
  assert.equal(f.calls[0][1].limit, 50);
  assert.deepEqual(f.calls[1][1], { limit: 50 });
  assert.equal(f.record.status, 'COMPLETED');
  assert.equal(f.record.processed, 1);
});

test('admin webhook reconciliation does not process receipts when initial audit creation fails', async () => {
  const f = fixture({ createError: new Error('audit unavailable') }); const res = response();
  await handleAdminWebhookReconciliation({ req: { body: {} }, res, ...f, payDeps: {}, now: () => 100 });
  assert.equal(res.code, 500);
  assert.deepEqual(f.calls.map((call) => call[0]), ['create']);
});

test('admin webhook reconciliation marks failed runs when reconciliation throws', async () => {
  const f = fixture({ reconcileError: new Error('reconcile failed') }); const res = response();
  await handleAdminWebhookReconciliation({ req: { body: { limit: 2 } }, res, ...f, payDeps: {}, now: () => 100 });
  assert.equal(res.code, 500);
  assert.equal(f.record.status, 'FAILED');
  assert.equal(f.record.failure, 'RECONCILIATION_FAILED');
});

test('admin webhook reconciliation does not claim success when final audit update fails', async () => {
  const f = fixture({ updateError: new Error('audit finalization unavailable') }); const res = response();
  await handleAdminWebhookReconciliation({ req: { body: {} }, res, ...f, payDeps: {}, now: () => 100 });
  assert.equal(res.code, 500);
  assert.equal(f.calls.some((call) => call[0] === 'reconcile'), true);
  assert.equal(f.record.status, 'RUNNING');
});
