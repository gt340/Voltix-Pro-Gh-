'use strict';

const admin = require('firebase-admin');
const { handleSneakerAction } = require('../lib/sneaker-actions');

if (!admin.apps.length) {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT is required');
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
}

const auth = admin.auth();
const db = admin.firestore();

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }
  const header = req.headers.authorization || '';
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return res.status(401).json({ success: false, error: 'Authentication required.' });
  try {
    const decoded = await auth.verifyIdToken(match[1]);
    const result = await handleSneakerAction({ db, now: Date.now }, decoded.uid, req.body || {});
    return res.status(result.http).json(result.json);
  } catch (err) {
    if (err && (err.code === 'auth/argument-error' || err.code === 'auth/id-token-expired' || err.code === 'auth/invalid-id-token')) {
      return res.status(401).json({ success: false, error: 'Invalid or expired session.' });
    }
    console.error('sneaker-action failed:', err && err.message);
    return res.status(500).json({ success: false, error: 'Unable to process game action.' });
  }
};
