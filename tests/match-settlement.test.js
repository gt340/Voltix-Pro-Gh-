'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeFirestore } = require('./fake-firestore');
const { settleVerifiedMatch, signPayload } = require('../lib/match-settlement');

const secret = 'test-only-settlement-secret-that-is-at-least-32-bytes';
const payload = (overrides = {}) => ({
  matchId: 'match_1234',
  game: 'ludo',
  hostScore: 4,
  guestScore: 2,
  hostDrops: 12,
  guestDrops: 10,
  settlementId: 'settlement_123456789',
  ...overrides,
});
const deps = (db) => ({ db, secret, now: () => 1700000000000 });
const signed = (p) => signPayload(secret, p);

function seededDb(status = 'playing') {
  const db = new FakeFirestore();
  db.seed('matches/match_1234', {
    status, game: 'ludo', hostId: 'host', guestId: 'guest',
    hostName: 'Host', guestName: 'Guest', hostScore: 0, guestScore: 0,
  });
  db.seed('users/host', { name: 'Host', ludoWins: 1 });
  db.seed('users/guest', { name: 'Guest', ludoWins: 3 });
  db.seed('ludoLeaderboard/host', { uid: 'host', name: 'Host', wins: 1 });
  db.seed('ludoLeaderboard/guest', { uid: 'guest', name: 'Guest', wins: 3 });
  return db;
}

test('valid trusted signature settles once and credits only the verified winner', async () => {
  const db = seededDb();
  const p = payload();
  const result = await settleVerifiedMatch(deps(db), p, signed(p));
  assert.equal(result.http, 200);
  assert.equal(result.json.winnerUid, 'host');
  assert.equal(db.read('matches/match_1234').status, 'finished');
  assert.equal(db.read('matches/match_1234').resultSource, 'trusted-server');
  assert.equal(db.read('users/host').ludoWins, 2);
  assert.equal(db.read('users/guest').ludoWins, 3);
  assert.equal(db.read('ludoLeaderboard/host').wins, 2);
  assert.equal(db.read('ludoLeaderboard/guest').wins, 3);
  assert.equal(db.read('gameSettlements/match_1234').settlementId, p.settlementId);
});

test('invalid signature cannot modify match or economy records', async () => {
  const db = seededDb();
  const p = payload();
  const result = await settleVerifiedMatch(deps(db), p, 'a'.repeat(64));
  assert.equal(result.http, 401);
  assert.equal(db.read('matches/match_1234').status, 'playing');
  assert.equal(db.read('users/host').ludoWins, 1);
  assert.equal(db.read('gameSettlements/match_1234'), undefined);
});

test('a second settlement of the same match is rejected without double credit', async () => {
  const db = seededDb();
  const p = payload();
  assert.equal((await settleVerifiedMatch(deps(db), p, signed(p))).http, 200);
  const p2 = payload({ settlementId: 'settlement_987654321' });
  assert.equal((await settleVerifiedMatch(deps(db), p2, signed(p2))).http, 409);
  assert.equal(db.read('users/host').ludoWins, 2);
});

test('settlement IDs cannot be reused for a different match', async () => {
  const db = seededDb();
  const first = payload();
  assert.equal((await settleVerifiedMatch(deps(db), first, signed(first))).http, 200);
  db.seed('matches/match_5678', {
    status: 'playing', game: 'ludo', hostId: 'host', guestId: 'guest',
    hostName: 'Host', guestName: 'Guest', hostScore: 0, guestScore: 0,
  });
  const second = payload({ matchId: 'match_5678' });
  assert.equal((await settleVerifiedMatch(deps(db), second, signed(second))).http, 409);
  assert.equal(db.read('matches/match_5678').status, 'playing');
});

test('payload cannot settle a waiting, mismatched-game, or malformed match', async () => {
  const waitingDb = seededDb('waiting');
  const p = payload();
  assert.equal((await settleVerifiedMatch(deps(waitingDb), p, signed(p))).http, 409);

  const gameDb = seededDb();
  const wrongGame = payload({ game: 'kaisa' });
  assert.equal((await settleVerifiedMatch(deps(gameDb), wrongGame, signed(wrongGame))).http, 409);

  assert.equal((await settleVerifiedMatch(deps(gameDb), payload({ hostScore: -1 }), signed(payload({ hostScore: -1 }))).http, 400);
});

test('draw finishes the match but does not increment a player leaderboard', async () => {
  const db = seededDb();
  const p = payload({ hostScore: 2, guestScore: 2 });
  const result = await settleVerifiedMatch(deps(db), p, signed(p));
  assert.equal(result.http, 200);
  assert.equal(result.json.winnerUid, null);
  assert.equal(db.read('users/host').ludoWins, 1);
  assert.equal(db.read('users/guest').ludoWins, 3);
});
