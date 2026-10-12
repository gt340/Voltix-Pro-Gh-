// spin-backend/server.js — guarded entry point.
// The payment backend only starts when the environment is approved (Production as-is, or an explicitly
// approved staging setup). Otherwise every request gets 503 and Firebase / Paystack are never touched.
const { evaluateRuntime } = require('./env-guard');

const guard = evaluateRuntime(process.env);
if (guard.ok) {
  module.exports = require('./app');
} else {
  console.error('Environment guard blocked startup: ' + guard.reasons.join(' | '));
  module.exports = (req, res) => {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Environment not approved for payments' }));
  };
  if (process.env.VERCEL !== '1') {
    require('http').createServer(module.exports).listen(process.env.PORT || 3000);
  }
}
