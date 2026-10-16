'use strict';

const REQUEST_ID = /^[A-Za-z0-9_-]{16,80}$/;
const MAX_POWER = 10;
const MAX_AIM = 5;

function error(http, message) { return { http, json: { success: false, error: message } }; }

async function handleSneakerAction(deps, uid, input) {
  const { db } = deps;
  const body = input || {};
  const action = body.action;
  const requestId = body.requestId;
  if (typeof uid !== 'string' || !uid || uid.length > 128) return error(401, 'Authentication required.');
  if (!['spendDrop', 'upgradePower', 'upgradeAim'].includes(action)) return error(400, 'Unsupported action.');
  if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) return error(400, 'Invalid request ID.');

  const userRef = db.collection('users').doc(uid);
  const opRef = db.collection('sneakerOperations').doc(uid + '_' + requestId);
  const result = await db.runTransaction(async (tx) => {
    const opSnap = await tx.get(opRef);
    if (opSnap.exists) {
      const prior = opSnap.data();
      if (prior.action !== action) return { failure: error(409, 'Request ID already used for another action.') };
      return { replay: true, result: prior.result };
    }
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) return { failure: error(404, 'Player account not found.') };
    const user = userSnap.data() || {};
    const coins = Number.isSafeInteger(user.sinkCoins) && user.sinkCoins >= 0 ? user.sinkCoins : 0;
    const gems = Number.isSafeInteger(user.sinkGems) && user.sinkGems >= 0 ? user.sinkGems : 0;
    const power = Number.isSafeInteger(user.sinkPower) && user.sinkPower >= 1 ? user.sinkPower : 1;
    const aim = Number.isSafeInteger(user.sinkAim) && user.sinkAim >= 0 ? user.sinkAim : 0;
    let patch;
    let response;
    if (action === 'spendDrop') {
      if (coins < 1) return { failure: error(409, 'Not enough coins.') };
      patch = { sinkCoins: coins - 1 };
      response = { success: true, action, sinkCoins: coins - 1 };
    } else if (action === 'upgradePower') {
      if (power >= MAX_POWER) return { failure: error(409, 'Power is already at maximum.') };
      const cost = 4 + (power - 1) * 3;
      if (gems < cost) return { failure: error(409, 'Not enough gems.') };
      patch = { sinkGems: gems - cost, sinkPower: power + 1 };
      response = { success: true, action, sinkGems: gems - cost, sinkPower: power + 1, cost };
    } else {
      if (aim >= MAX_AIM) return { failure: error(409, 'Aim is already at maximum.') };
      const cost = 6 + aim * 4;
      if (gems < cost) return { failure: error(409, 'Not enough gems.') };
      patch = { sinkGems: gems - cost, sinkAim: aim + 1 };
      response = { success: true, action, sinkGems: gems - cost, sinkAim: aim + 1, cost };
    }
    tx.update(userRef, patch);
    tx.create ? tx.create(opRef, { uid, action, requestId, result: response, createdAt: deps.now ? deps.now() : Date.now() }) :
      tx.set(opRef, { uid, action, requestId, result: response, createdAt: deps.now ? deps.now() : Date.now() });
    return { result: response };
  });
  if (result.failure) return result.failure;
  return { http: 200, json: result.result };
}

module.exports = { handleSneakerAction, REQUEST_ID, MAX_POWER, MAX_AIM };
