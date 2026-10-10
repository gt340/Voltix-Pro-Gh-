// GET /api/catalog — public, authoritative package catalogue (+ admin-setting divergence report).
const { route } = require('../lib/api-runtime');
const { handleCatalog } = require('../lib/payment-api');
module.exports = route((deps) => handleCatalog(deps), { method: 'GET' });
