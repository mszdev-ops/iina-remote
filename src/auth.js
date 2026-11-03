// Optional token protection.
// The token can be given as ?token=..., an X-Token header, or Authorization: Bearer ...

import crypto from 'node:crypto';

export function extractToken(req, url) {
  const q = url.searchParams.get('token');
  if (q) return q;
  const x = req.headers['x-token'];
  if (typeof x === 'string' && x) return x;
  const auth = req.headers['authorization'];
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1];
  }
  return null;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** true if no token is configured, or the request's token matches. */
export function isAuthorized(req, url, expectedToken) {
  if (!expectedToken) return true;
  const given = extractToken(req, url);
  return given !== null && safeEqual(given, expectedToken);
}
