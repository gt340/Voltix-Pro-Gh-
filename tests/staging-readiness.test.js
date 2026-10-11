'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { evaluate, format } = require('../scripts/staging-readiness');

const PROD = 'voltix-pro-dc363';
const SECRET_FRAGMENT = 'PRIVATEKEYSECRETFRAGMENT';
const sa = (project) => JSON.stringify({ type: 'service_account', project_id: project, private_key: '-----BEGIN PRIVATE KEY-----' + SECRET_FRAGMENT });
const good = () => ({
  VERCEL_ENV: 'preview', FIREBASE_SERVICE_ACCOUNT: sa('voltix-staging-777'), STAGING_FIREBASE_PROJECT_ID: 'voltix-staging-777',
  PAYSTACK_SECRET_KEY: 'sk_test_SECRETPAYSTACKVALUE', AUDIT_PEPPER: 'p'.repeat(40),
});
function repo(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-'));
  for (const [name, text] of Object.entries(files || {})) { fs.mkdirSync(path.dirname(path.join(d, name)), { recursive: true }); fs.writeFileSync(path.join(d, name), text); }
  return d;
}
const status = (r, id) => r.checks.find((c) => c.id === id).status;
const clean = () => repo({ 'index.html': '<script>fetch("/api/x")</script>', 'api/a.js': 'module.exports=1' });

test('READINESS: a correctly configured staging preview passes the automated checks, with manual evidence still listed', () => {
  const r = evaluate({ env: good(), root: clean() });
  assert.equal(r.verdict, 'PASS');
  assert.ok(r.manual.length >= 4);
  assert.match(format(r), /NOT proven until the manual evidence/);
});

test('READINESS: nothing secret or identifying is ever printed', () => {
  for (const env of [good(), { ...good(), PAYSTACK_SECRET_KEY: 'sk_live_LIVESECRETVALUE' }, { ...good(), FIREBASE_SERVICE_ACCOUNT: sa(PROD) }, { ...good(), FIREBASE_SERVICE_ACCOUNT: 'not json PRIVATEKEYSECRETFRAGMENT' }]) {
    const out = format(evaluate({ env, root: clean() }));
    for (const bad of [SECRET_FRAGMENT, 'SECRETPAYSTACKVALUE', 'LIVESECRETVALUE', 'voltix-staging-777', PROD, 'BEGIN PRIVATE KEY']) assert.ok(!out.includes(bad), 'leaked ' + bad);
  }
});

test('READINESS: BLOCKED in Production, or when the environment cannot be established', () => {
  assert.equal(status(evaluate({ env: { ...good(), VERCEL_ENV: 'production' }, root: clean() }), 'environment'), 'BLOCKED');
  const noEnv = good(); delete noEnv.VERCEL_ENV;
  assert.equal(status(evaluate({ env: noEnv, root: clean() }), 'environment'), 'BLOCKED');
  assert.equal(status(evaluate({ env: { ...noEnv, STAGING_CHECK_MODE: 'local' }, root: clean() }), 'environment'), 'PASS');
  assert.equal(status(evaluate({ env: { ...good(), VERCEL_ENV: 'development' }, root: clean() }), 'environment'), 'BLOCKED');
});

test('READINESS: BLOCKED when the Firebase credential targets Production or the target cannot be confirmed', () => {
  const blocked = (env) => assert.equal(status(evaluate({ env, root: clean() }), 'firebase-credential'), 'BLOCKED');
  blocked({ ...good(), FIREBASE_SERVICE_ACCOUNT: sa(PROD), STAGING_FIREBASE_PROJECT_ID: 'voltix-staging-777' });
  blocked({ ...good(), FIREBASE_SERVICE_ACCOUNT: sa(PROD), STAGING_FIREBASE_PROJECT_ID: PROD });
  blocked({ ...good(), STAGING_FIREBASE_PROJECT_ID: PROD });
  blocked({ ...good(), STAGING_FIREBASE_PROJECT_ID: 'some-other-project' });                  // credential does not match the declaration
  const noDecl = good(); delete noDecl.STAGING_FIREBASE_PROJECT_ID; blocked(noDecl);        // "differs from production" is not enough
  const noCred = good(); delete noCred.FIREBASE_SERVICE_ACCOUNT; blocked(noCred);
  blocked({ ...good(), FIREBASE_SERVICE_ACCOUNT: '{not json' });
  blocked({ ...good(), FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ type: 'authorized_user', project_id: 'voltix-staging-777' }) });
  blocked({ ...good(), PRODUCTION_FIREBASE_PROJECT_ID: 'voltix-staging-777' });             // production id override is honoured
});

test('READINESS: BLOCKED for live, missing or unrecognised Paystack secrets and a weak pepper', () => {
  for (const k of ['sk_live_abc123', '', 'pk_test_abc', 'garbage']) assert.equal(status(evaluate({ env: { ...good(), PAYSTACK_SECRET_KEY: k }, root: clean() }), 'paystack-secret'), 'BLOCKED', k);
  assert.equal(status(evaluate({ env: { ...good(), AUDIT_PEPPER: 'short' }, root: clean() }), 'audit-pepper'), 'BLOCKED');
  const none = good(); delete none.AUDIT_PEPPER;
  assert.equal(status(evaluate({ env: none, root: clean() }), 'audit-pepper'), 'BLOCKED');
});

test('READINESS: BLOCKED when deployable files hard-code the Production web config or a LIVE Paystack public key (names only)', () => {
  const dirty = repo({
    'foosball.html': 'firebase.initializeApp({projectId:"' + PROD + '"})', 'sneaker.html': 'x projectId "' + PROD + '"',
    'spin.html': 'const k="pk_live_abcdef123456"', 'notes/readme.txt': 'ignored ' + PROD, 'tests/x.js': 'projectId ' + PROD,
  });
  const r = evaluate({ env: good(), root: dirty });
  assert.equal(r.verdict, 'BLOCKED');
  assert.equal(status(r, 'web-config'), 'BLOCKED'); assert.equal(status(r, 'paystack-public-key'), 'BLOCKED');
  const out = format(r);
  assert.match(out, /foosball\.html/); assert.match(out, /sneaker\.html/); assert.match(out, /spin\.html/);
  assert.ok(!out.includes('pk_live_abcdef123456'));
  assert.doesNotMatch(out, /tests\/x\.js/);                                              // test/doc folders are not deployable
});

test('READINESS: an unreadable repository or an empty environment fails closed', () => {
  assert.equal(evaluate({ env: good(), root: path.join(os.tmpdir(), 'does-not-exist-' + Date.now()) }).verdict, 'BLOCKED');
  assert.equal(evaluate({ env: {}, root: clean() }).verdict, 'BLOCKED');
  assert.equal(evaluate({ env: undefined, root: clean() }).verdict, 'BLOCKED');
});
