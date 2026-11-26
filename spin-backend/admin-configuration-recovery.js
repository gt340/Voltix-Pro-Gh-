'use strict';

const { isValidReference } = require('./payments');

// Admin-only, audited release of a receipt blocked by Paystack 401/403.
// This does not credit a wallet. It only returns the signed receipt to the
// existing bounded reconciler after an operator confirms credentials were fixed.
async function handleAdminConfigurationRecovery({ req, res, getAdminUid, db, now = Date.now }) {
  const adminUid = await getAdminUid(req);
  if (!adminUid) return res.status(403).json({ error: 'Admin authorization required' });

  const body = req.body || {};
  const reference = body.reference;
  const operationId = body.operationId;
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!isValidReference(reference) ||
      typeof operationId !== 'string' || !/^[A-Za-z0-9_-]{12,80}$/.test(operationId) ||
      reason.length < 20 || reason.length > 500 ||
      body.credentialsConfirmedFixed !== true) {
    return res.status(400).json({
      error: 'Valid reference, unique operation ID, 20-500 character reason, and explicit credential-fix confirmation required'
    });
  }

  const inboxRef = db.collection('paymentWebhookInbox').doc(reference);
  const purchaseRef = db.collection('coinPurchases').doc(reference);
  const eventRef = db.collection('paymentEvents').doc(reference);
  const auditRef = db.collection('paymentWebhookConfigurationRecoveryAudit').doc(operationId);
  const timestamp = now();

  try {
    const result = await db.runTransaction(async (tx) => {
      const [inboxSnap, purchaseSnap, eventSnap, auditSnap] = await Promise.all([
        tx.get(inboxRef), tx.get(purchaseRef), tx.get(eventRef), tx.get(auditRef)
      ]);
      if (auditSnap.exists) return { http: 409, error: 'Operation ID has already been used' };
      if (!inboxSnap.exists || !purchaseSnap.exists || !eventSnap.exists) {
        return { http: 404, error: 'Blocked receipt or associated purchase records not found' };
      }

      const inbox = inboxSnap.data() || {};
      const purchase = purchaseSnap.data() || {};
      const event = eventSnap.data() || {};
      if (inbox.status !== 'CONFIGURATION_BLOCKED' ||
          inbox.signatureVerified !== true ||
          event.status !== 'FAILED' ||
          event.failureCode !== 'PAYSTACK_CONFIGURATION_ERROR' ||
          event.purpose !== 'spinCoins' ||
          purchase.status !== 'pending' ||
          typeof purchase.shopperUid !== 'string' || !purchase.shopperUid ||
          typeof purchase.phone !== 'string' || !purchase.phone) {
        return { http: 409, error: 'Receipt is not in a safely releasable configuration-blocked state' };
      }

      tx.set(inboxRef, {
        status: 'RECEIVED',
        resultCode: null,
        configurationRecoveryOperationId: operationId,
        configurationRecoveryAdminUid: adminUid,
        configurationRecoveryReason: reason,
        configurationCredentialsConfirmedFixed: true,
        configurationReleasedAt: timestamp,
        updatedAt: timestamp
      }, { merge: true });
      tx.set(auditRef, {
        operation: 'releaseConfigurationBlockedPayment',
        operationId,
        reference,
        adminUid,
        fromStatus: 'CONFIGURATION_BLOCKED',
        toStatus: 'RECEIVED',
        reason,
        credentialsConfirmedFixed: true,
        createdAt: timestamp
      });
      return { http: 200 };
    });

    if (result.http !== 200) return res.status(result.http).json({ error: result.error });
    return res.status(200).json({
      status: 'released_for_reconciliation',
      reference,
      message: 'Receipt released to the bounded admin reconciler; no wallet credit was performed by this operation'
    });
  } catch (_) {
    return res.status(503).json({ error: 'Could not safely release configuration-blocked receipt' });
  }
}

module.exports = { handleAdminConfigurationRecovery };
