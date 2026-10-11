'use strict';
// lib/net.js  (identical copy: spin-backend/net.js)
// Client network identity for abuse limits. Only platform-set headers are trusted; a raw
// X-Forwarded-For value is client-controlled and is NEVER used. IPv6 is bucketed by /64 so that
// one household cannot rotate through its whole prefix. The result is only ever stored hashed.

const IPV4 = /^(\d{1,3})(\.\d{1,3}){3}$/;

function normalize(ip) {
  if (typeof ip !== 'string') return null;
  const v = ip.trim().replace(/^::ffff:/i, '');
  if (IPV4.test(v)) return v;
  if (v.includes(':')) {
    const groups = v.toLowerCase().split(':');
    if (groups.includes('')) {                    // expand '::'
      const head = v.toLowerCase().split('::')[0].split(':').filter(Boolean);
      return head.slice(0, 4).join(':') || null;
    }
    return groups.slice(0, 4).join(':');
  }
  return null;
}

// headers: plain object with lower-case keys (Express req.headers).
function clientIp(headers, socketIp) {
  const h = headers || {};
  const trusted = h['x-vercel-forwarded-for'] || h['x-real-ip'];
  const first = trusted ? String(trusted).split(',')[0] : null;
  return normalize(first) || normalize(socketIp) || null;
}

module.exports = { clientIp, normalize };
