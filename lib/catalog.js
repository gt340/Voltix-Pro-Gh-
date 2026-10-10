'use strict';
// lib/catalog.js  (identical copy: spin-backend/catalog.js — kept in sync by scripts/sync-shared.js + a test)
// THE server-authoritative package catalogue. Prices and credits are defined here and nowhere
// else. Admin-editable gameSettings values are display hints only; they never change what a
// payment is worth. Values below are the CURRENTLY APPROVED ones (unchanged by Phase 2).

const CATALOG_VERSION = '2026-10-10.1';
const CURRENCY = 'GHS';

const PACKAGES = Object.freeze({
  SPIN_100:   Object.freeze({ id: 'SPIN_100',   legacyId: 'PACKAGE_100', purpose: 'spinCoins', pesewas: 1000, credits: 100, maxQty: 1,  active: true }),
  SPIN_250:   Object.freeze({ id: 'SPIN_250',   legacyId: 'PACKAGE_250', purpose: 'spinCoins', pesewas: 2250, credits: 250, maxQty: 1,  active: true }),
  SPIN_500:   Object.freeze({ id: 'SPIN_500',   legacyId: 'PACKAGE_500', purpose: 'spinCoins', pesewas: 4500, credits: 500, maxQty: 1,  active: true }),
  BALLS_10:   Object.freeze({ id: 'BALLS_10',   purpose: 'balls',     pesewas: 1000, credits: 10, maxQty: 20, active: true }),
  CONTINUE_5: Object.freeze({ id: 'CONTINUE_5', purpose: 'balls',     pesewas: 500,  credits: 5,  maxQty: 1,  active: true, kind: 'continue' }),
  SINK_50:    Object.freeze({ id: 'SINK_50',    purpose: 'sinkCoins', pesewas: 1000, credits: 50, maxQty: 20, active: true }),
});

const WALLET_FIELD = Object.freeze({ spinCoins: 'coins', balls: 'balls', sinkCoins: 'sinkCoins' });

// Accepts current ids and the legacy Spin ids (PACKAGE_100 ...) the old client sends.
function getPackage(id) {
  if (typeof id !== 'string') return null;
  if (Object.prototype.hasOwnProperty.call(PACKAGES, id)) return PACKAGES[id];
  return Object.values(PACKAGES).find((p) => p.legacyId === id) || null;
}

// Exact, server-computed price for a package request. Never trusts caller amounts.
function priceFor(id, qty) {
  const pkg = getPackage(id);
  if (!pkg || !pkg.active) return null;
  const n = qty === undefined ? 1 : qty;
  if (!Number.isInteger(n) || n < 1 || n > pkg.maxQty) return null;
  return {
    pkg, qty: n, currency: CURRENCY, pesewas: pkg.pesewas * n, credits: pkg.credits * n,
    packageId: n === 1 ? pkg.id : pkg.id + '_X' + n,
  };
}

// Reverse lookup used by legacy (intent-less) verification: amount paid -> package.
function resolveByAmount(purpose, pesewas) {
  if (!Number.isInteger(pesewas)) return null;
  const candidates = Object.values(PACKAGES).filter((p) => p.active && p.purpose === purpose);
  for (const p of candidates) {
    if (p.maxQty === 1 && p.pesewas === pesewas) return priceFor(p.id, 1);
  }
  for (const p of candidates) {
    if (p.maxQty > 1 && pesewas % p.pesewas === 0) {
      const r = priceFor(p.id, pesewas / p.pesewas);
      if (r) return r;
    }
  }
  return null;
}

// Compares admin-editable display settings with the authoritative catalogue so a mismatch is
// SHOWN to the admin instead of silently causing "paid but not credited".
function checkDivergence(settings) {
  const s = settings || {};
  const out = [];
  const cmp = (key, setting, expected, label) => {
    if (setting !== undefined && setting !== null && Number(setting) !== expected) {
      out.push({ setting: key, adminValue: Number(setting), authorizedValue: expected, affects: label });
    }
  };
  cmp('ballPriceGhc', s.ballPriceGhc, PACKAGES.BALLS_10.pesewas / 100, 'Foosball balls price');
  cmp('ballPackage', s.ballPackage, PACKAGES.BALLS_10.credits, 'Foosball balls per package');
  cmp('sneakerCoinPriceGhc', s.sneakerCoinPriceGhc, PACKAGES.SINK_50.pesewas / 100, 'Sneaker Sink coin price');
  cmp('sneakerCoinPack', s.sneakerCoinPack, PACKAGES.SINK_50.credits, 'Sneaker Sink coins per package');
  return out;
}

function publicCatalog() {
  return {
    version: CATALOG_VERSION, currency: CURRENCY,
    packages: Object.values(PACKAGES).filter((p) => p.active).map((p) => ({
      id: p.id, legacyId: p.legacyId || null, purpose: p.purpose, amountGhs: p.pesewas / 100,
      credits: p.credits, maxQty: p.maxQty, kind: p.kind || 'standard',
    })),
  };
}

module.exports = { CATALOG_VERSION, CURRENCY, PACKAGES, WALLET_FIELD, getPackage, priceFor, resolveByAmount, checkDivergence, publicCatalog };
