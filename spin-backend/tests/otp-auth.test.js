'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOtpAuthService } = require('../otp-auth');

function fakeFirestore() {
  const records = new Map();
  function doc(path) {
    return {
      path,
      async get() {
        const value = records.get(path);
        return { exists: value !== undefined, data: () => value && { ...value } };
      },
      async update(value) {
        if (!records.has(path)) throw new Error('missing document');
        records.set(path, { ...records.get(path), ...value });
      }
    };
  }
  const db = {
    collection(name) {
      return { doc: id => doc(name + '/' + id) };
    },
    async runTransaction(callback) {
      const tx = {
        async get(ref) {
          const value = records.get(ref.path);
          return { exists: value !== undefined, data: () => value && { ...value } };
        },
        set(ref, value, options) {
          const old = records.get(ref.path) || {};
          records.set(ref.path, options && options.merge ? { ...old, ...value } : { ...value });
        },
        create(ref, value) {
          if (records.has(ref.path)) throw new Error('already exists');
          records.set(ref.path, { ...value });
        },
        update(ref, value) {
          if (!records.has(ref.path)) throw new Error('missing document');
          records.set(ref.path, { ...records.get(ref.path), ...value });
        }
      };
      return callback(tx);
    },
    records
  };
  return db;
}

function makeService(overrides = {}) {
  const db = fakeFirestore();
  const calls = { generated: [], verified: [], tokens: [] };
  const users = new Map();
  const auth = {
    async getUserByPhoneNumber(phone) {
      const user = users.get(phone);
      if (!user) {
        const error = new Error('not found');
        error.code = 'auth/user-not-found';
        throw error;
      }
      return user;
    },
    async createUser(data) {
      const user = { uid: 'uid-' + data.phoneNumber, phoneNumber: data.phoneNumber, disabled: false };
      users.set(data.phoneNumber, user);
      return user;
    },
    async createCustomToken(uid, claims) {
      calls.tokens.push({ uid, claims });
      return 'custom-token-' + uid;
    }
  };
  const otpClient = {
    async generate(phone) { calls.generated.push(phone); return { code: '1000' }; },
    async verify(phone, code) {
      calls.verified.push({ phone, code });
      if (overrides.verifyError) throw overrides.verifyError;
      return { code: '1100' };
    }
  };
  let time = 200000;
  let id = 0;
  const service = createOtpAuthService({
    db, auth, otpClient, hashSecret: 'x'.repeat(48),
    now: () => time,
    dailyLimit: overrides.dailyLimit,
    randomId: () => '00000000-0000-4000-8000-' + String(++id).padStart(12, '0')
  });
  return { service, db, calls, users, advance: ms => { time += ms; } };
}

test('OTP request persists a challenge without storing the OTP and successful verification issues a Firebase custom token', async () => {
  const ctx = makeService();
  const requested = await ctx.service.requestOtp('0241234567', '203.0.113.8');
  assert.equal(requested.expiresInSeconds, 300);
  assert.deepEqual(ctx.calls.generated, ['+233241234567']);
  const challenge = ctx.db.records.get('otpChallenges/' + requested.challengeId);
  assert.equal(challenge.status, 'pending');
  assert.equal(challenge.phone, '+233241234567');
  assert.equal(Object.hasOwn(challenge, 'code'), false);
  assert.equal(Object.hasOwn(challenge, 'otp'), false);

  const verified = await ctx.service.verifyOtp(requested.challengeId, '123456');
  assert.equal(verified.phone, '+233241234567');
  assert.equal(verified.customToken, 'custom-token-uid-+233241234567');
  assert.deepEqual(ctx.calls.tokens[0].claims, { shopperPhoneVerified: true });
  assert.equal(ctx.db.records.get('otpChallenges/' + requested.challengeId).status, 'consumed');
});

test('OTP resend cooldown and hourly limits are persisted across service calls', async () => {
  const ctx = makeService();
  await ctx.service.requestOtp('0241234567', '203.0.113.8');
  await assert.rejects(
    ctx.service.requestOtp('0241234567', '203.0.113.8'),
    error => error.code === 'OTP_RESEND_COOLDOWN'
  );
});

test('global daily OTP budget blocks additional billable sends', async () => {
  const ctx = makeService({ dailyLimit: 1 });
  await ctx.service.requestOtp('0241234567', '203.0.113.8');
  ctx.advance(61000);
  await assert.rejects(
    ctx.service.requestOtp('0247654321', '203.0.113.9'),
    error => error.code === 'OTP_RATE_LIMITED'
  );
  assert.equal(ctx.calls.generated.length, 1);
});

test('incorrect provider code does not issue a Firebase token', async () => {
  const providerError = new Error('invalid');
  providerError.providerCode = '1104';
  const ctx = makeService({ verifyError: providerError });
  const requested = await ctx.service.requestOtp('0241234567', '203.0.113.8');
  await assert.rejects(
    ctx.service.verifyOtp(requested.challengeId, '123456'),
    error => error.code === 'OTP_CODE_INCORRECT'
  );
  assert.equal(ctx.calls.tokens.length, 0);
  assert.equal(ctx.db.records.get('otpChallenges/' + requested.challengeId).status, 'pending');
});

test('consumed challenge cannot be replayed', async () => {
  const ctx = makeService();
  const requested = await ctx.service.requestOtp('0241234567', '203.0.113.8');
  await ctx.service.verifyOtp(requested.challengeId, '123456');
  await assert.rejects(
    ctx.service.verifyOtp(requested.challengeId, '123456'),
    error => error.code === 'OTP_CHALLENGE_INVALID'
  );
  assert.equal(ctx.calls.tokens.length, 1);
});
