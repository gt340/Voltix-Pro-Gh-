// POST /api/payment-quote — server decides price, credits and owner BEFORE checkout. Needs a Firebase ID token.
const { route } = require('../lib/api-runtime');
const { handleQuote } = require('../lib/payment-api');
module.exports = route(handleQuote);
