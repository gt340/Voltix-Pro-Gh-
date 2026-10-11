'use strict';
// lib/net.js  (identical copy: spin-backend/net.js)
// Client network identity for abuse limits (the free-spin cap). Design rules:
//  * X-Forwarded-For is client-controlled and is NEVER used.
//  * Platform headers (x-vercel-forwarded-for, x-real-ip) are used ONLY when the caller says it is running behind
//    that platform (opts.trustPlatformHeaders, set from process.env.VERCEL === '1'). Default is "do not trust".
//  * Only PUBLIC addresses are accepted. Missing, malformed, private, loopback, link-local, CGNAT, documentation,
//    multicast and reserved addresses all yield null, so an internal proxy address can never become a bucket that
//    every user shares. A null result means "no network identity": callers must NOT apply a network quota.
//  * IPv6 is bucketed by /64. The result is only ever stored as a keyed hash (see safety.shortHash).

const nodeNet = require('node:net');

function parseV4(s) {
  if (typeof s !== 'string' || !nodeNet.isIPv4(s)) return null;
  const parts = s.split('.');
  if (parts.some((x) => x.length > 1 && x[0] === '0')) return null;       // reject ambiguous leading zeros
  return parts.map(Number);
}

function isPublicV4(p) {
  const [a, b, c] = p;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;                     // CGNAT 100.64/10
  if (a === 169 && b === 254) return false;                               // link-local
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;         // 192.0.0/24, 192.0.2/24
  if (a === 198 && (b === 18 || b === 19)) return false;                  // benchmarking
  if (a === 198 && b === 51 && c === 100) return false;                   // documentation
  if (a === 203 && b === 0 && c === 113) return false;                    // documentation
  if (a >= 224) return false;                                             // multicast + reserved
  return true;
}

function expandV6(input) {
  if (typeof input !== 'string' || !nodeNet.isIPv6(input)) return null;
  let a = input.toLowerCase().split('%')[0];
  const m = a.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (m) {
    const v = parseV4(m[2]);
    if (!v) return null;
    a = m[1] + ((v[0] << 8) | v[1]).toString(16) + ':' + ((v[2] << 8) | v[3]).toString(16);
  }
  const halves = a.split('::');
  if (halves.length === 1) {
    const g = a.split(':');
    return g.length === 8 ? g.map((x) => parseInt(x, 16)) : null;
  }
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...Array(fill).fill('0'), ...tail].map((x) => parseInt(x, 16));
}

// Returns a bucket string for a PUBLIC address, otherwise null.
function normalize(ip) {
  if (typeof ip !== 'string') return null;
  const v = ip.trim();
  const v4 = parseV4(v);
  if (v4) return isPublicV4(v4) ? v4.join('.') : null;
  const g = expandV6(v);
  if (!g || g.some((x) => Number.isNaN(x))) return null;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {           // IPv4-mapped
    const mapped = [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255];
    return isPublicV4(mapped) ? mapped.join('.') : null;
  }
  if (g.every((x) => x === 0)) return null;                               // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return null;     // ::1
  if ((g[0] & 0xfe00) === 0xfc00) return null;                            // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return null;                            // fe80::/10 link-local
  if ((g[0] & 0xff00) === 0xff00) return null;                            // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return null;                    // documentation
  return g.slice(0, 4).map((x) => x.toString(16)).join(':');
}

function firstToken(v) { return v ? String(v).split(',')[0].trim() : null; }

// headers: plain object with lower-case keys (Express req.headers).
function clientIp(headers, socketIp, opts) {
  const h = headers || {};
  const trust = !!(opts && opts.trustPlatformHeaders);
  if (trust) {
    const fromPlatform = normalize(firstToken(h['x-vercel-forwarded-for'])) || normalize(firstToken(h['x-real-ip']));
    if (fromPlatform) return fromPlatform;
  }
  return normalize(socketIp) || null;
}

module.exports = { clientIp, normalize };
