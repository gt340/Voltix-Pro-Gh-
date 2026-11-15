'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveAdminUid } = require('../spin-backend/admin-auth');

function fixture({ decoded = { uid: 'admin-1' }, exists = true, verifyError = null, lookupError = null } = {}) {
  const calls = [];
  const verifyIdToken = async (token) => {
    calls.push(['verify', token]);
    if (verifyError) throw verifyError;
    return decoded;
  };
  const db = {
    collection(name) {
      assert.equal(name, 'admins');
      return {
        doc(uid) {
          calls.push(['lookup', uid]);
          return {
            async get() {
              if (lookupError) throw lookupError;
              return { exists };
            }
          };
        }
      };
    }
  };
  return { calls, verifyIdToken, db };
}

test('admin auth rejects missing or malformed bearer credentials before token verification', async () => {
  const f = fixture();
  assert.equal(await resolveAdminUid({ headers: {} }, f), null);
  assert.equal(await resolveAdminUid({ headers: { authorization: 'Basic abc' } }, f), null);
  assert.deepEqual(f.calls, []);
});

test('admin auth verifies bearer token then checks the server-side UID allowlist', async () => {
  const f = fixture();
  const uid = await resolveAdminUid({ headers: { authorization: 'Bearer signed-token' } }, f);
  assert.equal(uid, 'admin-1');
  assert.deepEqual(f.calls, [['verify', 'signed-token'], ['lookup', 'admin-1']]);
});

test('admin auth rejects valid Firebase identities absent from the admin allowlist', async () => {
  const f = fixture({ exists: false });
  assert.equal(await resolveAdminUid({ headers: { authorization: 'Bearer signed-token' } }, f), null);
  assert.deepEqual(f.calls, [['verify', 'signed-token'], ['lookup', 'admin-1']]);
});

test('admin auth fails closed on token verification, malformed decoded UID, or allowlist errors', async () => {
  const invalidToken = fixture({ verifyError: new Error('invalid token') });
  assert.equal(await resolveAdminUid({ headers: { authorization: 'Bearer bad-token' } }, invalidToken), null);
  const malformedUid = fixture({ decoded: { uid: '' } });
  assert.equal(await resolveAdminUid({ headers: { authorization: 'Bearer token' } }, malformedUid), null);
  const unavailableAllowlist = fixture({ lookupError: new Error('Firestore unavailable') });
  assert.equal(await resolveAdminUid({ headers: { authorization: 'Bearer token' } }, unavailableAllowlist), null);
});
