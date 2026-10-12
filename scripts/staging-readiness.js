'use strict';
// scripts/staging-readiness.js
// Fail-closed readiness check for a PREVIEW / STAGING deployment of the payment code.
// It answers one question: "is it safe to call write-capable endpoints here?" and prints PASS or BLOCKED.
//  * It never prints secret values, key fragments, or the Firebase project id (only yes/no outcomes).
//  * PASS requires POSITIVE evidence (an explicit staging project id that matches the credential), not merely
//    the absence of a production match.
//  * PASS here covers only what code can check. Webhook configuration and "fresh deployment after env change"
//    need dashboard evidence and are always listed under `manual` (see docs/STAGING_READINESS.md).
// Usage:  node scripts/staging-readiness.js          (run inside the Preview deployment/build environment)
//         STAGING_CHECK_MODE=local node scripts/staging-readiness.js   (local rehearsal only)

const fs = require('fs');
const path = require('path');

const DEFAULT_PRODUCTION_PROJECT = 'voltix-pro-dc363';   // public id from the web config; override with PRODUCTION_FIREBASE_PROJECT_ID
const SKIP_DIRS = new Set(['node_modules', '.git', 'tests', 'docs', 'scripts', '.vercel', 'config']);
const SCAN_EXT = /\.(html|js|json)$/i;

function walk(dir, visit) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), visit); }
    else if (SCAN_EXT.test(e.name)) visit(path.join(dir, e.name));
  }
}

// Which deployable files hard-code the Production Firebase web config or a LIVE Paystack public key.
function scanRepo(root, productionProject) {
  const hits = { productionFirebaseConfig: [], livePaystackPublicKey: [] };
  walk(root, (file) => {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (/projectId/.test(text) && text.includes(productionProject)) hits.productionFirebaseConfig.push(rel);
    if (/pk_live_[A-Za-z0-9]+/.test(text)) hits.livePaystackPublicKey.push(rel);
  });
  return hits;
}

function projectIdOf(raw) {
  try {
    const j = JSON.parse(raw);
    return j && j.type === 'service_account' && typeof j.project_id === 'string' && j.project_id ? j.project_id : null;
  } catch (e) { return null; }
}

function evaluate({ env, root }) {
  const e = env || {};
  const production = e.PRODUCTION_FIREBASE_PROJECT_ID || DEFAULT_PRODUCTION_PROJECT;
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, status: ok ? 'PASS' : 'BLOCKED', detail });

  // 1. Where are we running?
  if (e.VERCEL_ENV === 'production') add('environment', false, 'Running in the PRODUCTION environment. Staging checks must never pass here.');
  else if (e.VERCEL_ENV === 'preview') add('environment', true, 'Running in a Preview environment.');
  else if (!e.VERCEL_ENV && e.STAGING_CHECK_MODE === 'local') add('environment', true, 'Local rehearsal mode (explicitly requested).');
  else add('environment', false, 'Cannot establish that this is a Preview environment (VERCEL_ENV missing or unknown).');

  // 2. Firebase credential: must be a service account for an explicitly named staging project, never production.
  const pid = e.FIREBASE_SERVICE_ACCOUNT ? projectIdOf(e.FIREBASE_SERVICE_ACCOUNT) : null;
  const declared = e.STAGING_FIREBASE_PROJECT_ID || null;
  if (!e.FIREBASE_SERVICE_ACCOUNT) add('firebase-credential', false, 'FIREBASE_SERVICE_ACCOUNT is not set in this environment.');
  else if (!pid) add('firebase-credential', false, 'FIREBASE_SERVICE_ACCOUNT is not a readable service-account JSON.');
  else if (pid === production) add('firebase-credential', false, 'The credential targets the PRODUCTION Firebase project.');
  else if (!declared) add('firebase-credential', false, 'STAGING_FIREBASE_PROJECT_ID is not set, so the Firebase target cannot be confirmed safely.');
  else if (declared === production) add('firebase-credential', false, 'STAGING_FIREBASE_PROJECT_ID names the PRODUCTION project.');
  else if (declared !== pid) add('firebase-credential', false, 'The credential does not match STAGING_FIREBASE_PROJECT_ID.');
  else add('firebase-credential', true, 'Credential targets the declared staging project, which differs from production.');

  // 3. Paystack secret must be a TEST key.
  const sk = e.PAYSTACK_SECRET_KEY || '';
  if (!sk) add('paystack-secret', false, 'PAYSTACK_SECRET_KEY is not set in this environment.');
  else if (sk.startsWith('sk_live_')) add('paystack-secret', false, 'PAYSTACK_SECRET_KEY is a LIVE key.');
  else if (!sk.startsWith('sk_test_')) add('paystack-secret', false, 'PAYSTACK_SECRET_KEY is not a recognisable test key.');
  else add('paystack-secret', true, 'PAYSTACK_SECRET_KEY is a test-mode key.');

  // 4. Keyed-hash pepper.
  const pepper = e.AUDIT_PEPPER || '';
  add('audit-pepper', pepper.length >= 32, pepper.length >= 32 ? 'AUDIT_PEPPER is set (32+ characters).' : 'AUDIT_PEPPER is missing or shorter than 32 characters.');

  // 5/6. Deployable files must not hard-code production config or a live public key.
  let hits = { productionFirebaseConfig: [], livePaystackPublicKey: [] };
  let scanned = true;
  try { hits = scanRepo(root, production); } catch (err) { scanned = false; }
  if (!scanned) {
    add('web-config', false, 'The repository could not be scanned.');
    add('paystack-public-key', false, 'The repository could not be scanned.');
  } else {
    const list = (a) => a.slice(0, 12).join(', ') + (a.length > 12 ? ' (+' + (a.length - 12) + ' more)' : '');
    add('web-config', hits.productionFirebaseConfig.length === 0,
      hits.productionFirebaseConfig.length === 0 ? 'No deployable file hard-codes the Production Firebase web config.'
        : hits.productionFirebaseConfig.length + ' file(s) hard-code the Production Firebase web config, so a Preview page would talk to production: ' + list(hits.productionFirebaseConfig));
    add('paystack-public-key', hits.livePaystackPublicKey.length === 0,
      hits.livePaystackPublicKey.length === 0 ? 'No deployable file hard-codes a LIVE Paystack public key.'
        : hits.livePaystackPublicKey.length + ' file(s) hard-code a LIVE Paystack public key: ' + list(hits.livePaystackPublicKey));
  }

  const verdict = checks.every((c) => c.status === 'PASS') ? 'PASS' : 'BLOCKED';
  const manual = [
    'Paystack TEST-mode webhook URL points at this preview (or a stable staging alias that Paystack can reach) and is separate from the live webhook.',
    'The environment variables were created or changed BEFORE this deployment was built (compare variable and deployment timestamps in Vercel).',
    'The Production credentials are NOT attached to the Preview target on any affected project (Vercel > Settings > Environment Variables).',
    'The staging Firebase project has its own rules, indexes and a TTL policy on rateLimits.ttlAt, and contains no production data.',
  ];
  return { verdict, checks, manual };
}

function format(result) {
  const lines = ['STAGING READINESS: ' + result.verdict, ''];
  for (const c of result.checks) lines.push('[' + c.status + '] ' + c.id + ' - ' + c.detail);
  lines.push('', 'Manual evidence still required (this script cannot see it):');
  for (const m of result.manual) lines.push(' - ' + m);
  if (result.verdict === 'PASS') lines.push('', 'PASS covers the automated checks only. Staging isolation is NOT proven until the manual evidence is supplied.');
  return lines.join('\n');
}

module.exports = { evaluate, format, scanRepo, projectIdOf };

if (require.main === module) {
  const result = evaluate({ env: process.env, root: path.join(__dirname, '..') });
  process.stdout.write(format(result) + '\n');
  process.exit(result.verdict === 'PASS' ? 0 : 1);
}
