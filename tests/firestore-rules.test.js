'use strict';

const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc, updateDoc, collection, addDoc } = require('firebase/firestore');

const PROJECT_ID = 'demo-voltix-pro-gh-staging';
let testEnv;

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { host: '127.0.0.1', port: 8080 },
  });
});

after(async () => {
  if (testEnv) await testEnv.cleanup();
});

test('public product catalogue remains readable without authentication', async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'products/public-item'), { name: 'Test item' });
  });
  const db = testEnv.unauthenticatedContext().firestore();
  await assertSucceeds(getDoc(doc(db, 'products/public-item')));
});

test('unauthenticated clients cannot create or modify products', async () => {
  const db = testEnv.unauthenticatedContext().firestore();
  await assertFails(setDoc(doc(db, 'products/unauth-write'), { name: 'Injected' }));
});

test('authenticated non-admin users cannot modify store configuration', async () => {
  const db = testEnv.authenticatedContext('player-a').firestore();
  await assertFails(setDoc(doc(db, 'settings/store'), { maintenance: true }));
  await assertFails(setDoc(doc(db, 'categories/injected'), { name: 'Injected' }));
});

test('players cannot read another player private user document', async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'users/player-b'), {
      balls: 5, sinkCoins: 10, phone: '0500000000', name: 'Player B',
    });
  });
  const db = testEnv.authenticatedContext('player-a').firestore();
  await assertFails(getDoc(doc(db, 'users/player-b')));
});

test('players cannot change their own authoritative game balances', async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'users/player-a'), { balls: 5, sinkCoins: 10 });
  });
  const db = testEnv.authenticatedContext('player-a').firestore();
  await assertFails(updateDoc(doc(db, 'users/player-a'), { balls: 4 }));
  await assertFails(updateDoc(doc(db, 'users/player-a'), { sinkCoins: 9 }));
});

test('clients cannot create orders directly', async () => {
  const db = testEnv.unauthenticatedContext().firestore();
  await assertFails(setDoc(doc(db, 'orders/fake-order'), {
    status: 'paid', total: 1, currency: 'GHS',
  }));
});

test('clients cannot create or manipulate referral sales', async () => {
  const db = testEnv.authenticatedContext('player-a').firestore();
  await assertFails(setDoc(doc(db, 'referralSales/fake-sale'), {
    referrerUid: 'player-a', amount: 100, status: 'approved',
  }));
});

test('players cannot write leaderboard scores directly', async () => {
  const db = testEnv.authenticatedContext('player-a').firestore();
  await assertFails(setDoc(doc(db, 'leaderboard/player-a'), {
    uid: 'player-a', wins: 999999,
  }));
});

test('a player cannot alter another player match', async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'matches/ROOM123'), {
      hostId: 'player-b', guestId: 'player-c', status: 'playing',
    });
  });
  const db = testEnv.authenticatedContext('player-a').firestore();
  await assertFails(updateDoc(doc(db, 'matches/ROOM123'), { status: 'finished' }));
});

test('non-participants cannot write match signaling data', async () => {
  const db = testEnv.authenticatedContext('player-a').firestore();
  await assertFails(addDoc(collection(db, 'matches/ROOM123/signal'), {
    from: 'player-a', type: 'offer', sdp: { type: 'offer', sdp: 'fake' },
  }));
});
