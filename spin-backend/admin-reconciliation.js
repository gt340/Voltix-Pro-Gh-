// Isolated admin route handler so authorization and audit behavior can be tested
// without initializing Firebase Admin or starting the HTTP server.
async function handleAdminWebhookReconciliation({ req, res, getAdminUid, payments, payDeps, db, now = Date.now }) {
  const adminUid = await getAdminUid(req);
  if (!adminUid) return res.status(403).json({ error: 'Admin authorization required' });

  const requestedLimit = Number(req.body && req.body.limit);
  const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 10)) : 5;
  const runRef = db.collection('paymentWebhookReconciliationRuns').doc();

  // Create the audit record before touching receipts. If this fails, no payment
  // processing begins and the caller receives an explicit failure.
  try {
    await runRef.create({ adminUid, limit, status: 'RUNNING', startedAt: now() });
  } catch (_) {
    return res.status(500).json({ error: 'Could not create reconciliation audit record' });
  }

  let summary;
  try {
    summary = await payments.reconcileWebhookInbox(payDeps, { limit });
  } catch (_) {
    // Only a reconciliation failure is marked FAILED. If the work succeeded but
    // the completion write fails, keep RUNNING: the outcome is not fully audited.
    try {
      await runRef.update({
        status: 'FAILED',
        failure: 'RECONCILIATION_FAILED',
        failedAt: now()
      });
    } catch (_) {}
    return res.status(500).json({ error: 'Could not reconcile payment webhook inbox' });
  }

  try {
    await runRef.update({ ...summary, status: 'COMPLETED', completedAt: now() });
  } catch (_) {
    // Receipts may already have been processed. Do not mislabel that run FAILED;
    // RUNNING explicitly signals that audit finalization needs operator review.
    return res.status(500).json({ error: 'Reconciliation completed but audit finalization failed' });
  }

  return res.status(200).json({ status: 'completed', ...summary });
}

module.exports = { handleAdminWebhookReconciliation };
