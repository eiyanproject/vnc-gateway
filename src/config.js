'use strict';

const fs = require('fs');
const path = require('path');
const log = require('./log');

function fatal(msg) {
  log.error('fatal configuration error', { error: msg });
  process.exit(1);
}

function required(name) {
  const v = process.env[name];
  if (!v) fatal(`environment variable ${name} is not set. Copy .env.example to .env.`);
  return v;
}

function list(name, { lower = false } = {}) {
  return (process.env[name] || '')
    .split(',')
    .map((s) => s.trim())
    .map((s) => (lower ? s.toLowerCase() : s))
    .filter(Boolean);
}

const pkg = require('../package.json');

// guacamole-lite encrypts the connection token with AES-256-CBC, which needs a
// key of exactly 32 bytes. This key never leaves the server -- see sessions.js.
const tokenKey = required('TOKEN_ENCRYPTION_KEY');
if (Buffer.byteLength(tokenKey, 'utf8') !== 32) {
  fatal(`TOKEN_ENCRYPTION_KEY must be exactly 32 bytes, got ${Buffer.byteLength(tokenKey, 'utf8')}`);
}

// ---------------------------------------------------------------- connections
const connectionsPath = path.resolve(__dirname, '..', process.env.CONNECTIONS_FILE || 'connections.json');
let connections;
try {
  connections = JSON.parse(fs.readFileSync(connectionsPath, 'utf8'));
} catch (err) {
  fatal(`could not read ${connectionsPath}: ${err.message}. Copy connections.example.json to connections.json.`);
}
if (!Array.isArray(connections)) fatal('connections.json must be a JSON array');
const seen = new Set();
for (const c of connections) {
  if (!c || typeof c.id !== 'string' || !c.id) fatal('every connection needs a string "id"');
  if (seen.has(c.id)) fatal(`duplicate connection id "${c.id}"`);
  seen.add(c.id);
  if (typeof c.hostname !== 'string' || !c.hostname) fatal(`connection "${c.id}" needs a "hostname"`);
  const p = Number(c.port || 5900);
  if (!Number.isInteger(p) || p < 1 || p > 65535) fatal(`connection "${c.id}" has an invalid port`);
  c.port = p;
  c.label = c.label || c.id;
  if (c.allowedUsers !== undefined) {
    if (!Array.isArray(c.allowedUsers) || c.allowedUsers.some((u) => typeof u !== 'string')) {
      fatal(`connection "${c.id}": "allowedUsers" must be an array of email addresses`);
    }
    c.allowedUsers = c.allowedUsers.map((u) => u.trim().toLowerCase());
  }
}

// ------------------------------------------------------------------ allowlist
const allowedCidrs = list('ALLOWED_CIDRS');
// A malformed CIDR would otherwise silently match nothing, which looks exactly
// like a working-but-strict allowlist. Refuse to start instead.
for (const c of allowedCidrs) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(c);
  if (!m || m.slice(1, 5).some((o) => Number(o) > 255) || Number(m[5]) > 32) {
    fatal(`ALLOWED_CIDRS entry "${c}" is not an IPv4 CIDR like 192.168.0.0/24`);
  }
}

// ------------------------------------------------------------- hosts / Access
// Hostnames this app will answer to. IP literals and "localhost" are always
// accepted; anything else must be listed. That refusal is what stops DNS
// rebinding: a page on evil.example that re-resolves to this box would
// otherwise be same-origin with a desktop.
const allowedHosts = list('ALLOWED_HOSTS', { lower: true });

// Public hostnames served through Cloudflare Access. Requests for them must
// carry a valid Access JWT; LAN access by IP keeps working without one.
const accessHosts = list('ACCESS_HOSTS', { lower: true });
const accessTeamDomain = (process.env.ACCESS_TEAM_DOMAIN || '')
  .trim().replace(/^https?:\/\//, '').replace(/\/+$/, '').toLowerCase();
const accessAud = (process.env.ACCESS_AUD || '').trim();

// Minutes without mouse or keyboard input before a session is closed. 0 = never.
const idleTimeoutMinutes = parseFloat(process.env.IDLE_TIMEOUT_MINUTES || '15');
if (!Number.isFinite(idleTimeoutMinutes) || idleTimeoutMinutes < 0) {
  fatal(`IDLE_TIMEOUT_MINUTES must be a number of minutes (0 disables), got "${process.env.IDLE_TIMEOUT_MINUTES}"`);
}

if (process.env.AUTH_MODE) {
  log.warn('AUTH_MODE is obsolete and ignored', {
    hint: 'Cloudflare Access is now per hostname: set ACCESS_HOSTS, ACCESS_TEAM_DOMAIN and ACCESS_AUD',
  });
}

module.exports = {
  version: pkg.version,
  commit: process.env.VNCGW_COMMIT || 'unknown',
  port: parseInt(process.env.PORT || '8080', 10),
  guacd: {
    host: process.env.GUACD_HOST || '127.0.0.1',
    port: parseInt(process.env.GUACD_PORT || '4822', 10),
  },
  tokenKey,
  connections,

  sessionTtlMs: parseInt(process.env.SESSION_TTL_SECONDS || '60', 10) * 1000,
  sessionsPerMinute: parseInt(process.env.SESSIONS_PER_MINUTE || '20', 10),
  idleTimeoutMs: Math.round(idleTimeoutMinutes * 60_000),

  // Writable volume for kept profiles. Everything else in the container is
  // read-only.
  dataDir: path.resolve(__dirname, '..', process.env.DATA_DIR || 'data'),
  maxProfiles: 50,

  allowedCidrs,
  allowedPorts: list('ALLOWED_PORTS').length
    ? list('ALLOWED_PORTS').map((s) => parseInt(s, 10)).filter((n) => Number.isInteger(n))
    : [5900, 5901],

  allowedHosts,
  accessHosts,
  accessTeamDomain,
  accessAud,
  // Only for tests. Production derives it from the team domain.
  accessCertsUrl: process.env.ACCESS_CERTS_URL || (accessTeamDomain ? `https://${accessTeamDomain}/cdn-cgi/access/certs` : ''),

  // Session recording is written by guacd, into the volume mounted at this
  // path in the guacd container. Off unless asked for.
  recording: {
    enabled: process.env.RECORDING === '1',
    path: '/recordings',
  },
};
