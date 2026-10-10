// POST /api/claim-prize — one claim per player per game per day; stored for admin review.
const { route } = require('../lib/api-runtime');
const { handleClaimPrize } = require('../lib/payment-api');
module.exports = route(handleClaimPrize);
