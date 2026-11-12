'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const spin = fs.readFileSync(path.join(root, 'spin.html'), 'utf8');

test('backend prize weights total exactly 100 and include both non-reward outcomes', () => {
  const block = server.match(/const PRIZES = \[([\s\S]*?)\n\];/);
  assert.ok(block, 'PRIZES table exists');
  const rows = [...block[1].matchAll(/\{\s*id:'([^']+)'\s*,\s*weight:([\d.]+)/g)];
  const total = rows.reduce((sum, row) => sum + Number(row[2]), 0);
  assert.equal(total, 100);
  assert.ok(rows.some(row => row[1] === 'tryAgain'));
  assert.ok(rows.some(row => row[1] === 'zeroCoin'));
});

test('frontend wheel segments exactly match the backend prize IDs', () => {
  const frontBlock = spin.match(/const WHEEL_SEGMENTS = \[([\s\S]*?)\n\];/);
  const backendBlock = server.match(/const PRIZES = \[([\s\S]*?)\n\];/);
  assert.ok(frontBlock && backendBlock);
  const frontIds = [...frontBlock[1].matchAll(/id:'([^']+)'/g)].map(x => x[1]).sort();
  const backendIds = [...backendBlock[1].matchAll(/\{\s*id:'([^']+)'/g)].map(x => x[1]).sort();
  assert.deepEqual(frontIds, backendIds);
  assert.match(frontBlock[1], /label:'TRY AGAIN'/);
  assert.match(frontBlock[1], /label:'0 COIN'/);
});

test('spin animation has a long eased deceleration and waits for transition completion', () => {
  assert.match(spin, /transition:transform 8\.2s cubic-bezier\(\.12,\.78,\.08,1\)/);
  assert.match(spin, /transitionend/);
  assert.match(spin, /fallbackTimer = setTimeout\(finishSpin, 8700\)/);
});

test('ineligible earpod outcome becomes a genuine no-prize result, not hidden coins', () => {
  assert.match(server, /if\(!earpodTier\) prize = \{ id:'tryAgain', type:'none' \}/);
  assert.doesNotMatch(server, /if\(!earpodTier\) prize = \{ id:'coins10'/);
});

test('wheel and backend source remain syntactically valid', () => {
  const vm = require('node:vm');
  const scripts = [...spin.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1]).filter(code => code.trim());
  for (const [index, code] of scripts.entries()) {
    assert.doesNotThrow(() => new vm.Script(code), 'spin inline script ' + (index + 1));
  }
  assert.doesNotThrow(() => new vm.Script(server));
});

test('frontend wheel weights exactly match backend prize weights and produce proportional sectors', () => {
  const frontBlock = spin.match(/const WHEEL_SEGMENTS = \[([\s\S]*?)\n\];/);
  const backendBlock = server.match(/const PRIZES = \[([\s\S]*?)\n\];/);
  assert.ok(frontBlock && backendBlock);
  const front = [...frontBlock[1].matchAll(/id:'([^']+)'[^\n]*weight:([\d.]+)/g)]
    .map(row => [row[1], Number(row[2])]).sort((a,b) => a[0].localeCompare(b[0]));
  const backend = [...backendBlock[1].matchAll(/\{\s*id:'([^']+)'\s*,\s*weight:([\d.]+)/g)]
    .map(row => [row[1], Number(row[2])]).sort((a,b) => a[0].localeCompare(b[0]));
  assert.deepEqual(front, backend);
  assert.match(spin, /cumulativeWeight \/ WHEEL_TOTAL_WEIGHT \* 360/);
  assert.match(spin, /conic-gradient\(from 0deg/);
});

test('spin pointer target uses weighted segment midpoint rather than equal slices', () => {
  assert.match(spin, /precedingWeight \+ WHEEL_SEGMENTS\[idx\]\.weight \/ 2/);
  assert.doesNotMatch(spin, /const SEG_ANGLE = 360 \/ WHEEL_SEGMENTS.length/);
});

test('spin button is disabled until verified balance is loaded and whenever balance is below cost', () => {
  assert.match(spin, /currentCoinBalance < SPIN_COST_COINS/);
  assert.match(spin, /currentCoinBalance === null/);
  assert.match(spin, /button\.disabled = IS_PREVIEW_DEPLOYMENT \|\| spinning \|\| balanceUnavailable \|\| insufficientBalance/);
  assert.match(spin, /currentCoinBalance = Number.isFinite\(balance\)/);
});

test('Vercel preview is read-only and routes only to its dedicated preview backend', () => {
  assert.match(spin, /const PRODUCTION_FRONTEND_HOST = 'voltix-pro-gh\.vercel\.app'/);
  assert.match(spin, /window\.location\.hostname\.toLowerCase\(\) !== PRODUCTION_FRONTEND_HOST/);
  assert.match(spin, /const BACKEND = IS_PREVIEW_DEPLOYMENT\s*\? 'https:\/\/spin-backend-e7jyvatrb-nekarakodiya-7935s-projects\.vercel\.app'\s*:\s*'https:\/\/spin-backend-delta\.vercel\.app'/);
  assert.match(spin, /if\(!currentUser \|\| IS_PREVIEW_DEPLOYMENT\) return/);
  assert.match(spin, /if\(IS_PREVIEW_DEPLOYMENT\) return/);
  assert.match(spin, /if\(IS_PREVIEW_DEPLOYMENT\)\{ showToast\('Preview mode: spins are disabled\.'\); return; \}/);
  assert.match(spin, /Preview mode: coin purchases are disabled\./);
  assert.match(spin, /button\.disabled = IS_PREVIEW_DEPLOYMENT \|\| signedOut \|\| spinning/);
});

test('prize selection uses cryptographic integer randomness and preserves every configured weight', () => {
  const vm = require('node:vm');
  const prizeBlock = server.match(/const PRIZES = \[[\s\S]*?\n\];/);
  const pickerBlock = server.match(/function pickPrize\(randomInt = crypto\.randomInt\)\{[\s\S]*?\n\}/);
  assert.ok(prizeBlock && pickerBlock, 'prize table and secure picker exist');
  const sandbox = { crypto: { randomInt: () => 0 }, module: { exports: {} } };
  vm.runInNewContext(prizeBlock[0] + '\n' + pickerBlock[0] + '\nmodule.exports = { PRIZES, pickPrize };', sandbox);
  const { PRIZES, pickPrize } = sandbox.module.exports;
  assert.equal(PRIZES.reduce((sum, prize) => sum + prize.weight, 0), 100);
  let cursor = 0;
  for (const prize of PRIZES) {
    const start = cursor;
    const units = Math.round(prize.weight * 10);
    assert.equal(pickPrize(() => start).id, prize.id);
    assert.equal(pickPrize(() => start + units - 1).id, prize.id);
    cursor += units;
  }
  assert.equal(cursor, 1000);
  assert.equal(pickPrize(() => 999).id, PRIZES[PRIZES.length - 1].id);
});
