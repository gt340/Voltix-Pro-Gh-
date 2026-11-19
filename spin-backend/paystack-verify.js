'use strict';

// Only a structurally valid successful verification response may supply
// transaction data. Provider and malformed-response errors are never absence.
function createPaystackVerify({ axios, secret }) {
  if (!axios || typeof axios.get !== 'function') throw new TypeError('An Axios-compatible client is required');
  return async function paystackVerify(reference) {
    const response = await axios.get(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${secret}` }, timeout: 15000, validateStatus: () => true }
    );
    const status = Number(response && response.status);
    if (status !== 200) {
      const error = new Error('Paystack verification returned HTTP ' + status);
      error.code = 'PAYSTACK_PROVIDER_HTTP_ERROR';
      error.status = status;
      throw error;
    }
    const body = response && response.data;
    // Paystack's documented "status:false" response envelope can represent
    // an unknown reference. Require its message field; an incomplete envelope
    // is malformed and must not be treated as absence.
    if (body && body.status === false && typeof body.message === 'string' && body.message.trim()) {
      return { found: false };
    }
    if (!body || body.status !== true || !body.data || typeof body.data !== 'object' ||
        Array.isArray(body.data) || typeof body.data.reference !== 'string' || !body.data.reference) {
      const error = new Error('Paystack verification response is malformed');
      error.code = 'PAYSTACK_MALFORMED_RESPONSE';
      throw error;
    }
    return { found: true, data: body.data };
  };
}
module.exports = { createPaystackVerify };
