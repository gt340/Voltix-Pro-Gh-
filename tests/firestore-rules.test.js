'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rules = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');

test('private wallet and purchase records are not readable by any signed-in user', () => {
  assert.match(rules, /match \/wallets\/\{phone\} \{\s*allow read, write: if false;/);
  assert.match(rules, /match \/coinPurchases\/\{id\} \{\s*allow read: if isAdmin\(\);\s*allow write: if false;/);
  assert.match(rules, /match \/spinWinners\/\{id\} \{\s*allow read: if isAdmin\(\);/);
  assert.match(rules, /match \/spinReferrals\/\{id\} \{\s*allow read: if isAdmin\(\);/);
});

test('user documents are owner/admin-readable and client updates cannot change sinkPts', () => {
  assert.match(rules, /allow read: if isAdmin\(\) \|\| \(request\.auth != null && request\.auth\.uid == userId\);/);
  assert.match(rules, /hasAny\(\['sinkPts','sinkGems','sinkPower','sinkAim','sinkTotal','wins','ludoWins','damiiWins','kaisaWins'\]\)/);
  assert.match(rules, /request\.resource\.data\.balls >= 0/);
  assert.match(rules, /request\.resource\.data\.sinkCoins >= 0/);
});

test('administrative collections require admin authorization for writes', () => {
  for (const name of ['products', 'categories', 'settings', 'gameSettings', 'gameMusic', 'banners', 'announcements']) {
    const start = rules.indexOf('match /' + name + '/');
    assert.notEqual(start, -1, 'missing rule for ' + name);
    const block = rules.slice(start, rules.indexOf('\n    }', start) + 6);
    assert.match(block, /allow write: if isAdmin\(\);/, name + ' writes must be admin-only');
  }
});

test('match rooms require host identity and restrict updates to participants', () => {
  assert.match(rules, /request\.resource\.data\.hostId == request\.auth\.uid/);
  assert.match(rules, /request\.resource\.data\.guestId == request\.auth\.uid/);
  assert.match(rules, /hasOnly\(\['guestId','guestName','status'\]\)/);
  assert.match(rules, /match \/signal\/\{sigId\} \{\s*allow read, write: if request\.auth != null &&/);
});

test('Kaisa host finalization does not overwrite the guest score', () => {
  const kaisa = fs.readFileSync(path.join(__dirname, '..', 'kaisa.html'), 'utf8');
  const start = kaisa.indexOf('function finalizeMatchDoc()');
  assert.notEqual(start, -1, 'Kaisa finalizer must exist');
  const end = kaisa.indexOf('// ---------- Emoji reactions', start);
  assert.notEqual(end, -1, 'Kaisa finalizer section boundary must exist');
  const finalizer = kaisa.slice(start, end);
  assert.doesNotMatch(finalizer, /guestScore/);
});

test('Sneaker Sink economy, scores, leaderboard and prize claims are server-owned', () => {
  assert.match(rules, /hasAny\(\['sinkPts','sinkGems','sinkPower','sinkAim','sinkTotal','wins','ludoWins','damiiWins','kaisaWins'\]\)/);
  assert.match(rules, /request\.resource\.data\.sinkGems == 0/);
  assert.match(rules, /request\.resource\.data\.sinkPower == 1/);
  assert.match(rules, /match \/sinkLeaderboard\/\{docId\} \{[\s\S]*?allow write: if isAdmin\(\);/);
  assert.match(rules, /match \/winners\/\{winnerId\} \{[\s\S]*?allow create: if false;/);
});

test('game clients do not submit unverified prize claims directly to Firestore', () => {
  const foosball = fs.readFileSync(path.join(__dirname, '..', 'foosball.html'), 'utf8');
  assert.match(foosball, /Prize submissions are temporarily paused until the server can verify game results/);
  assert.doesNotMatch(foosball, /collection\(['"]winners['"]\)\.add\(/);
  const ludo = fs.readFileSync(path.join(__dirname, '..', 'ludo.html'), 'utf8');
  assert.match(ludo, /Prize submissions are temporarily paused until the server can verify game results/);
  assert.doesNotMatch(ludo, /collection\(['"]winners['"]\)\.add\(/);
  const damii = fs.readFileSync(path.join(__dirname, '..', 'damii.html'), 'utf8');
  assert.match(damii, /Prize submissions are temporarily paused until the server can verify game results/);
  assert.doesNotMatch(damii, /collection\(['"]winners['"]\)\.add\(/);
  const kaisa = fs.readFileSync(path.join(__dirname, '..', 'kaisa.html'), 'utf8');
  assert.match(kaisa, /Prize submissions are temporarily paused until the server can verify game results/);
  assert.doesNotMatch(kaisa, /collection\(['"]winners['"]\)\.add\(/);
});

test('wallet, transaction, and chat writes are not broadly open to authenticated users', () => {
  assert.match(rules, /match \/transactions\/\{txId\} \{\s*allow read: if isAdmin\(\) \|\|/);
  assert.match(rules, /match \/groupChat\/\{docId\} \{\s*allow read: if request\.auth != null;\s*allow create: if request\.auth != null && request\.resource\.data\.uid == request\.auth\.uid;/);
});
