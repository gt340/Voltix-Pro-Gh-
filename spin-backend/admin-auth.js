'use strict';

// Resolve an administrator only from a Firebase-verified bearer token and
// the server-side admins/{uid} allowlist. Never trust client-supplied UIDs.
async function resolveAdminUid(req, { verifyIdToken, db }) {
  const header = req && req.headers && req.headers.authorization || '';
  const match = header.match(/^Bearer (.+)$/i);
  if (!match) return null;

  try {
    const decoded = await verifyIdToken(match[1]);
    if (!decoded || typeof decoded.uid !== 'string' || !decoded.uid) return null;
    const adminDoc = await db.collection('admins').doc(decoded.uid).get();
    return adminDoc.exists ? decoded.uid : null;
  } catch (_) {
    return null;
  }
}

module.exports = { resolveAdminUid };
