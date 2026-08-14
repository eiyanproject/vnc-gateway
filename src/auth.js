'use strict';

const config = require('./config');

// ---------------------------------------------------------------------------
// STAGE 1 + 2 (local): no login at all. Every request is the same dev user.
// This is safe *only* because the app is not reachable from outside your LAN.
// ---------------------------------------------------------------------------
function localIdentity() {
  return { email: 'dev@localhost', mode: 'local' };
}

// ---------------------------------------------------------------------------
// [STAGE 3: CLOUDFLARE] Identity from Cloudflare Access.
//
// When a request passes an Access policy, Cloudflare injects a signed JWT into
// the Cf-Access-Jwt-Assertion header. Verifying it here is what makes the gate
// real: cloudflared already restricts who can reach the origin, but without
// this check, anything that *does* reach the origin is unauthenticated.
//
// Two claims matter:
//   - signature, against https://<team>.cloudflareaccess.com/cdn-cgi/access/certs
//   - `aud`, which must equal YOUR application's AUD tag. Skipping this means a
//     token minted for any other app in your Cloudflare account is accepted here.
// ---------------------------------------------------------------------------
let jwksCache = null;
let joseCache = null;

async function cloudflareIdentity(req) {
  if (!config.cfTeamDomain || !config.cfAudience) {
    throw new Error('AUTH_MODE=cloudflare requires CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD');
  }

  // Required lazily so STAGE 1 never needs to touch the network.
  if (!joseCache) joseCache = require('jose');
  const { createRemoteJWKSet, jwtVerify } = joseCache;

  if (!jwksCache) {
    jwksCache = createRemoteJWKSet(
      new URL(`https://${config.cfTeamDomain}/cdn-cgi/access/certs`)
    );
  }

  const token =
    req.headers['cf-access-jwt-assertion'] ||
    (req.headers.cookie || '').match(/(?:^|;\s*)CF_Authorization=([^;]+)/)?.[1];

  if (!token) throw new Error('missing Cloudflare Access token');

  const { payload } = await jwtVerify(token, jwksCache, {
    issuer: `https://${config.cfTeamDomain}`,
    audience: config.cfAudience,
  });

  return { email: payload.email, mode: 'cloudflare' };
}

// Express middleware. Attaches req.user or rejects.
async function authenticate(req, res, next) {
  try {
    req.user = config.authMode === 'cloudflare'
      ? await cloudflareIdentity(req)
      : localIdentity();
    next();
  } catch (err) {
    console.warn(`auth rejected: ${err.message}`);
    res.status(401).json({ error: 'unauthorized' });
  }
}

module.exports = { authenticate };
