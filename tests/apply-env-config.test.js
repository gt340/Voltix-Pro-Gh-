'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cfg = require('../scripts/apply-env-config');

const PROD_JSON = fs.readFileSync(path.join(__dirname, '..', 'config', 'production-web.json'), 'utf8');
const PROD = JSON.parse(PROD_JSON);
const FB = PROD.firebase;
const STAGING_WEB = {
  apiKey: 'AIzaSyStagingKeyForTests0000000000000000', authDomain: 'voltix-staging-777.firebaseapp.com', projectId: 'voltix-staging-777',
  storageBucket: 'voltix-staging-777.firebasestorage.app', messagingSenderId: '111222333444', appId: '1:111222333444:web:abcdef0123456789', measurementId: 'G-STAGING123',
};
const sa = (project) => JSON.stringify({ type: 'service_account', project_id: project, private_key: '-----BEGIN PRIVATE KEY-----SECRETKEYFRAGMENT' });
const goodEnv = () => ({
  VERCEL_ENV: 'preview', STAGING_FIREBASE_WEB_CONFIG: JSON.stringify(STAGING_WEB), STAGING_FIREBASE_PROJECT_ID: 'voltix-staging-777',
  STAGING_PAYSTACK_PUBLIC_KEY: 'pk_test_abcdef123456', STAGING_SPIN_BACKEND_URL: 'https://spin-backend-staging.vercel.app',
  FIREBASE_SERVICE_ACCOUNT: sa('voltix-staging-777'), PAYSTACK_SECRET_KEY: 'sk_test_SECRETPAYSTACKTEST', AUDIT_PEPPER: 'p'.repeat(40),
});
const fbBlock = () => `firebase.initializeApp({apiKey:"${FB.apiKey}",authDomain:"${FB.authDomain}",projectId:"${FB.projectId}",storageBucket:"${FB.storageBucket}",messagingSenderId:"${FB.messagingSenderId}",appId:"${FB.appId}",measurementId:"${FB.measurementId}"});`;
const page = (extra) => `<html><script>${fbBlock()}\n${extra || ''}</script></html>`;
const SIX = ['spin.html', 'foosball.html', 'sneaker.html', 'ludo.html', 'damii.html', 'kaisa.html'];

function repo(extraFiles) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
  fs.mkdirSync(path.join(d, 'config'));
  fs.writeFileSync(path.join(d, 'config', 'production-web.json'), PROD_JSON);
  fs.mkdirSync(path.join(d, 'lib'));
  fs.copyFileSync(path.join(__dirname, '..', 'lib', 'env-guard.js'), path.join(d, 'lib', 'env-guard.js'));
  const files = {
    'spin.html': page('const API="https://spin-backend-delta.vercel.app"; const PK="pk_live_aaaaaaaa11111111"; PaystackPop.setup({key:PK});'),
    'foosball.html': page('const k="pk_live_bbbbbbbb22222222"; PaystackPop.setup({key:k});'),
    'sneaker.html': page('PaystackPop.setup({key:"pk_live_cccccccc33333333"});'),
    'ludo.html': page(''), 'damii.html': page(''), 'kaisa.html': page(''),
    'chat.html': page(''), 'app.js': 'firebase.initializeApp({projectId:"' + FB.projectId + '",apiKey:"' + FB.apiKey + '"});',
    'about.html': '<html>static page</html>',
    ...(extraFiles || {}),
  };
  for (const [n, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, n)), { recursive: true }); fs.writeFileSync(path.join(d, n), t); }
  return d;
}
const read = (d, n) => fs.readFileSync(path.join(d, n), 'utf8');
const runIt = (env, d) => { const out = []; const code = cfg.run(env, d, (s) => out.push(s)); return { code, out: out.join('\n') }; };

test('ENV: only production and preview are recognised; everything else fails closed', () => {
  assert.equal(cfg.detectEnvironment({ VERCEL_ENV: 'production' }), 'production');
  assert.equal(cfg.detectEnvironment({ VERCEL_ENV: 'preview' }), 'preview');
  assert.equal(cfg.detectEnvironment({ STAGING_CHECK_MODE: 'local' }), 'preview');
  for (const bad of [{}, { VERCEL_ENV: 'development' }, { VERCEL_ENV: 'Production' }, { VERCEL_ENV: '' }, { VERCEL_ENV: 'staging' }, { STAGING_CHECK_MODE: 'local', VERCEL_ENV: 'weird' }]) {
    assert.throws(() => cfg.detectEnvironment(bad), /Unknown environment/);
  }
});

test('PRODUCTION: no file is changed, byte for byte, and coverage is reported', () => {
  const d = repo(); const before = {};
  for (const n of [...SIX, 'chat.html', 'app.js', 'about.html']) before[n] = read(d, n);
  const r = runIt({ VERCEL_ENV: 'production' }, d);
  assert.equal(r.code, 0); assert.match(r.out, /Production build: no files changed/);
  for (const n of Object.keys(before)) assert.equal(read(d, n), before[n], n);
  assert.match(r.out, /scanned \d+ deployable file/);
});

test('PRODUCTION: staging variables attached to Production fail the build (scope mix-up)', () => {
  const r = runIt({ VERCEL_ENV: 'production', STAGING_PAYSTACK_PUBLIC_KEY: 'pk_test_x' }, repo());
  assert.equal(r.code, 1); assert.match(r.out, /attached to Production/);
});

test('PREVIEW: a correct staging setup rewrites all six game pages and the shared script, leaving no Production value', () => {
  const d = repo(); const r = runIt(goodEnv(), d);
  assert.equal(r.code, 0, r.out);
  for (const n of [...SIX, 'chat.html', 'app.js']) {
    const t = read(d, n);
    for (const v of Object.values(FB)) assert.ok(!t.includes(v), n + ' still has a Production firebase value');
    assert.ok(t.includes('voltix-staging-777'), n);
    if (n !== 'app.js') for (const v of Object.values(STAGING_WEB)) assert.ok(t.includes(v), n + ' must contain the exact staging value ' + v.slice(0, 6) + '...');   // full values, not fragments
    assert.ok(!t.includes('web:6bbe58c7e8b7ffa9ccf252') && !t.includes('778425016855'), n + ' keeps a fragment of a Production id');
    assert.ok(!/pk_live_/.test(t), n); assert.ok(!t.includes('spin-backend-delta.vercel.app'), n);
  }
  assert.ok(read(d, 'spin.html').includes('https://spin-backend-staging.vercel.app'));
  assert.ok(read(d, 'spin.html').includes('pk_test_abcdef123456'));
  assert.equal(read(d, 'about.html'), '<html>static page</html>');                       // unrelated pages are untouched
  for (const n of SIX) assert.match(r.out, new RegExp('\\[COVERAGE\\] ' + n.replace('.', '\\.') + ':'));   // every game page appears in the coverage report
});

test('PREVIEW: nothing secret is ever printed', () => {
  for (const env of [goodEnv(), { ...goodEnv(), PAYSTACK_SECRET_KEY: 'sk_live_LIVESECRET' }, { VERCEL_ENV: 'preview', FIREBASE_SERVICE_ACCOUNT: sa('x') }]) {
    const r = runIt(env, repo());
    for (const bad of ['SECRETKEYFRAGMENT', 'SECRETPAYSTACKTEST', 'LIVESECRET', STAGING_WEB.apiKey, 'pk_test_abcdef123456', 'pk_live_aaaaaaaa11111111', FB.apiKey, 'BEGIN PRIVATE KEY']) assert.ok(!r.out.includes(bad), 'leaked ' + bad);
  }
});

test('PREVIEW: missing or malformed staging inputs fail closed and change nothing', () => {
  const cases = {
    'no web config': (e) => { delete e.STAGING_FIREBASE_WEB_CONFIG; },
    'web config not JSON': (e) => { e.STAGING_FIREBASE_WEB_CONFIG = '{nope'; },
    'web config array': (e) => { e.STAGING_FIREBASE_WEB_CONFIG = '[]'; },
    'missing apiKey': (e) => { const w = { ...STAGING_WEB }; delete w.apiKey; e.STAGING_FIREBASE_WEB_CONFIG = JSON.stringify(w); },
    'empty projectId': (e) => { e.STAGING_FIREBASE_WEB_CONFIG = JSON.stringify({ ...STAGING_WEB, projectId: ' ' }); },
    'numeric field': (e) => { e.STAGING_FIREBASE_WEB_CONFIG = JSON.stringify({ ...STAGING_WEB, appId: 5 }); },
    'bad authDomain': (e) => { e.STAGING_FIREBASE_WEB_CONFIG = JSON.stringify({ ...STAGING_WEB, authDomain: 'example.com' }); },
    'declared project missing': (e) => { delete e.STAGING_FIREBASE_PROJECT_ID; },
    'declared project differs': (e) => { e.STAGING_FIREBASE_PROJECT_ID = 'another-project'; },
    'no paystack key': (e) => { delete e.STAGING_PAYSTACK_PUBLIC_KEY; },
    'no spin url': (e) => { delete e.STAGING_SPIN_BACKEND_URL; },
    'spin url http': (e) => { e.STAGING_SPIN_BACKEND_URL = 'http://spin-backend-staging.vercel.app'; },
    'spin url with path': (e) => { e.STAGING_SPIN_BACKEND_URL = 'https://spin-backend-staging.vercel.app/api'; },
    'no service account': (e) => { delete e.FIREBASE_SERVICE_ACCOUNT; },
    'no pepper': (e) => { delete e.AUDIT_PEPPER; },
    'no paystack secret': (e) => { delete e.PAYSTACK_SECRET_KEY; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const d = repo(); const env = goodEnv(); mutate(env);
    const before = read(d, 'foosball.html');
    const r = runIt(env, d);
    assert.equal(r.code, 1, name); assert.equal(read(d, 'foosball.html'), before, name + ' (must not write)');
  }
});

test('PREVIEW: live Paystack keys, Production Firebase config and Production hosts are rejected', () => {
  const blocked = (mutate, re) => { const e = goodEnv(); mutate(e); const r = runIt(e, repo()); assert.equal(r.code, 1); assert.match(r.out, re); };
  blocked((e) => { e.STAGING_PAYSTACK_PUBLIC_KEY = 'pk_live_abcdef'; }, /TEST public key/);
  blocked((e) => { e.PAYSTACK_SECRET_KEY = 'sk_live_abcdef'; }, /not a Paystack TEST key/);
  blocked((e) => { e.STAGING_FIREBASE_WEB_CONFIG = JSON.stringify(FB); e.STAGING_FIREBASE_PROJECT_ID = FB.projectId; }, /equals the Production value|contains the Production project id/);
  blocked((e) => { e.STAGING_FIREBASE_WEB_CONFIG = JSON.stringify({ ...STAGING_WEB, storageBucket: FB.projectId + '-x.appspot.com' }); }, /contains the Production project id/);
  blocked((e) => { e.STAGING_FIREBASE_WEB_CONFIG = JSON.stringify({ ...STAGING_WEB, apiKey: FB.apiKey }); }, /equals the Production value/);
  blocked((e) => { e.STAGING_SPIN_BACKEND_URL = 'https://spin-backend-delta.vercel.app'; }, /Production host/);
  blocked((e) => { e.FIREBASE_SERVICE_ACCOUNT = sa(FB.projectId); e.STAGING_FIREBASE_PROJECT_ID = 'voltix-staging-777'; }, /PRODUCTION project/);
});

test('PREVIEW: unknown config sources and unmapped Production hosts fail closed', () => {
  let r = runIt(goodEnv(), repo({ 'mystery.html': '<script>firebase.initializeApp(window.cfg)</script>' }));
  assert.equal(r.code, 1); assert.match(r.out, /mystery\.html: initializeApp\(\) without a recognised/);
  r = runIt(goodEnv(), repo({ 'pay.html': '<script src="https://js.paystack.co/v1/inline.js"></script><script>PaystackPop.setup({key:KEY})</script>' }));
  assert.equal(r.code, 1); assert.match(r.out, /pay\.html: uses Paystack but no public key literal/);
  r = runIt(goodEnv(), repo({ 'link.html': '<a href="https://voltix-pro-game-theta.vercel.app/x">x</a>' }));
  assert.equal(r.code, 1); assert.match(r.out, /link\.html: references a Production host/);
});

test('PREVIEW: a leftover Production value after the rewrite is detected, not shipped', () => {
  const d = repo({ 'odd.html': '<script>firebase.initializeApp({projectId:"' + FB.projectId + '"});</script>' });
  const real = cfg.rewrite;
  const plan = cfg.plan(goodEnv(), d);
  assert.equal(plan.errors.length, 0);                                                  // normal rewrite is complete
  const prod = plan.prod;
  const leftover = cfg.scanText(real('x ' + FB.projectId + ' y', prod, { firebase: { ...STAGING_WEB, projectId: FB.projectId }, paystackPublicKey: 'pk_test_a', spinHost: 'h.vercel.app' }), prod);
  assert.ok(leftover['firebase.projectId'] > 0);                                        // the scanner would flag a staging value that reintroduces it
});

test('PREVIEW: an unreadable repository or missing production reference fails closed', () => {
  const r = runIt(goodEnv(), path.join(os.tmpdir(), 'no-such-dir-' + Date.now()));
  assert.equal(r.code, 1); assert.match(r.out, /BLOCKED/);
});

test('DUPLICATES: the same pages in two repositories get identical treatment, and a second pass over rewritten pages fails closed', () => {
  const a = repo(); const b = repo();
  assert.equal(runIt(goodEnv(), a).code, 0); assert.equal(runIt(goodEnv(), b).code, 0);
  for (const n of [...SIX, 'chat.html', 'app.js']) assert.equal(read(a, n), read(b, n), n);
  const again = runIt(goodEnv(), a);                                                    // second pass finds nothing to change
  assert.equal(again.code, 1);                                                          // already-rewritten pages no longer match the Production reference: initializeApp has no recognised config
  assert.match(again.out, /unknown config source/);
});
