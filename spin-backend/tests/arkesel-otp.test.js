'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ArkeselOtpError,
  createArkeselOtpClient,
  normalizeE164
} = require('../arkesel-otp');

function makeClient(response, capture = {}) {
  const http = {
    async post(url, body, config) {
      capture.url = url;
      capture.body = body;
      capture.config = config;
      if (response instanceof Error) throw response;
      return response;
    }
  };
  return createArkeselOtpClient({
    http,
    apiKey: 'test-key',
    senderId: 'VOLTIX',
    baseUrl: 'https://sms.arkesel.com/api/otp',
    expiryMinutes: 5
  });
}

test('normalizes Ghana local and international phone numbers to E.164', () => {
  assert.equal(normalizeE164('024 123 4567'), '+233241234567');
  assert.equal(normalizeE164('+233241234567'), '+233241234567');
  assert.throws(() => normalizeE164('12345'), /Ghana E.164/);
});

test('generation uses Arkesel OTP generate contract and never exposes the API key in body', async () => {
  const capture = {};
  const client = makeClient({
    status: 200,
    data: { code: '1000', message: 'Successful, OTP is being processed for delivery' }
  }, capture);

  const result = await client.generate('0241234567');
  assert.equal(result.code, '1000');
  assert.equal(capture.url, 'https://sms.arkesel.com/api/otp/generate');
  assert.equal(capture.body.number, '+233241234567');
  assert.equal(capture.body.sender_id, 'VOLTIX');
  assert.equal(capture.body.expiry, 5);
  assert.equal(capture.body.medium, 'sms');
  assert.match(capture.body.message, /%otp_code%/);
  assert.equal(capture.config.headers['api-key'], 'test-key');
  assert.equal(JSON.stringify(capture.body).includes('test-key'), false);
});

test('verification uses same canonical number and requires six digits', async () => {
  const capture = {};
  const client = makeClient({ status: 200, data: { code: '1100', message: 'Successful' } }, capture);
  const result = await client.verify('+233241234567', '123456');
  assert.equal(result.code, '1100');
  assert.equal(capture.url, 'https://sms.arkesel.com/api/otp/verify');
  assert.deepEqual(capture.body, { number: '+233241234567', code: '123456' });
  await assert.rejects(() => client.verify('0241234567', '1234'), /six digits/);
});

test('provider-level rejection is not treated as successful HTTP response', async () => {
  const client = makeClient({ status: 200, data: { code: '1007', message: 'Insufficient balance' } });
  await assert.rejects(client.generate('0241234567'), error => {
    assert.ok(error instanceof ArkeselOtpError);
    assert.equal(error.providerCode, '1007');
    assert.equal(error.retryable, false);
    return true;
  });
});

test('network failure is converted to a safe retryable provider error', async () => {
  const client = makeClient(new Error('sensitive request details'));
  await assert.rejects(client.generate('0241234567'), error => {
    assert.ok(error instanceof ArkeselOtpError);
    assert.equal(error.retryable, true);
    assert.doesNotMatch(error.message, /sensitive/);
    return true;
  });
});

test('rejects missing configuration and invalid expiry', () => {
  assert.throws(() => createArkeselOtpClient({ http: { post() {} }, senderId: 'V' }), /API key/);
  assert.throws(() => createArkeselOtpClient({
    http: { post() {} }, apiKey: 'x', senderId: 'V', expiryMinutes: 11
  }), /between 1 and 10/);
});
