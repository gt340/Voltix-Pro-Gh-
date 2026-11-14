'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds
} = require('@firebase/rules-unit-testing');
const {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc
} = require('firebase/firestore');

const PROJECT_ID = 'demo-voltix-wallet-rules';
const RULES = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');
let testEnv;

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: RULES }
  });

  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'wallets/0240000000'), {
      ownerUid: 'shopper-owner',
      coins: 120
    });
    await setDoc(doc(db, 'wallets/0240000001'), {
      coins: 75
    });
    await setDoc(doc(db, 'admins/admin-user'), {
      role: 'admin'
    });
  });
});

after(async () => {
  if (testEnv) await testEnv.cleanup();
});

test('wallet owner can read their own wallet', async () => {
  const db = testEnv.authenticatedContext('shopper-owner').firestore();
  const snapshot = await assertSucceeds(getDoc(doc(db, 'wallets/0240000000')));
  if (!snapshot.exists()) throw new Error('Expected owner wallet to exist');
  if (snapshot.data().coins !== 120) throw new Error('Unexpected wallet balance');
});

test('different authenticated UID cannot read another shopper wallet', async () => {
  const db = testEnv.authenticatedContext('different-shopper').firestore();
  await assertFails(getDoc(doc(db, 'wallets/0240000000')));
});

test('legacy wallet without ownerUid is denied to ordinary shoppers', async () => {
  const db = testEnv.authenticatedContext('legacy-claimant').firestore();
  await assertFails(getDoc(doc(db, 'wallets/0240000001')));
});

test('admin with an admins document can read shopper wallets', async () => {
  const db = testEnv.authenticatedContext('admin-user').firestore();
  const snapshot = await assertSucceeds(getDoc(doc(db, 'wallets/0240000000')));
  if (!snapshot.exists()) throw new Error('Expected admin wallet read to return a document');
});

test('unauthenticated user cannot read a wallet', async () => {
  const db = testEnv.unauthenticatedContext().firestore();
  await assertFails(getDoc(doc(db, 'wallets/0240000000')));
});

test('client writes to wallets are denied even for owner and admin', async () => {
  const ownerDb = testEnv.authenticatedContext('shopper-owner').firestore();
  const adminDb = testEnv.authenticatedContext('admin-user').firestore();

  await assertFails(updateDoc(doc(ownerDb, 'wallets/0240000000'), { coins: 999 }));
  await assertFails(setDoc(doc(ownerDb, 'wallets/0240000002'), {
    ownerUid: 'shopper-owner',
    coins: 500
  }));
  await assertFails(deleteDoc(doc(ownerDb, 'wallets/0240000000')));
  await assertFails(updateDoc(doc(adminDb, 'wallets/0240000000'), { coins: 999 }));
});
