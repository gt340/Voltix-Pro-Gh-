// Isolated admin route handler so authorization and audit behavior can be tested
// without initializing Firebase Admin or starting the HTTP server.
async function handleAdminWebhookReconciliation({ req, res, getAdminUid, payments, payDeps, db, now = Date.now }) {
  const adminUid = await getAdminUid(req);
  if (!adminUid) return res.status(403).json({ error: 'Admin authorization required' });

  const requestedLimit = Number(req.body && req.body.limit);
  const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 50)) : 25;
  const runRef = db.collection('paymentWebhookReconciliationRuns').doc();

  // Create the audit record before touching receipts. If this fails, no payment
  // processing begins and the caller receives an explicit failure.
  try {
    await runRef.create({ adminUid, limit, status: 'RUNNING', startedAt: now() });
  } catch (_) {
    return res.status(500).json({ error: 'Could not create reconciliation audit record' });
  }

  try {
    const summary = await payments.reconcileWebhookInbox(payDeps, { limit });
    await runRef.update({ ...summary, status: 'COMPLETED', completedAt: now() });
    return res.status(200).json({ status: 'completed', ...summary });
  } catch (err) {
    // Preserve a durable RUNNING record if finalization itself fails. This is
    // preferable to claiming a completed audit when the write did not persist.
    try {
      await runRef.update({
        status: 'FAILED',
        failure: 'RECONCILIATION_OR_AUDIT_FINALIZATION_FAILED',
        failedAt: now()
      });
    } catch (_) {}
    return res.status(500).json({ error: 'Could not reconcile payment webhook inbox' });
  }
}

module.exports = { handleAdminWebhookReconciliation };
