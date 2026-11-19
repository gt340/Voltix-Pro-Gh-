'use strict';

// Paystack transaction verification adapter. Provider availability and API
// failures must remain retryable; only a valid provider response can classify
// a transaction as absent or unsuccessful.
function createPaystackVerify({ axios, secret }) {
  if (!axios || typeof axios.get !== 'function') {
    throw new TypeError('An Axios-compatible client is required');
  }

  return async function paystackVerify(reference) {
    const response = await axios.get(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      {
        headers: { Authorization: `Bearer ${secret}` },
        timeout: 15000,
        // Paystack rate limits (429) and request timeouts (408) are handled
        // below as retryable errors rather than ordinary validation results.
        validateStatus: (status) => status < 500,
      }
    );

    const status = Number(response && response.status);
    if (status === 408 || status === 429 || status === 401 ||
        (status >= 400 && status !== 400) || status >= 500) {
      const error = new Error('Paystack verification temporarily unavailable');
      error.code = 'PAYSTACK_PROVIDER_HTTP_ERROR';
      error.status = status;
      throw error;
    }

    if (!response.data || response.data.status !== true || !response.data.data) {
      return { found: false };
    }
    return { found: true, data: response.data.data };
  };
}

module.exports = { createPaystackVerify };
