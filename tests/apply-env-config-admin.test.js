'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cfg = require('../scripts/apply-env-config');

const PROD_JSON = fs.readFileSync(path.join(__dirname, '..', 'config', 'production-web.json'), 'utf8');
const FB = JSON.parse(PROD_JSON).firebase;
const WEB = { apiKey: 'AIzaSyStagingKeyForTests0000000000000000', authDomain: 'voltix-staging-777.firebaseapp.com', projectId: 'voltix-staging-777', storageBucket: 'voltix-staging-777.firebasestorage.app', messagingSenderId: '111222333444', appId: '1:111222333444:web:abcdef0123456789' };
const sa = JSON.stringify({ type: 'service_account', project_id: 'voltix-staging-777', private_key: 'k' });
const env = { VERCEL_ENV: 'preview', STAGING_FIREBASE_WEB_CONFIG: JSON.stringify(WEB), STAGING_FIREBASE_PROJECT_ID: 'voltix-staging-777', STAGING_PAYSTACK_PUBLIC_KEY: 'pk_test_abc123', STAGING_SPIN_BACKEND_URL: 'https://spin-staging.vercel.app', FIREBASE_SERVICE_ACCOUNT: sa, PAYSTACK_SECRET_KEY: 'sk_test_x', AUDIT_PEPPER: 'p'.repeat(40) };
function repo(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cfgadm-'));
  fs.mkdirSync(path.join(d, 'config')); fs.writeFileSync(path.join(d, 'config', 'production-web.json'), PROD_JSON);
  fs.mkdirSync(path.join(d, 'lib')); fs.copyFileSync(path.join(__dirname, '..', 'lib', 'env-guard.js'), path.join(d, 'lib', 'env-guard.js'));
  for (const [n, t] of Object.entries(files)) fs.writeFileSync(path.join(d, n), t);
  return d;
}
const page = '<script>firebase.initializeApp({apiKey:"' + FB.apiKey + '",authDomain:"' + FB.authDomain + '",projectId:"' + FB.projectId + '",storageBucket:"' + FB.storageBucket + '",messagingSenderId:"' + FB.messagingSenderId + '",appId:"' + FB.appId + '"});</script>';
const run = (d) => { const out = []; const code = cfg.run(env, d, (s) => out.push(s)); return { code, out: out.join('\n') }; };

test('ADMIN SDK: a server-side Admin SDK file (for example a stray verify-payment.js at the repository root) is not mistaken for an unknown browser config', () => {
  const d = repo({ 'index.html': page, 'verify-payment.js': 'const admin = require("firebase-admin"); admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });' });
  const r = run(d);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /unknown config source/);
});

test('ADMIN SDK: a browser file that merely mentions initializeApp without a recognised config still fails closed', () => {
  const r = run(repo({ 'index.html': page, 'mystery.html': '<script>firebase.initializeApp(window.cfg)</script>' }));
  assert.equal(r.code, 1); assert.match(r.out, /mystery\.html: initializeApp\(\) without a recognised/);
});
