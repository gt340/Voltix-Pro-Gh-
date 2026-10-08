// api/verify-payment.js
// Runs server-side on Vercel. Verifies the Paystack transaction with Paystack's
// own servers, decides the number of balls from the amount actually paid (the
// browser's balls / amountGhc / type are accepted for compatibility but ignored),
// and credits exactly once using the Paystack reference as the idempotency key.
//
// Required Vercel Environment Variables:
//   PAYSTACK_SECRET_KEY          -> sk_live_... (Paystack Dashboard -> Settings -> API Keys)
//   FIREBASE_SERVICE_ACCOUNT     -> the ENTIRE contents of your Firebase Admin SDK JSON file

const admin = require("firebase-admin");
const { handleVerifyBallPayment } = require("../lib/ball-payments");

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

const db = admin.firestore();

async function paystackVerify(reference) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }, signal: ctrl.signal }
    );
    if (res.status === 401 || res.status >= 500) throw new Error("provider unavailable");
    const body = await res.json().catch(() => null);
    if (!body || body.status !== true || !body.data) return { found: false };
    return { found: true, data: body.data };
  } finally {
    clearTimeout(timer);
  }
}

const deps = {
  db,
  FieldValue: admin.firestore.FieldValue,
  paystackVerify,
  now: () => Date.now(),
};

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }
  try {
    const result = await handleVerifyBallPayment(deps, req.body || {});
    return res.status(result.http).json(result.json);
  } catch (err) {
    console.error("verify-payment error:", err && err.message);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};
