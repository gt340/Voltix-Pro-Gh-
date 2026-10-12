'use strict';
// lib/env-guard.js  (identical copy: spin-backend/env-guard.js)
// Runtime fail-closed guard for the payment backends. Production is left exactly as it is.
// Anything that is not Production must be an explicitly approved STAGING setup, otherwise the backend refuses
// to start (every request gets 503) and never touches Firebase or Paystack.
//   production            -> allowed, nothing else is checked (existing behaviour)
//   preview / local trial -> requires: a staging service account whose project is declared in
//                            STAGING_FIREBASE_PROJECT_ID and is NOT the production project, a Paystack TEST secret
//                            (sk_test_), and AUDIT_PEPPER (32+ chars)
//   anything else         -> blocked (unknown environment)
// It never returns or logs secret values or the project id.

const DEFAULT_PRODUCTION_PROJECT = 'voltix-pro-dc363';   // public id; override with PRODUCTION_FIREBASE_PROJECT_ID

function serviceAccountProject(raw) {
  try {
    const j = JSON.parse(raw);
    return j && j.type === 'service_account' && typeof j.project_id === 'string' && j.project_id ? j.project_id : null;
  } catch (e) { return null; }
}

function evaluateRuntime(env) {
  const e = env || {};
  const reasons = [];
  const vercelEnv = e.VERCEL_ENV;
  if (vercelEnv === 'production') return { ok: true, mode: 'production', reasons };
  const local = !vercelEnv && e.STAGING_CHECK_MODE === 'local';
  if (vercelEnv !== 'preview' && !local) {
    return { ok: false, mode: 'unknown', reasons: ['Unknown environment: only Production or an approved Preview/local staging setup may run payments.'] };
  }
  const production = e.PRODUCTION_FIREBASE_PROJECT_ID || DEFAULT_PRODUCTION_PROJECT;
  const pid = e.FIREBASE_SERVICE_ACCOUNT ? serviceAccountProject(e.FIREBASE_SERVICE_ACCOUNT) : null;
  const declared = e.STAGING_FIREBASE_PROJECT_ID || null;
  if (!e.FIREBASE_SERVICE_ACCOUNT) reasons.push('FIREBASE_SERVICE_ACCOUNT is not set for this environment.');
  else if (!pid) reasons.push('FIREBASE_SERVICE_ACCOUNT is not a readable service-account JSON.');
  else if (pid === production) reasons.push('The Firebase credential targets the PRODUCTION project.');
  else if (!declared) reasons.push('STAGING_FIREBASE_PROJECT_ID is not set, so the Firebase target cannot be confirmed.');
  else if (declared === production) reasons.push('STAGING_FIREBASE_PROJECT_ID names the PRODUCTION project.');
  else if (declared !== pid) reasons.push('The Firebase credential does not match STAGING_FIREBASE_PROJECT_ID.');
  const sk = e.PAYSTACK_SECRET_KEY || '';
  if (!sk) reasons.push('PAYSTACK_SECRET_KEY is not set for this environment.');
  else if (!sk.startsWith('sk_test_')) reasons.push('PAYSTACK_SECRET_KEY is not a Paystack TEST key.');
  if ((e.AUDIT_PEPPER || '').length < 32) reasons.push('AUDIT_PEPPER is missing or shorter than 32 characters.');
  return { ok: reasons.length === 0, mode: local ? 'local-staging' : 'preview', reasons };
}

// A handler that refuses everything (used when the guard says no). Logs reasons only, never values.
function blockedHandler(guard, shape) {
  return (req, res) => {
    console.error('Environment guard blocked this request: ' + guard.reasons.join(' | '));
    const body = shape === 'success'
      ? { success: false, error: 'Environment not approved for payments' }
      : { error: 'Environment not approved for payments' };
    return res.status(503).json(body);
  };
}

module.exports = { evaluateRuntime, blockedHandler, serviceAccountProject };
