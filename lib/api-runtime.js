'use strict';
// lib/api-runtime.js — shared production wiring for the Vercel /api routes (Firebase Admin + Paystack verify).
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}

async function paystackVerify(reference) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }, signal: ctrl.signal });
    if (res.status === 401 || res.status >= 500) throw new Error('provider unavailable');
    const body = await res.json().catch(() => null);
    if (!body || body.status !== true || !body.data) return { found: false };
    return { found: true, data: body.data };
  } finally { clearTimeout(timer); }
}

const deps = {
  db: admin.firestore(),
  FieldValue: admin.firestore.FieldValue,
  paystackVerify,
  verifyToken: (t) => admin.auth().verifyIdToken(t),
  now: () => Date.now(),
};

const bearer = (req) => {
  const h = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  return /^Bearer /i.test(h) ? h.slice(7).trim() : null;
};

// Wraps a handler: POST only, JSON body, token from the Authorization header, safe error output.
function route(handler, { method = 'POST' } = {}) {
  return async (req, res) => {
    if (req.method !== method) return res.status(405).json({ error: 'Method not allowed' });
    try {
      const body = method === 'POST' ? (req.body || {}) : {};
      const r = await handler(deps, { ...body, token: bearer(req) });
      return res.status(r.http).json(r.json);
    } catch (err) {
      console.error('api error:', err && err.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
  };
}
module.exports = { deps, route };
