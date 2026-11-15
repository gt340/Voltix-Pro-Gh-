'use strict';

const { handleAdminWebhookReconciliation } = require('./admin-reconciliation');

// Register the same Express route used by production with injectable dependencies
// so the complete HTTP boundary can be exercised without Firebase initialization.
function registerAdminWebhookReconciliationRoute(app, dependencies) {
  app.post('/api/admin/reconcile-payment-webhooks', async (req, res) => {
    return handleAdminWebhookReconciliation({ req, res, ...dependencies });
  });
}

module.exports = { registerAdminWebhookReconciliationRoute };
