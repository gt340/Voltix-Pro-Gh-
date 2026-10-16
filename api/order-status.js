'use strict';

const admin = require('firebase-admin');
const { lookupOrderStatus } = require('../lib/order-status');

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

const db = admin.firestore();

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ found: false, error: 'Method not allowed' });
  }
  try {
    const forwarded = req.headers['x-forwarded-for'];
    const ip = (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : '') ||
      (req.socket && req.socket.remoteAddress) || 'unknown';
    const result = await lookupOrderStatus({ db, now: Date.now }, { ...(req.body || {}), ip });
    return res.status(result.http).json(result.json);
  } catch (err) {
    console.error('order-status lookup failed:', err && err.message);
    return res.status(500).json({ found: false, error: 'Unable to check order status right now.' });
  }
};
