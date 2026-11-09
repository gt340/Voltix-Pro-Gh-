'use strict';

const crypto = require('node:crypto');
const { normalizeE164 } = require('./arkesel-otp');

const OTP_TTL_MS = 5 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const PHONE_HOURLY_LIMIT = 5;
const IP_HOURLY_LIMIT = 20;
const VERIFY_ATTEMPT_LIMIT = 5;
const VERIFY_LEASE_MS = 30 * 1000;

function createOtpAuthService(options = {}) {
  const db = options.db;
  const auth = options.auth;
  const otpClient = options.otpClient;
  const now = options.now || Date.now;
  const randomId = options.randomId || (() => crypto.randomUUID());
  const hashSecret = String(options.hashSecret || '');
  const dailyLimit = Number.isInteger(options.dailyLimit) && options.dailyLimit > 0 ? options.dailyLimit : 250;

  if (!db || !auth || !otpClient) throw new TypeError('Firestore, Firebase Auth and Arkesel client are required');
  if (hashSecret.length < 32) throw new TypeError('OTP rate-limit secret must be at least 32 characters');

  function digest(value) {
    return crypto.createHmac('sha256', hashSecret).update(String(value)).digest('hex');
  }

  async function requestOtp(rawPhone, ipAddress) {
    const phone = normalizeE164(rawPhone);
    const time = now();
    const challengeId = randomId();
    const challengeRef = db.collection('otpChallenges').doc(challengeId);
    const phoneLimitRef = db.collection('otpRateLimits').doc('phone_' + digest(phone));
    const ipKey = ipAddress ? digest(ipAddress) : 'unknown';
    const ipLimitRef = db.collection('otpRateLimits').doc('ip_' + ipKey);
    const dayKey = new Date(time).toISOString().slice(0, 10);
    const globalLimitRef = db.collection('otpRateLimits').doc('global_' + dayKey);

    await db.runTransaction(async tx => {
      const phoneSnap = await tx.get(phoneLimitRef);
      const ipSnap = await tx.get(ipLimitRef);
      const globalSnap = await tx.get(globalLimitRef);
      const phoneLimit = phoneSnap.exists ? phoneSnap.data() : {};
      const ipLimit = ipSnap.exists ? ipSnap.data() : {};
      const globalLimit = globalSnap.exists ? globalSnap.data() : {};
      const phoneWindow = Number(phoneLimit.windowStart) || time;
      const ipWindow = Number(ipLimit.windowStart) || time;
      const phoneCount = time - phoneWindow >= 60 * 60 * 1000 ? 0 : Number(phoneLimit.count) || 0;
      const ipCount = time - ipWindow >= 60 * 60 * 1000 ? 0 : Number(ipLimit.count) || 0;
      const globalCount = Number(globalLimit.count) || 0;
      const lastSentAt = Number(phoneLimit.lastSentAt) || 0;

      if (time - lastSentAt < RESEND_COOLDOWN_MS) {
        const error = new Error('Please wait before requesting another code');
        error.code = 'OTP_RESEND_COOLDOWN';
        throw error;
      }
      if (phoneCount >= PHONE_HOURLY_LIMIT || ipCount >= IP_HOURLY_LIMIT || globalCount >= dailyLimit) {
        const error = new Error('OTP request limit reached');
        error.code = 'OTP_RATE_LIMITED';
        throw error;
      }

      tx.set(phoneLimitRef, {
        windowStart: phoneCount ? phoneWindow : time,
        count: phoneCount + 1,
        lastSentAt: time,
        expireAt: new Date(time + 48 * 60 * 60 * 1000)
      }, { merge: true });
      tx.set(ipLimitRef, {
        windowStart: ipCount ? ipWindow : time,
        count: ipCount + 1,
        expireAt: new Date(time + 48 * 60 * 60 * 1000)
      }, { merge: true });
      tx.set(globalLimitRef, {
        count: globalCount + 1,
        expireAt: new Date(time + 48 * 60 * 60 * 1000)
      }, { merge: true });
      tx.create(challengeRef, {
        phone,
        status: 'generating',
        attempts: 0,
        createdAt: time,
        expiresAt: time + OTP_TTL_MS,
        expireAt: new Date(time + 24 * 60 * 60 * 1000)
      });
    });

    try {
      await otpClient.generate(phone);
      await challengeRef.update({ status: 'pending', sentAt: now() });
      return { challengeId, expiresInSeconds: OTP_TTL_MS / 1000 };
    } catch (error) {
      await challengeRef.update({ status: 'failed', failedAt: now() });
      throw error;
    }
  }

  async function verifyOtp(challengeId, rawCode) {
    if (typeof challengeId !== 'string' || !/^[0-9a-f-]{36}$/i.test(challengeId)) {
      const error = new Error('Invalid or expired verification session');
      error.code = 'OTP_CHALLENGE_INVALID';
      throw error;
    }
    const code = String(rawCode || '').trim();
    if (!/^\d{6}$/.test(code)) {
      const error = new Error('Enter the six-digit verification code');
      error.code = 'OTP_CODE_INVALID';
      throw error;
    }

    const challengeRef = db.collection('otpChallenges').doc(challengeId);
    const leaseId = randomId();
    const time = now();
    let phone;
    let providerAlreadyVerified = false;

    await db.runTransaction(async tx => {
      const snap = await tx.get(challengeRef);
      if (!snap.exists) {
        const error = new Error('Invalid or expired verification session');
        error.code = 'OTP_CHALLENGE_INVALID';
        throw error;
      }
      const data = snap.data() || {};
      if (data.status === 'verifying' && Number(data.leaseUntil) > time) {
        const error = new Error('Verification is already in progress');
        error.code = 'OTP_VERIFY_IN_PROGRESS';
        throw error;
      }
      providerAlreadyVerified = data.status === 'provider_verified';
      if (!providerAlreadyVerified &&
          data.status !== 'pending' &&
          !(data.status === 'verifying' && Number(data.leaseUntil) <= time)) {
        const error = new Error('Invalid or expired verification session');
        error.code = 'OTP_CHALLENGE_INVALID';
        throw error;
      }
      if (!providerAlreadyVerified && Number(data.expiresAt) <= time) {
        const error = new Error('Verification code has expired');
        error.code = 'OTP_EXPIRED';
        throw error;
      }
      if (!providerAlreadyVerified && (Number(data.attempts) || 0) >= VERIFY_ATTEMPT_LIMIT) {
        const error = new Error('Too many incorrect verification attempts');
        error.code = 'OTP_ATTEMPTS_EXCEEDED';
        throw error;
      }
      phone = data.phone;
      tx.update(challengeRef, {
        status: 'verifying',
        attempts: providerAlreadyVerified ? (Number(data.attempts) || 0) : (Number(data.attempts) || 0) + 1,
        leaseId,
        leaseUntil: time + VERIFY_LEASE_MS
      });
    });

    try {
      if (!providerAlreadyVerified) {
        await otpClient.verify(phone, code);
        await db.runTransaction(async tx => {
          const snap = await tx.get(challengeRef);
          const current = snap.exists ? snap.data() : null;
          if (!current || current.status !== 'verifying' || current.leaseId !== leaseId) {
            const error = new Error('Verification session is no longer valid');
            error.code = 'OTP_CHALLENGE_INVALID';
            throw error;
          }
          tx.update(challengeRef, { providerVerified: true });
        });
      }

      let user;
      try {
        user = await auth.getUserByPhoneNumber(phone);
      } catch (error) {
        if (!error || error.code !== 'auth/user-not-found') throw error;
        user = await auth.createUser({ phoneNumber: phone, disabled: false });
      }
      if (user.disabled || user.phoneNumber !== phone) {
        const error = new Error('This account cannot use phone sign-in');
        error.code = 'SHOPPER_ACCOUNT_UNAVAILABLE';
        throw error;
      }

      // Persist provider verification before token issuance. If Firebase token
      // creation fails, the challenge can retry token issuance without asking
      // Arkesel to verify an already-consumed OTP again.
      await db.runTransaction(async tx => {
        const snap = await tx.get(challengeRef);
        const current = snap.exists ? snap.data() : null;
        if (!current || current.status !== 'verifying' || current.leaseId !== leaseId) {
          const error = new Error('Verification session is no longer valid');
          error.code = 'OTP_CHALLENGE_INVALID';
          throw error;
        }
        tx.update(challengeRef, {
          status: 'provider_verified',
          firebaseUid: user.uid,
          leaseId: null,
          leaseUntil: null,
          providerVerifiedAt: now()
        });
      });

      const customToken = await auth.createCustomToken(user.uid, { shopperPhoneVerified: true });
      await db.runTransaction(async tx => {
        const snap = await tx.get(challengeRef);
        const current = snap.exists ? snap.data() : null;
        if (!current || current.status !== 'provider_verified' || current.firebaseUid !== user.uid) {
          const error = new Error('Verification session is no longer valid');
          error.code = 'OTP_CHALLENGE_INVALID';
          throw error;
        }
        tx.update(challengeRef, { status: 'consumed', consumedAt: now() });
      });
      return { customToken, uid: user.uid, phone };
    } catch (error) {
      await db.runTransaction(async tx => {
        const snap = await tx.get(challengeRef);
        const current = snap.exists ? snap.data() : null;
        if (!current || current.status !== 'verifying' || current.leaseId !== leaseId) return;
        tx.update(challengeRef, {
          status: current.providerVerified ? 'provider_verified' :
            (error && error.providerCode === '1105' ? 'expired' : 'pending'),
          leaseId: null,
          leaseUntil: null,
          lastVerificationFailureAt: now()
        });
      }).catch(() => {});
      if (error && error.code === 'auth/user-not-found') {
        error.code = 'SHOPPER_ACCOUNT_RESOLUTION_FAILED';
      }
      if (error && error.providerCode) {
        const expired = error.providerCode === '1105';
        const mapped = new Error(expired ? 'Verification code has expired' :
          'The verification code is incorrect or could not be verified');
        mapped.code = expired ? 'OTP_EXPIRED' :
          (error.providerCode === '1104' ? 'OTP_CODE_INCORRECT' : 'OTP_PROVIDER_FAILURE');
        throw mapped;
      }
      throw error;
    }
  }

  return Object.freeze({ requestOtp, verifyOtp });
}

module.exports = { createOtpAuthService };
