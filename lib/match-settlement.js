'use strict';

const crypto = require('crypto');

const ID_PATTERN = /^[A-Za-z0-9_-]{16,80}$/;
const MATCH_PATTERN = /^[A-Za-z0-9_-]{4,80}$/;
const GAME_CONFIG = Object.freeze({
  foosball: { counter: 'wins', leaderboard: 'leaderboard' },
  ludo: { counter: 'ludoWins', leaderboard: 'ludoLeaderboard' },
  damii: { counter: 'damiiWins', leaderboard: 'damiiLeaderboard' },
  kaisa: { counter: 'kaisaWins', leaderboard: 'kaisaLeaderboard' },
});

function error(http, message) {
  return { http, json: { success: false, error: message } };
}

function canonicalPayload(input) {
  const body = input || {};
  return JSON.stringify({
    matchId: body.matchId,
    game: body.game,
    hostScore: body.hostScore,
    guestScore: body.guestScore,
    hostDrops: body.hostDrops,
    guestDrops: body.guestDrops,
    settlementId: body.settlementId,
  });
}

function signPayload(secret, payload) {
  return crypto.createHmac('sha256', secret).update(canonicalPayload(payload)).digest('hex');
}

function validSignature(secret, payload, signature) {
  if (typeof secret !== 'string' || secret.length < 32 ||
      typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = Buffer.from(signPayload(secret, payload), 'hex');
  const supplied = Buffer.from(signature, 'hex');
  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
}

function validPayload(payload) {
  return !!payload &&
    typeof payload.matchId === 'string' && MATCH_PATTERN.test(payload.matchId) &&
    Object.prototype.hasOwnProperty.call(GAME_CONFIG, payload.game) &&
    [payload.hostScore, payload.guestScore, payload.hostDrops, payload.guestDrops]
      .every((n) => Number.isSafeInteger(n) && n >= 0 && n <= 1000) &&
    typeof payload.settlementId === 'string' && ID_PATTERN.test(payload.settlementId);
}

async function settleVerifiedMatch(deps, payload, signature) {
  const { db, secret } = deps;
  const now = deps.now || Date.now;
  if (!validPayload(payload)) return error(400, 'Invalid settlement payload.');
  if (!validSignature(secret, payload, signature)) return error(401, 'Trusted settlement signature required.');

  const config = GAME_CONFIG[payload.game];
  const matchRef = db.collection('matches').doc(payload.matchId);
  const settlementRef = db.collection('gameSettlements').doc(payload.matchId);
  const result = await db.runTransaction(async (tx) => {
    const matchSnap = await tx.get(matchRef);
    const settledSnap = await tx.get(settlementRef);
    if (!matchSnap.exists) return { failure: error(404, 'Match not found.') };
    if (settledSnap.exists) return { failure: error(409, 'Match has already been settled.') };

    const match = matchSnap.data() || {};
    if (match.status !== 'playing' || match.game !== payload.game ||
        typeof match.hostId !== 'string' || typeof match.guestId !== 'string' ||
        !match.hostId || !match.guestId || match.hostId === match.guestId) {
      return { failure: error(409, 'Match is not eligible for trusted settlement.') };
    }

    const hostRef = db.collection('users').doc(match.hostId);
    const guestRef = db.collection('users').doc(match.guestId);
    const hostBoardRef = db.collection(config.leaderboard).doc(match.hostId);
    const guestBoardRef = db.collection(config.leaderboard).doc(match.guestId);
    const [hostSnap, guestSnap, hostBoardSnap, guestBoardSnap] = await Promise.all([
      tx.get(hostRef), tx.get(guestRef), tx.get(hostBoardRef), tx.get(guestBoardRef),
    ]);
    if (!hostSnap.exists || !guestSnap.exists) {
      return { failure: error(409, 'Both player accounts must exist before settlement.') };
    }

    const host = hostSnap.data() || {};
    const guest = guestSnap.data() || {};
    const hostWins = payload.hostScore > payload.guestScore;
    const guestWins = payload.guestScore > payload.hostScore;
    const winnerUid = hostWins ? match.hostId : guestWins ? match.guestId : null;
    const winner = hostWins ? host : guest;
    const winnerRef = hostWins ? hostRef : guestRef;
    const winnerBoardRef = hostWins ? hostBoardRef : guestBoardRef;
    const winnerBoard = hostWins ? hostBoardSnap.data() || {} : guestBoardSnap.data() || {};
    const timestamp = now();

    tx.set(matchRef, {
      status: 'finished',
      hostScore: payload.hostScore,
      guestScore: payload.guestScore,
      hostDrops: payload.hostDrops,
      guestDrops: payload.guestDrops,
      winnerUid,
      settlementId: payload.settlementId,
      resultSource: 'trusted-server',
      settledAt: timestamp,
    }, { merge: true });
    tx.set(settlementRef, {
      matchId: payload.matchId,
      game: payload.game,
      hostId: match.hostId,
      guestId: match.guestId,
      hostScore: payload.hostScore,
      guestScore: payload.guestScore,
      winnerUid,
      settlementId: payload.settlementId,
      settledAt: timestamp,
    });

    if (winnerUid) {
      const counter = Number.isSafeInteger(winner[config.counter]) && winner[config.counter] >= 0
        ? winner[config.counter] : 0;
      const boardWins = Number.isSafeInteger(winnerBoard.wins) && winnerBoard.wins >= 0
        ? winnerBoard.wins : 0;
      const winnerName = typeof winner.name === 'string' && winner.name.trim()
        ? winner.name.trim()
        : (hostWins ? match.hostName : match.guestName) || 'Player';
      tx.set(winnerRef, { [config.counter]: counter + 1 }, { merge: true });
      tx.set(winnerBoardRef, {
        uid: winnerUid,
        name: winnerName,
        wins: boardWins + 1,
        updatedAt: timestamp,
      }, { merge: true });
    }
    return { result: { matchId: payload.matchId, game: payload.game, winnerUid, status: 'finished' } };
  });

  if (result.failure) return result.failure;
  return { http: 200, json: { success: true, ...result.result } };
}

module.exports = { GAME_CONFIG, canonicalPayload, signPayload, validSignature, validPayload, settleVerifiedMatch };
