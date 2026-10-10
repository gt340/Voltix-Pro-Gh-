// POST /api/recover-payments — credits the caller's own paid-but-unconfirmed purchases (idempotent).
const { route } = require('../lib/api-runtime');
const { handleRecover } = require('../lib/payment-api');
module.exports = route(handleRecover);
