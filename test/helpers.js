'use strict';

// Shared fixtures. Every test file runs in its own process (node --test), and
// src/config.js reads the environment once at require time, so each file sets
// its environment first and requires the code under test afterwards.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const KEY = 'test-key-0123456789abcdefghijklm'; // exactly 32 bytes

function writeConnections(conns) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vncgw-'));
  const file = path.join(dir, 'connections.json');
  fs.writeFileSync(file, JSON.stringify(conns));
  return file;
}

function baseEnv(extra = {}) {
  return {
    TOKEN_ENCRYPTION_KEY: KEY,
    CONNECTIONS_FILE: writeConnections([
      { id: 'desk', label: 'Desk', hostname: '192.168.0.213', port: 5900, password: 'S3cr3t-VNC-pw' },
      { id: 'owner-only', label: 'Owner only', hostname: '192.168.0.30', port: 5900, password: 'S3cr3t-VNC-pw', allowedUsers: ['owner@example.com'] },
    ]),
    ALLOWED_CIDRS: '192.168.0.0/24',
    ALLOWED_PORTS: '5900,5901',
    LOG_LEVEL: 'error',
    ...extra,
  };
}

function applyEnv(env) {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
}

// A stand-in for https://<team>.cloudflareaccess.com/cdn-cgi/access/certs,
// serving the public half of a key pair the test signs tokens with.
async function startJwks() {
  const { generateKeyPair, exportJWK, SignJWT } = await import('jose');
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256'); // a key the JWKS does NOT publish
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };

  const server = http.createServer((req, res) => {
    if (req.url === '/certs') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ keys: [jwk] }));
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/certs`;

  async function sign({ email = 'owner@example.com', aud, iss, exp = '5m', kid = 'k1', key = privateKey } = {}) {
    let jwt = new SignJWT({ email })
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuedAt()
      .setExpirationTime(exp);
    if (aud) jwt = jwt.setAudience(aud);
    if (iss) jwt = jwt.setIssuer(iss);
    return jwt.sign(key);
  }

  return { url, sign, otherKey: other.privateKey, close: () => server.close() };
}

module.exports = { KEY, baseEnv, applyEnv, startJwks, writeConnections };
