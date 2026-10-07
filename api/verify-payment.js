// api/verify-payment.js
// Runs server-side on Vercel. Verifies a Paystack transaction with Paystack's
// own servers, then uses the Firebase Admin SDK (full trust, bypasses client
// security rules) to credit balls (or Sneaker Sink coins) and log a transaction.
//
// Required Vercel Environment Variables:
//   PAYSTACK_SECRET_KEY          -> sk_live_... (Paystack Dashboard -> Settings -> API Keys)
//   FIREBASE_SERVICE_ACCOUNT     -> the ENTIRE contents of your Firebase Admin SDK JSON file

const admin = require("firebase-admin");

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

const db = admin.firestore();

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  try {
    const { reference, userId, balls, amountGhc, type } = req.body;
    const isCoins = type === "sinkCoins";
    const txType = isCoins ? "sinkCoins" : (type === "continue" ? "continue" : "purchase");

    if (!reference || !userId || (!isCoins && !balls)) {
      return res.status(400).json({ success: false, error: "Missing required fields" });
    }

    // 1. Idempotency: has this reference already been processed?
    const existing = await db.collection("transactions").where("reference", "==", reference).limit(1).get();
    if (!existing.empty) {
      return res.status(200).json({ success: true, note: "Already processed" });
    }

    // 2. Verify with Paystack's servers
    const verifyRes = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
    });
    const verifyData = await verifyRes.json();

    if (!verifyData.status || verifyData.data.status !== "success") {
      await db.collection("transactions").add({
        userId, type: txType, balls: balls || 0, amountGhc: amountGhc || null,
        reference, status: "failed",
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return res.status(400).json({ success: false, error: "Payment not verified as successful" });
    }

    const amountPaidGhc = verifyData.data.amount / 100; // pesewas -> GHS
    let credit = balls;
    let field = "balls";

    if (isCoins) {
      // Sneaker Sink coins: the server decides how many coins the money buys
      // (never trust the number the browser sends).
      field = "sinkCoins";
      const meta = (verifyData.data.metadata || {});
      if (meta.userId && meta.userId !== userId) {
        return res.status(400).json({ success: false, error: "User mismatch" });
      }
      const s = await db.collection("gameSettings").doc("main").get();
      const d = s.exists ? s.data() : {};
      const pack = Number(d.sneakerCoinPack) || 50;
      const price = Number(d.sneakerCoinPriceGhc) || 10;
      const qty = Math.floor(amountPaidGhc / price + 0.001);
      if (qty < 1) {
        await db.collection("transactions").add({
          userId, type: txType, balls: 0, amountGhc: amountPaidGhc, reference,
          status: "amount-mismatch", createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        return res.status(400).json({ success: false, error: "Amount too low" });
      }
      credit = qty * pack;
    } else if (amountGhc && Math.abs(amountPaidGhc - amountGhc) > 0.01) {
      await db.collection("transactions").add({
        userId, type: txType, balls, amountGhc: amountPaidGhc, reference,
        status: "amount-mismatch", createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return res.status(400).json({ success: false, error: "Amount mismatch" });
    }

    // 3. Credit + log (batch)
    const userRef = db.collection("users").doc(userId);
    const txRef = db.collection("transactions").doc();
    const batch = db.batch();
    batch.set(userRef, { [field]: admin.firestore.FieldValue.increment(credit) }, { merge: true });
    batch.set(txRef, {
      userId, type: txType, balls: credit, amountGhc: amountPaidGhc, reference,
      status: "completed", createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    await batch.commit();

    return res.status(200).json({ success: true, ballsAdded: credit, coinsAdded: isCoins ? credit : 0 });
  } catch (err) {
    console.error("verify-payment error:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};
