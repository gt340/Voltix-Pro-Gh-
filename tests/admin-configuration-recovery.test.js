const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeFirestore } = require('./fake-firestore');
const { handleAdminConfigurationRecovery } = require('../spin-backend/admin-configuration-recovery');

function response() {
  return {
    code: null,
    body: null,
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

const reference = 'COINS-CONFIG001';
const operationId = 'config-release-0001';
const request = (extra = {}) => ({
  headers: {},
  body: {
    reference,
    operationId,
    reason: 'Paystack credentials were corrected and independently checked by the operator.',
    credentialsConfirmedFixed: true,
    ...extra,
  },
});

function fixture({ adminUid = 'admin-1', status = 'CONFIGURATION_BLOCKED', signatureVerified = true,
  failureCode = 'PAYSTACK_CONFIGURATION_ERROR', purchaseStatus = 'pending' } = {}) {
  const db = new FakeFirestore();
  db.seed('paymentWebhookInbox/' + reference, { reference, status, signatureVerified, updatedAt: 100 });
  db.seed('coinPurchases/' + reference, {
    status: purchaseStatus, shopperUid: 'shopper-1', phone: '0536193862', requestedPackageId: 'PACKAGE_100'
  });
  db.seed('paymentEvents/' + reference, {
    status: 'FAILED', failureCode, purpose: 'spinCoins', leaseExpiresAt: 0
  });
  return { db, getAdminUid: async () => adminUid };
}

test('admin configuration recovery rejects non-admin before touching records', async () => {
  const f = fixture({ adminUid: null });
  const res = response();
  await handleAdminConfigurationRecovery({ req: request(), res, ...f, now: () => 200 });
  assert.equal(res.code, 403);
  assert.equal(f.db.read('paymentWebhookInbox/' + reference).status, 'CONFIGURATION_BLOCKED');
  assert.equal(f.db.read('paymentWebhookConfigurationRecoveryAudit/' + operationId), undefined);
});

test('admin configuration recovery requires explicit credential confirmation and a reason', async () => {
  const f = fixture();
  const res = response();
  await handleAdminConfigurationRecovery({
    req: request({ credentialsConfirmedFixed: false, reason: 'fixed' }), res, ...f, now: () => 200
  });
  assert.equal(res.code, 400);
  assert.equal(f.db.read('paymentWebhookInbox/' + reference).status, 'CONFIGURATION_BLOCKED');
});

test('admin configuration recovery releases only the blocked receipt and writes an audit record', async () => {
  const f = fixture();
  const res = response();
  await handleAdminConfigurationRecovery({ req: request(), res, ...f, now: () => 200 });
  assert.equal(res.code, 200);
  assert.equal(res.body.status, 'released_for_reconciliation');
  const inbox = f.db.read('paymentWebhookInbox/' + reference);
  assert.equal(inbox.status, 'RECEIVED');
  assert.equal(inbox.configurationRecoveryOperationId, operationId);
  assert.equal(inbox.configurationRecoveryAdminUid, 'admin-1');
  assert.equal(inbox.configurationCredentialsConfirmedFixed, true);
  const audit = f.db.read('paymentWebhookConfigurationRecoveryAudit/' + operationId);
  assert.equal(audit.reference, reference);
  assert.equal(audit.adminUid, 'admin-1');
  assert.equal(audit.fromStatus, 'CONFIGURATION_BLOCKED');
  assert.equal(audit.toStatus, 'RECEIVED');
  // Releasing is not payment verification and never credits the wallet.
  assert.equal(f.db.read('wallets/0536193862'), undefined);
  assert.equal(f.db.read('paymentEvents/' + reference).status, 'FAILED');
});

test('admin configuration recovery rejects unverified or altered terminal states', async () => {
  for (const options of [
    { signatureVerified: false },
    { status: 'PROCESSED' },
    { failureCode: 'VERIFY_UNAVAILABLE' },
    { purchaseStatus: 'confirmed' },
  ]) {
    const f = fixture(options);
    const res = response();
    await handleAdminConfigurationRecovery({ req: request(), res, ...f, now: () => 200 });
    assert.equal(res.code, 409);
    assert.equal(f.db.read('paymentWebhookInbox/' + reference).status, options.status || 'CONFIGURATION_BLOCKED');
    assert.equal(f.db.read('paymentWebhookConfigurationRecoveryAudit/' + operationId), undefined);
  }
});

test('admin configuration recovery operation IDs are single-use and concurrent release is fail-closed', async () => {
  const f = fixture();
  const first = response();
  await handleAdminConfigurationRecovery({ req: request(), res: first, ...f, now: () => 200 });
  assert.equal(first.code, 200);
  const second = response();
  await handleAdminConfigurationRecovery({ req: request(), res: second, ...f, now: () => 300 });
  assert.equal(second.code, 409);
  assert.equal(f.db.read('paymentWebhookConfigurationRecoveryAudit/' + operationId).createdAt, 200);
});
