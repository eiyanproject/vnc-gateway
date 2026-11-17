'use strict';

// Cloudflare Access verification, so a public hostname is protected by this
// app itself and not only by the edge configuration. Same model as learnbox's
// internal/access: if the Access application is ever deleted, misconfigured or
// bypassed, requests arrive without a valid token and are refused here.
//
// Cloudflare signs every request it lets through with an RS256 JWT in the
// Cf-Access-Jwt-Assertion header (and the CF_Authorization cookie). Keys are
// published at https://<team>/cdn-cgi/access/certs; jose caches them and
// re-fetches when it sees an unknown key id, which is how rotation works.
//
// Three checks matter: the signature, `iss` == https://<team>, and `aud`
// containing THIS application's AUD tag. Skipping the audience means a token
// minted for any other Access app in the account is accepted here.

const { createRemoteJWKSet, jwtVerify } = require('jose');

const HEADER = 'cf-access-jwt-assertion';
const COOKIE = 'CF_Authorization';

function tokenFrom(req) {
  const h = req.headers[HEADER];
  if (h) return String(h);
  const m = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(req.headers.cookie || '');
  return m ? m[1] : '';
}

function createVerifier({ teamDomain, audience, certsUrl }) {
  if (!teamDomain || !audience || !certsUrl) return null;
  const jwks = createRemoteJWKSet(new URL(certsUrl), {
    timeoutDuration: 10_000,
    cacheMaxAge: 60 * 60 * 1000,
  });
  return {
    async verify(token) {
      if (!token) {
        const e = new Error('no Cloudflare Access token');
        e.kind = 'access_no_token';
        throw e;
      }
      try {
        const { payload } = await jwtVerify(token, jwks, {
          algorithms: ['RS256'],
          issuer: `https://${teamDomain}`,
          audience,
          clockTolerance: 60,
        });
        if (!payload.email) {
          const e = new Error('token has no email claim');
          e.kind = 'access_denied';
          throw e;
        }
        return String(payload.email).toLowerCase();
      } catch (err) {
        if (!err.kind) err.kind = err.code === 'ERR_JWKS_TIMEOUT' ? 'access_keys_unavailable' : 'access_denied';
        throw err;
      }
    },
  };
}

module.exports = { createVerifier, tokenFrom, COOKIE };
