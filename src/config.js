'use strict';

const fs = require('fs');
const path = require('path');

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`FATAL: environment variable ${name} is not set. Copy .env.example to .env.`);
    process.exit(1);
  }
  return v;
}

// guacamole-lite encrypts the connection token with AES-256-CBC, which needs a
// key of exactly 32 bytes. This key never leaves the server -- see src/sessions.js
// for why that matters.
const tokenKey = required('TOKEN_ENCRYPTION_KEY');
if (Buffer.byteLength(tokenKey, 'utf8') !== 32) {
  console.error(`FATAL: TOKEN_ENCRYPTION_KEY must be exactly 32 bytes, got ${Buffer.byteLength(tokenKey, 'utf8')}.`);
  process.exit(1);
}

const connectionsPath = path.resolve(__dirname, '..', process.env.CONNECTIONS_FILE || 'connections.json');
let connections = [];
try {
  connections = JSON.parse(fs.readFileSync(connectionsPath, 'utf8'));
} catch (err) {
  console.error(`FATAL: could not read ${connectionsPath}: ${err.message}`);
  console.error('Copy connections.example.json to connections.json and edit it.');
  process.exit(1);
}

module.exports = {
  port: parseInt(process.env.PORT || '8080', 10),
  guacd: {
    host: process.env.GUACD_HOST || '127.0.0.1',
    port: parseInt(process.env.GUACD_PORT || '4822', 10),
  },
  tokenKey,
  connections,

  // How long a minted session handle stays valid before it must be re-requested.
  sessionTtlMs: parseInt(process.env.SESSION_TTL_SECONDS || '60', 10) * 1000,

  // Free-form "connect to any IP" is gated by this. Empty = feature disabled.
  allowedCidrs: (process.env.ALLOWED_CIDRS || '')
    .split(',').map((s) => s.trim()).filter(Boolean),
  allowedPorts: (process.env.ALLOWED_PORTS || '5900,5901')
    .split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n)),

  // 'local'      -> STAGE 1/2. No login. Every request is the same dev user.
  // 'cloudflare' -> STAGE 3. Identity comes from a verified Cloudflare Access JWT.
  authMode: process.env.AUTH_MODE || 'local',
  cfTeamDomain: process.env.CF_ACCESS_TEAM_DOMAIN || '',
  cfAudience: process.env.CF_ACCESS_AUD || '',
};
