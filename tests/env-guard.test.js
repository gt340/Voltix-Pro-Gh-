'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { evaluateRuntime, blockedHandler } = require('../lib/env-guard');
const { evaluate: readiness } = require('../scripts/staging-readiness');

const PROD = 'voltix-pro-dc363';
const sa = (p) => JSON.stringify({ type: 'service_account', project_id: p, private_key: '-----BEGIN PRIVATE KEY-----GUARDSECRETFRAGMENT' });
const staging = () => ({ VERCEL_ENV: 'preview', FIREBASE_SERVICE_ACCOUNT: sa('voltix-staging-777'), STAGING_FIREBASE_PROJECT_ID: 'voltix-staging-777', PAYSTACK_SECRET_KEY: 'sk_test_GUARDSECRET', AUDIT_PEPPER: 'p'.repeat(40) });
const prodLike = () => ({ VERCEL_ENV: 'production', FIREBASE_SERVICE_ACCOUNT: sa(PROD), PAYSTACK_SECRET_KEY: 'sk_live_whatever' });

function withEnv(env, fn) {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (/^(VERCEL|FIREBASE|PAYSTACK|STAGING|AUDIT|PRODUCTION)/.test(k)) delete process.env[k];
  Object.assign(process.env, env);
  try { return fn(); } finally { for (const k of Object.keys(process.env)) delete process.env[k]; Object.assign(process.env, saved); }
}
const fresh = (rel) => { const p = require.resolve(rel); delete require.cache[p]; return require(p); };
const call = (handler) => { const out = {}; handler({ method: 'POST', headers: {}, body: {} }, { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; }, setHeader() {}, end(b) { out.raw = b; } }); return out; };

test('GUARD: Production is allowed exactly as today, whatever its credentials', () => {
  const g = evaluateRuntime(prodLike());
  assert.equal(g.ok, true); assert.equal(g.mode, 'production'); assert.deepEqual(g.reasons, []);
  assert.equal(evaluateRuntime({ VERCEL_ENV: 'production' }).ok, true);
});

test('GUARD: Preview with Production credentials, a live key, or missing staging inputs is blocked', () => {
  const bad = (mutate) => { const e = staging(); mutate(e); const g = evaluateRuntime(e); assert.equal(g.ok, false); return g; };
  bad((e) => { e.FIREBASE_SERVICE_ACCOUNT = sa(PROD); });
  bad((e) => { e.FIREBASE_SERVICE_ACCOUNT = sa(PROD); e.STAGING_FIREBASE_PROJECT_ID = PROD; });
  bad((e) => { e.PAYSTACK_SECRET_KEY = 'sk_live_abc'; });
  bad((e) => { delete e.PAYSTACK_SECRET_KEY; });
  bad((e) => { delete e.FIREBASE_SERVICE_ACCOUNT; });
  bad((e) => { e.FIREBASE_SERVICE_ACCOUNT = '{broken'; });
  bad((e) => { delete e.STAGING_FIREBASE_PROJECT_ID; });
  bad((e) => { e.STAGING_FIREBASE_PROJECT_ID = 'other'; });
  bad((e) => { delete e.AUDIT_PEPPER; });
  bad((e) => { e.PRODUCTION_FIREBASE_PROJECT_ID = 'voltix-staging-777'; });
  assert.equal(evaluateRuntime(staging()).ok, true);
  const g = evaluateRuntime({ ...staging(), FIREBASE_SERVICE_ACCOUNT: sa(PROD) });
  assert.ok(g.reasons.some((r) => /PRODUCTION project/.test(r)), 'the specific reason is reported');
});

test('GUARD: unknown or missing environments are blocked; local rehearsal must be explicit', () => {
  for (const env of [{}, { VERCEL_ENV: 'development' }, { VERCEL_ENV: 'Production' }, { VERCEL_ENV: '' }, { ...staging(), VERCEL_ENV: 'staging' }]) assert.equal(evaluateRuntime(env).ok, false);
  const local = staging(); delete local.VERCEL_ENV;
  assert.equal(evaluateRuntime(local).ok, false);
  assert.equal(evaluateRuntime({ ...local, STAGING_CHECK_MODE: 'local' }).ok, true);
});

test('GUARD: reasons never contain secrets, key fragments or the project id', () => {
  for (const env of [{ ...staging(), FIREBASE_SERVICE_ACCOUNT: sa(PROD) }, { ...staging(), PAYSTACK_SECRET_KEY: 'sk_live_GUARDSECRET' }, {}]) {
    const text = JSON.stringify(evaluateRuntime(env));
    for (const bad of ['GUARDSECRETFRAGMENT', 'GUARDSECRET', 'BEGIN PRIVATE KEY', PROD, 'voltix-staging-777']) assert.ok(!text.includes(bad), 'leaked ' + bad);
  }
});

test('GUARD: the copy used by spin-backend is identical', () => {
  assert.equal(fs.readFileSync(path.join(__dirname, '..', 'lib', 'env-guard.js'), 'utf8'), fs.readFileSync(path.join(__dirname, '..', 'spin-backend', 'env-guard.js'), 'utf8'));
});

test('GUARD: server and build-time readiness agree on the same inputs', () => {
  const variants = [staging(), { ...staging(), FIREBASE_SERVICE_ACCOUNT: sa(PROD) }, { ...staging(), PAYSTACK_SECRET_KEY: 'sk_live_x' }, { ...staging(), AUDIT_PEPPER: 'x' },
    (() => { const e = staging(); delete e.STAGING_FIREBASE_PROJECT_ID; return e; })(), { ...staging(), VERCEL_ENV: 'development' }];
  const empty = fs.mkdtempSync(path.join(require('os').tmpdir(), 'agree-'));
  for (const v of variants) {
    const r = readiness({ env: v, root: empty });
    const serverSide = ['environment', 'firebase-credential', 'paystack-secret', 'audit-pepper'].every((id) => r.checks.find((c) => c.id === id).status === 'PASS');
    assert.equal(serverSide, evaluateRuntime(v).ok, JSON.stringify(Object.keys(v)));
  }
});

test('WIRING: a Preview carrying Production credentials gets 503 from verify-payment and never initialises Firebase', () => {
  withEnv({ VERCEL_ENV: 'preview', FIREBASE_SERVICE_ACCOUNT: sa(PROD), PAYSTACK_SECRET_KEY: 'sk_test_x', AUDIT_PEPPER: 'p'.repeat(40), STAGING_FIREBASE_PROJECT_ID: 'voltix-staging-777' }, () => {
    const handler = fresh('../api/verify-payment.js');
    const r = call(handler);
    assert.equal(r.status, 503); assert.equal(r.body.success, false); assert.match(r.body.error, /not approved/);
    assert.ok(!Object.keys(require.cache).some((k) => /firebase-admin/.test(k)), 'firebase-admin must not be loaded');
  });
});

test('WIRING: the new /api routes and the spin backend entry point refuse to run in an unapproved environment', () => {
  withEnv({ VERCEL_ENV: 'preview', FIREBASE_SERVICE_ACCOUNT: sa(PROD), PAYSTACK_SECRET_KEY: 'sk_live_x' }, () => {
    const rt = fresh('../lib/api-runtime.js');
    assert.equal(rt.deps, null);
    const r = call(rt.route(async () => { throw new Error('must not run'); }));
    assert.equal(r.status, 503);
    process.env.VERCEL = '1';                                                           // behave like the serverless runtime (no local listener)
    const entry = fresh('../spin-backend/server.js');
    assert.equal(typeof entry, 'function');
    const s = call(entry); assert.equal(s.raw, JSON.stringify({ error: 'Environment not approved for payments' }));
  });
});

test('WIRING: blockedHandler answers 503 and logs reasons only', () => {
  const h = blockedHandler({ reasons: ['reason one'] }, 'plain');
  const r = call(h); assert.equal(r.status, 503); assert.deepEqual(r.body, { error: 'Environment not approved for payments' });
});
