'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const diagnostics = require('../../shopper-auth-diagnostics.js');

// Browser sessionStorage substitute for Node.js tests.
const testStorage = new Map();

global.sessionStorage = {
  getItem(key){
    return testStorage.has(key) ? testStorage.get(key) : null;
  },
  setItem(key, value){
    testStorage.set(key, String(value));
  },
  removeItem(key){
    testStorage.delete(key);
  }
};



test('redacts Ghana phone numbers and six-digit OTPs', () => {
  const result = diagnostics.redact(
    'Phone +233241234567, local 0241234567, OTP 123456'
  );

  assert.doesNotMatch(result, /233241234567/);
  assert.doesNotMatch(result, /0241234567/);
  assert.doesNotMatch(result, /123456/);
  assert.match(result, /PHONE REDACTED/);
  assert.match(result, /OTP REDACTED/);
});

test('redacts credential-like values', () => {
  const result = diagnostics.redact(
    'api_key=secret-value token:abc123 authorization=Bearer-secret'
  );

  assert.doesNotMatch(result, /secret-value|abc123|Bearer-secret/);
});

test('records Firebase error code and SDK version without phone or OTP', () => {
  const record = diagnostics.recordShopperAuthDiagnostic({
    code: 'auth/operation-not-allowed',
    name: 'FirebaseError',
    message: 'Request rejected for +233241234567 with code 123456'
  });

  assert.equal(record.code, 'auth/operation-not-allowed');
  assert.equal(record.firebaseSdk, '10.12.2');
  assert.doesNotMatch(record.message, /233241234567|123456/);
});

test('diagnostic records are bounded to five entries', () => {
  for(let i = 0; i < 8; i++){
    diagnostics.recordShopperAuthDiagnostic({
      code: 'auth/test-' + i,
      message: 'test'
    });
  }

  assert.equal(diagnostics.readRecords().length, 5);
});

test('account page loads diagnostics and records phone-auth failures', () => {
  const account = fs.readFileSync(
    path.join(__dirname, '../../account.html'),
    'utf8'
  );

  assert.match(account, /shopper-auth-diagnostics\.js/);
  assert.match(account, /recordShopperAuthDiagnostic\(err\)/);
  assert.match(account, /auth\/operation-not-allowed/);
  assert.doesNotMatch(
    account,
    /Phone sign-in is disabled in Firebase Authentication/
  );
});
