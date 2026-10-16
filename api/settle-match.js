'use strict';

const admin = require('firebase-admin');
const { settleVerifiedMatch } = require('../lib/match-settlement');

if (!admin.apps.length) {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }
  if (!process.env.GAME_SETTLEMENT_SECRET || !admin.apps.length) {
    return res.status(503).json({ success: false, error: 'Trusted settlement service is not configured.' });
  }
  try {
    const body = req.body || {};
    const result = await settleVerifiedMatch(
      { db: admin.firestore(), secret: process.env.GAME_SETTLEMENT_SECRET },
      body.payload,
      body.signature,
    );
    return res.status(result.http).json(result.json);
  } catch (err) {
    console.error('trusted match settlement failed:', err && err.message);
    return res.status(500).json({ success: false, error: 'Unable to settle match right now.' });
  }
};
