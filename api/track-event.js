// POST /api/track-event — anonymous per-game counters for the economics dashboard.
const { route } = require('../lib/api-runtime');
const { handleTrackEvent } = require('../lib/payment-api');
module.exports = route(handleTrackEvent);
