'use strict';

const config = require('./config');

// Free-form "type any IP" turns this gateway into a pivot box: anyone who gets
// past the front door can reach anything it can reach. So the free-form path is
// restricted to explicit CIDRs and ports, and refuses hostnames entirely --
// a hostname would let an attacker point DNS wherever they liked (and re-point
// it between our check and guacd's connect: classic DNS rebinding).
//
// Saved connections in connections.json bypass this on purpose: you defined
// them, so they are trusted by definition.

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function toInt(ip) {
  const m = IPV4.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function inCidr(ip, cidr) {
  const [base, bitsRaw] = cidr.split('/');
  const bits = parseInt(bitsRaw, 10);
  const ipInt = toInt(ip);
  const baseInt = toInt(base);
  if (ipInt === null || baseInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false;
  }
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

// Returns { ok: true } or { ok: false, reason: string }.
function checkTarget(host, port) {
  if (config.allowedCidrs.length === 0) {
    return { ok: false, reason: 'free-form targets are disabled (ALLOWED_CIDRS is empty)' };
  }
  if (toInt(host) === null) {
    return { ok: false, reason: 'target must be a literal IPv4 address, not a hostname' };
  }
  if (!config.allowedPorts.includes(port)) {
    return { ok: false, reason: `port ${port} is not in ALLOWED_PORTS` };
  }
  if (!config.allowedCidrs.some((c) => inCidr(host, c))) {
    return { ok: false, reason: `${host} is not within ALLOWED_CIDRS` };
  }
  return { ok: true };
}

module.exports = { checkTarget };
