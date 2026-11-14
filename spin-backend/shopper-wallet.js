'use strict';

function ownershipFailure(wallet, uid) {
  if (!wallet) return null;
  if (typeof wallet.ownerUid !== 'string' || !wallet.ownerUid) return 'LEGACY_WALLET_RECOVERY_REQUIRED';
  if (wallet.ownerUid !== uid) return 'WALLET_OWNED_BY_ANOTHER_ACCOUNT';
  return null;
}

async function getWallet(db, phone, uid) {
  const snap = await db.collection('wallets').doc(phone).get();
  if (!snap.exists) return { http: 200, json: { coins: 0, network: null, totalSpend: 0 } };
  const wallet = snap.data() || {};
  const failure = ownershipFailure(wallet, uid);
  if (failure) return { http: 409, json: { error: 'Wallet ownership recovery is required', code: failure } };
  return { http: 200, json: {
    coins: Number(wallet.coins) || 0,
    network: wallet.network || null,
    totalSpend: Number(wallet.totalSpend) || 0
  } };
}

async function claimFreeSpin(db, phone, uid, name) {
  const walletRef = db.collection('wallets').doc(phone);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(walletRef);
    const wallet = snap.exists ? (snap.data() || {}) : null;
    const failure = ownershipFailure(wallet, uid);
    if (failure) return { http: 409, json: { error: 'Wallet ownership recovery is required', code: failure } };
    if (wallet && wallet.claimedFreeSpin) {
      return { http: 200, json: { claimed: false, coins: Number(wallet.coins) || 0 } };
    }
    const coins = (Number(wallet && wallet.coins) || 0) + 20;
    const update = { ownerUid: uid, coins, claimedFreeSpin: true };
    if (typeof name === 'string') update.name = name.slice(0, 80);
    tx.set(walletRef, update, { merge: true });
    return { http: 200, json: { claimed: true, coins } };
  });
}

async function getOrCreateReferralCode(db, phone, uid, generateCode) {
  return db.runTransaction(async (tx) => {
    const walletRef = db.collection('wallets').doc(phone);
    const walletSnap = await tx.get(walletRef);
    const wallet = walletSnap.exists ? (walletSnap.data() || {}) : null;
    const failure = ownershipFailure(wallet, uid);
    if (failure) return { http: 409, json: { error: 'Wallet ownership recovery is required', code: failure } };

    const existing = wallet && wallet.spinReferralCode;
    if (existing) {
      const codeRef = db.collection('spinReferralCodes').doc(existing);
      const codeSnap = await tx.get(codeRef);
      if (!codeSnap.exists || !codeSnap.data() || !codeSnap.data().ownerUid) {
        return { http: 409, json: { error: 'Legacy referral code requires recovery', code: 'LEGACY_REFERRAL_CODE_RECOVERY_REQUIRED' } };
      }
      if (codeSnap.data().ownerUid !== uid || codeSnap.data().phone !== phone) {
        return { http: 409, json: { error: 'Referral code ownership mismatch', code: 'REFERRAL_CODE_OWNED_BY_ANOTHER_ACCOUNT' } };
      }
      return { http: 200, json: { code: existing } };
    }

    const code = generateCode(phone);
    const codeRef = db.collection('spinReferralCodes').doc(code);
    const collision = await tx.get(codeRef);
    if (collision.exists) return { http: 409, json: { error: 'Could not allocate a unique referral code', code: 'REFERRAL_CODE_COLLISION' } };
    tx.set(walletRef, { ownerUid: uid, spinReferralCode: code }, { merge: true });
    tx.set(codeRef, { phone, ownerUid: uid });
    return { http: 200, json: { code } };
  });
}

module.exports = { ownershipFailure, getWallet, claimFreeSpin, getOrCreateReferralCode };
