'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { registerAdminWebhookReconciliationRoute } = require('../admin-reconciliation-route');
const { resolveAdminUid } = require('../admin-auth');

async function startServer({ tokenUid = 'admin-1', adminExists = true } = {}) {
  const audit = [];
  const paymentCalls = [];
  const app = express();
  app.use(express.json());

  const db = {
    collection(name) {
      if (name === 'admins') {
        return { doc(uid) { return { async get() { return { exists: adminExists && uid === 'admin-1' }; } }; } };
      }
      assert.equal(name, 'paymentWebhookReconciliationRuns');
      return { doc() {
        const record = {};
        return {
          async create(value) { Object.assign(record, value); audit.push({ ...value }); },
          async update(value) { Object.assign(record, value); Object.assign(audit[audit.length - 1], value); }
        };
      } };
    }
  };

  const getAdminUid = (req) => resolveAdminUid(req, {
    verifyIdToken: async (token) => {
      if (token !== 'valid-test-token') throw new Error('invalid token');
      return { uid: tokenUid };
    },
    db
  });

  registerAdminWebhookReconciliationRoute(app, {
    getAdminUid,
    payments: { async reconcileWebhookInbox(_deps, options) {
      paymentCalls.push(options);
      return { scanned: 2, processed: 1, unmatched: 1, recoveryRequired: 0, requiresReview: 0, retryable: 0, failed: 0 };
    } },
    payDeps: {},
    db,
    now: () => 1700000000000
  });

  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    audit,
    paymentCalls,
    async close() { await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve())); },
    url: 'http://127.0.0.1:' + address.port + '/api/admin/reconcile-payment-webhooks'
  };
}

test('HTTP admin reconciliation rejects missing, invalid, and non-admin bearer tokens without processing', async (t) => {
  for (const scenario of [
    { name: 'missing token', headers: {} },
    { name: 'invalid token', headers: { authorization: 'Bearer invalid' } },
    { name: 'valid shopper not on admin allowlist', headers: { authorization: 'Bearer valid-test-token' }, tokenUid: 'shopper-1' }
  ]) {
    await t.test(scenario.name, async () => {
      const app = await startServer({ tokenUid: scenario.tokenUid || 'admin-1', adminExists: scenario.tokenUid !== 'shopper-1' });
      try {
        const response = await fetch(app.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...scenario.headers },
          body: JSON.stringify({ limit: 10 })
        });
        assert.equal(response.status, 403);
        assert.equal(app.audit.length, 0);
        assert.equal(app.paymentCalls.length, 0);
      } finally { await app.close(); }
    });
  }
});

test('HTTP admin reconciliation verifies admin, clamps batch size, and records completion audit', async () => {
  const app = await startServer();
  try {
    const response = await fetch(app.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer valid-test-token' },
      body: JSON.stringify({ limit: 999 })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: 'completed', scanned: 2, processed: 1, unmatched: 1,
      recoveryRequired: 0, requiresReview: 0, retryable: 0, failed: 0
    });
    assert.deepEqual(app.paymentCalls, [{ limit: 50 }]);
    assert.equal(app.audit.length, 1);
    assert.equal(app.audit[0].adminUid, 'admin-1');
    assert.equal(app.audit[0].status, 'COMPLETED');
    assert.equal(app.audit[0].limit, 50);
  } finally { await app.close(); }
});
