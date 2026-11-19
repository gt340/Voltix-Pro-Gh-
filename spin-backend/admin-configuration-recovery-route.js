'use strict';

const { handleAdminConfigurationRecovery } = require('./admin-configuration-recovery');

function registerAdminConfigurationRecoveryRoute(app, dependencies) {
  app.post('/api/admin/release-configuration-blocked-payment', async (req, res) => {
    return handleAdminConfigurationRecovery({ req, res, ...dependencies });
  });
}

module.exports = { registerAdminConfigurationRecoveryRoute };
