'use strict';
// scripts/apply-env-config.js  (run by Vercel as `vercel-build`; identical copy in the voltix-pro-game repo)
// Build-time, fail-closed selection of web configuration.
//   VERCEL_ENV=production -> NO file is changed. Production keeps exactly the configuration it has today.
//                            (If any STAGING_* variable is attached to Production the build FAILS: scope mix-up.)
//   VERCEL_ENV=preview    -> every deployable page/script is rewritten to use the dedicated STAGING Firebase web
//                            config, the Paystack TEST public key and the staging spin backend. If any staging
//                            input is missing or malformed, or any production value would survive, the build FAILS,
//                            so a Preview can never silently fall back to Production configuration.
//   anything else         -> the build FAILS (unknown environment).
// Nothing secret is printed: only file names and counts. Production web values are public and live in
// config/production-web.json.
//
// Required Preview-only variables:
//   STAGING_FIREBASE_WEB_CONFIG   JSON: apiKey, authDomain, projectId, storageBucket, messagingSenderId, appId[, measurementId]
//   STAGING_FIREBASE_PROJECT_ID   must equal the projectId inside STAGING_FIREBASE_WEB_CONFIG
//   STAGING_PAYSTACK_PUBLIC_KEY   pk_test_...
//   STAGING_SPIN_BACKEND_URL      https://<staging spin-backend host>   (no path)

const fs = require('fs');
const path = require('path');
const { evaluateRuntime } = require('../lib/env-guard');

const SKIP_DIRS = new Set(['node_modules', '.git', 'tests', 'docs', 'scripts', '.vercel', 'config', 'lib', 'api', 'spin-backend']);
const SCAN_EXT = /\.(html|js|json)$/i;
const STAGING_VARS = ['STAGING_FIREBASE_WEB_CONFIG', 'STAGING_FIREBASE_PROJECT_ID', 'STAGING_PAYSTACK_PUBLIC_KEY', 'STAGING_SPIN_BACKEND_URL'];
const FB_KEYS = ['apiKey', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId', 'appId', 'measurementId'];

function loadProduction(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'config', 'production-web.json'), 'utf8'));
}

function detectEnvironment(env) {
  const e = env || {};
  if (e.VERCEL_ENV === 'production') return 'production';
  if (e.VERCEL_ENV === 'preview') return 'preview';
  if (!e.VERCEL_ENV && e.STAGING_CHECK_MODE === 'local') return 'preview';   // local rehearsal behaves like Preview
  throw new Error('Unknown environment (VERCEL_ENV is missing or not production/preview). Refusing to continue.');
}

function walk(dir, visit) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), visit); }
    else if (SCAN_EXT.test(entry.name)) visit(path.join(dir, entry.name));
  }
}

const count = (text, needle) => (needle ? text.split(needle).length - 1 : 0);

function scanText(text, prod) {
  const c = {};
  for (const k of FB_KEYS) if (prod.firebase[k]) c['firebase.' + k] = count(text, prod.firebase[k]);
  c.paystackLiveKey = (text.match(/pk_live_[A-Za-z0-9]+/g) || []).length;
  c.paystackTestKey = (text.match(/pk_test_[A-Za-z0-9]+/g) || []).length;
  c.productionSpinBackend = prod.spinBackendHosts.reduce((n, h) => n + count(text, h), 0);
  c.blockedProductionHost = prod.blockedProductionHosts.reduce((n, h) => n + count(text, h), 0);
  c.initializeApp = (text.match(/initializeApp\s*\(/g) || []).length;
  c.paystackUsage = (text.match(/PaystackPop|js\.paystack\.co/g) || []).length;
  return c;
}

const PRODUCTION_KEYS = (prod) => [...FB_KEYS.filter((k) => prod.firebase[k]).map((k) => 'firebase.' + k), 'paystackLiveKey', 'productionSpinBackend', 'blockedProductionHost'];

function scanRepo(root, prod) {
  const files = [];
  walk(root, (file) => {
    const rel = path.relative(root, file).split(path.sep).join('/');
    const text = fs.readFileSync(file, 'utf8');
    files.push({ file, rel, text, counts: scanText(text, prod) });
  });
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return files;
}

function validateStaging(env, prod) {
  const errors = [];
  const e = env || {};
  let web = null;
  if (!e.STAGING_FIREBASE_WEB_CONFIG) errors.push('STAGING_FIREBASE_WEB_CONFIG is not set.');
  else {
    try { web = JSON.parse(e.STAGING_FIREBASE_WEB_CONFIG); } catch (err) { errors.push('STAGING_FIREBASE_WEB_CONFIG is not valid JSON.'); }
  }
  if (web && (typeof web !== 'object' || Array.isArray(web))) { errors.push('STAGING_FIREBASE_WEB_CONFIG must be a JSON object.'); web = null; }
  if (web) {
    for (const k of FB_KEYS.filter((x) => x !== 'measurementId')) {
      if (typeof web[k] !== 'string' || !web[k].trim()) errors.push('STAGING_FIREBASE_WEB_CONFIG is missing "' + k + '".');
    }
    if (web.measurementId !== undefined && typeof web.measurementId !== 'string') errors.push('STAGING_FIREBASE_WEB_CONFIG "measurementId" must be a string.');
    for (const k of FB_KEYS) {
      if (typeof web[k] !== 'string') continue;
      if (web[k] === prod.firebase[k]) errors.push('Staging "' + k + '" equals the Production value.');
      if (web[k].includes(prod.firebase.projectId)) errors.push('Staging "' + k + '" contains the Production project id.');
    }
    if (typeof web.authDomain === 'string' && !/\.(firebaseapp\.com|web\.app)$/.test(web.authDomain)) errors.push('Staging authDomain must end with .firebaseapp.com or .web.app.');
    if (typeof web.projectId === 'string' && web.projectId !== e.STAGING_FIREBASE_PROJECT_ID) errors.push('STAGING_FIREBASE_PROJECT_ID is missing or does not equal the web config projectId.');
  }
  const pk = e.STAGING_PAYSTACK_PUBLIC_KEY || '';
  if (!/^pk_test_[A-Za-z0-9]+$/.test(pk)) errors.push('STAGING_PAYSTACK_PUBLIC_KEY must be a Paystack TEST public key (pk_test_...).');
  let host = null;
  const spin = e.STAGING_SPIN_BACKEND_URL || '';
  const m = spin.match(/^https:\/\/([a-z0-9][a-z0-9.-]*[a-z0-9])$/);
  if (!m) errors.push('STAGING_SPIN_BACKEND_URL must be an https origin with no path (https://host).');
  else if (prod.spinBackendHosts.includes(m[1]) || prod.blockedProductionHosts.includes(m[1])) errors.push('STAGING_SPIN_BACKEND_URL is a Production host.');
  else host = m[1];
  return { errors, staging: errors.length ? null : { firebase: web, paystackPublicKey: pk, spinHost: host } };
}

function rewrite(text, prod, staging) {
  let out = text;
  const entries = FB_KEYS.filter((k) => prod.firebase[k]).map((k) => [prod.firebase[k], staging.firebase[k] === undefined ? '' : staging.firebase[k]]);
  entries.sort((a, b) => b[0].length - a[0].length);                       // longest first: appId and authDomain contain shorter values
  for (const [from, to] of entries) out = out.split(from).join(to);
  out = out.replace(/pk_live_[A-Za-z0-9]+/g, staging.paystackPublicKey);
  for (const h of prod.spinBackendHosts) out = out.split(h).join(staging.spinHost);
  return out;
}

// Decide everything BEFORE writing anything.
function plan(env, root) {
  const mode = detectEnvironment(env);
  const prod = loadProduction(root);
  const files = scanRepo(root, prod);
  const errors = [];
  const changes = [];
  if (mode === 'production') {
    const present = STAGING_VARS.filter((v) => env[v] !== undefined);
    if (present.length) errors.push('STAGING_* variables are attached to Production (' + present.join(', ') + '). Scope mix-up; refusing to build.');
    return { mode, files, errors, changes, prod };
  }
  const v = validateStaging(env, prod);
  errors.push(...v.errors);
  // The server-side half of staging (service account, Paystack TEST secret, pepper) must be approved too.
  const guard = evaluateRuntime(env);
  if (!guard.ok) guard.reasons.forEach((r) => errors.push('Server environment: ' + r));
  for (const f of files) {
    const c = f.counts;
    if (c.initializeApp > 0 && c['firebase.projectId'] === 0) errors.push(f.rel + ': initializeApp() without a recognised Production Firebase config (unknown config source).');
    if (c.paystackUsage > 0 && c.paystackLiveKey + c.paystackTestKey === 0) errors.push(f.rel + ': uses Paystack but no public key literal was found (unknown key source).');
    if (c.blockedProductionHost > 0) errors.push(f.rel + ': references a Production host that has no staging mapping.');
  }
  if (v.staging) {
    for (const f of files) {
      const next = rewrite(f.text, prod, v.staging);
      const after = scanText(next, prod);
      const leftovers = PRODUCTION_KEYS(prod).filter((k) => after[k] > 0);
      if (leftovers.length) errors.push(f.rel + ': Production values would survive the rewrite (' + leftovers.join(', ') + ').');
      if (next !== f.text) changes.push({ file: f.file, rel: f.rel, text: next });
    }
  }
  return { mode, files, errors, changes, prod };
}

function coverageLines(files, prod) {
  const lines = [];
  for (const f of files) {
    const parts = Object.entries(f.counts).filter(([, n]) => n > 0).map(([k, n]) => k + '=' + n);
    if (parts.length) lines.push('[COVERAGE] ' + f.rel + ': ' + parts.join(' '));
  }
  const withProd = files.filter((f) => PRODUCTION_KEYS(prod).some((k) => f.counts[k] > 0)).length;
  lines.push('[COVERAGE] scanned ' + files.length + ' deployable file(s); ' + withProd + ' contain Production web configuration.');
  return lines;
}

function run(env, root, log) {
  log = log || ((s) => process.stdout.write(s + '\n'));
  let result;
  try { result = plan(env, root); }
  catch (err) { log('[CONFIG] BLOCKED: ' + err.message); return 1; }
  coverageLines(result.files, result.prod).forEach(log);
  if (result.errors.length) {
    log('[CONFIG] BLOCKED (' + result.mode + '):');
    result.errors.forEach((x) => log('  - ' + x));
    return 1;
  }
  if (result.mode === 'production') { log('[CONFIG] Production build: no files changed.'); return 0; }
  for (const c of result.changes) fs.writeFileSync(c.file, c.text);
  log('[CONFIG] Preview build: staging configuration applied to ' + result.changes.length + ' file(s); no Production value remains.');
  return 0;
}

module.exports = { detectEnvironment, validateStaging, scanText, scanRepo, rewrite, plan, run, FB_KEYS, STAGING_VARS };

if (require.main === module) {
  const root = path.join(__dirname, '..');
  process.exit(run(process.env, root));
}
