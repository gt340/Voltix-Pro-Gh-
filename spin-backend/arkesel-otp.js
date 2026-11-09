'use strict';

const DEFAULT_BASE_URL = 'https://sms.arkesel.com/api/otp';

class ArkeselOtpError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ArkeselOtpError';
    this.providerCode = details.providerCode || null;
    this.httpStatus = details.httpStatus || null;
    this.retryable = Boolean(details.retryable);
  }
}

function normalizeE164(value) {
  const raw = String(value || '').trim();
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 10 && digits.startsWith('0')) digits = '233' + digits.slice(1);
  if (digits.length === 9) digits = '233' + digits;
  if (!/^233\d{9}$/.test(digits)) {
    throw new TypeError('A valid Ghana E.164 phone number is required');
  }
  return '+' + digits;
}

function toArkeselPhoneNumber(value) {
  return normalizeE164(value).slice(1);
}

function responseCode(data) {
  return data && data.code != null ? String(data.code) : '';
}

function createArkeselOtpClient(options = {}) {
  const http = options.http;
  const apiKey = String(options.apiKey || '').trim();
  const senderId = String(options.senderId || '').trim();
  const baseUrl = String(options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : 10000;
  const expiryMinutes = Number.isInteger(options.expiryMinutes) ? options.expiryMinutes : 5;

  if (!http || typeof http.post !== 'function') {
    throw new TypeError('An HTTP client with post() is required');
  }
  if (!apiKey) throw new TypeError('Arkesel API key is required');
  if (!senderId) throw new TypeError('Arkesel sender ID is required');
  if (expiryMinutes < 1 || expiryMinutes > 10) {
    throw new RangeError('Arkesel OTP expiry must be between 1 and 10 minutes');
  }

  async function request(path, body, successCode, operation) {
    let response;
    try {
      response = await http.post(baseUrl + path, body, {
        headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
        timeout: timeoutMs,
        validateStatus: status => status >= 200 && status < 500
      });
    } catch (error) {
      throw new ArkeselOtpError('Arkesel ' + operation + ' request failed', {
        retryable: true
      });
    }

    const data = response && response.data;
    const code = responseCode(data);
    if (response.status < 200 || response.status >= 300 || code !== successCode) {
      throw new ArkeselOtpError(
        'Arkesel ' + operation + ' was rejected' + (code ? ' (' + code + ')' : ''),
        {
          providerCode: code || null,
          httpStatus: response.status,
          retryable: response.status >= 500 || code === '1011' || code === '1106'
        }
      );
    }
    return { code, message: String(data.message || '') };
  }

  return Object.freeze({
    async generate(phone) {
      const phone_number = toArkeselPhoneNumber(phone);
      return request('/generate', {
        expiry: expiryMinutes,
        length: 6,
        medium: 'sms',
        message: 'Your Voltix Pro GH verification code is %otp_code%. It expires in ' +
          expiryMinutes + ' minutes. Do not share this code.',
        phone_number,
        sender_id: senderId,
        type: 'numeric'
      }, '1000', 'OTP generation');
    },

    async verify(phone, code) {
      const number = normalizeE164(phone);
      const otp = String(code || '').trim();
      if (!/^\d{6}$/.test(otp)) {
        throw new TypeError('OTP must contain exactly six digits');
      }
      return request('/verify', { phone_number, code: otp }, '1100', 'OTP verification');
    }
  });
}

module.exports = {
  ArkeselOtpError,
  createArkeselOtpClient,
  normalizeE164
};
