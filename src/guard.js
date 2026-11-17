'use strict';

// One gate, applied identically to plain HTTP requests and to WebSocket
// upgrades. Returns a verdict instead of writing a response, so both callers
// can use it.
//
//   1. Host guard. IP literals, localhost and ALLOWED_HOSTS are LAN names;
//      ACCESS_HOSTS are public names. Anything else is 421 -- that is the DNS
//      rebinding defence for a service with no login on the LAN.
//   2. Access. A request for a public name must carry a valid Cloudflare
//      Access JWT. Public names with no team/audience configured answer 503:
//      a half-finished setup fails closed rather than serving a desktop.
//
// LAN by IP keeps working without a token, exactly like learnbox.

const net = require('net');
const config = require('./config');
const { createVerifier, tokenFrom } = require('./access');

const verifier = createVerifier({
  teamDomain: config.accessTeamDomain,
  audience: config.accessAud,
  certsUrl: config.accessCertsUrl,
});

const lanHosts = new Set(['localhost', ...config.allowedHosts]);
const accessHosts = new Set(config.accessHosts);

function hostOnly(hostHeader) {
  if (!hostHeader) return '';
  let h = String(hostHeader).trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']')); // [::1]:8080
  const i = h.lastIndexOf(':');
  if (i !== -1 && h.indexOf(':') === i) h = h.slice(0, i); // name:port, not bare IPv6
  return h;
}

function deny(status, error, kind) {
  return { ok: false, status, error, kind };
}

async function evaluate(req) {
  const host = hostOnly(req.headers.host);

  if (accessHosts.has(host)) {
    if (!verifier) {
      return deny(503, 'this hostname requires Cloudflare Access verification, which is not configured', 'access_unconfigured');
    }
    try {
      const email = await verifier.verify(tokenFrom(req));
      return { ok: true, host, identity: { email, via: 'access' } };
    } catch (err) {
      return { ...deny(403, 'access denied', err.kind || 'access_denied'), reason: err.message };
    }
  }

  if (net.isIP(host) || lanHosts.has(host)) {
    return { ok: true, host, identity: { email: 'lan', via: 'lan' } };
  }

  return deny(421, `unknown host "${host.slice(0, 100)}"; add LAN names to ALLOWED_HOSTS, or public names served through Cloudflare Access to ACCESS_HOSTS (with ACCESS_TEAM_DOMAIN and ACCESS_AUD)`, 'host_rejected');
}

// A browser always sends Origin on a WebSocket handshake and on fetch POSTs.
// WebSockets are not covered by CORS at all, so without this a page on any
// site could try to drive the gateway from a victim's browser.
function originMatches(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser client: Host guard and sid still apply
  try {
    return new URL(origin).host.toLowerCase() === String(req.headers.host || '').toLowerCase();
  } catch {
    return false;
  }
}

module.exports = {
  evaluate,
  originMatches,
  hostOnly,
  accessConfigured: Boolean(verifier),
};
