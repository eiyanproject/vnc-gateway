'use strict';

// Shared fixtures. Every test file runs in its own process (node --test), and
// src/config.js reads the environment once at require time, so each file sets
// its environment first and requires the code under test afterwards.

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

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
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'vncgw-data-')),
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

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// Boots the real server (src/index.js) in a child process and waits for it.
async function startServer(env) {
  const port = await freePort();
  let logs = '';
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
    env: { ...process.env, ...env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => { logs += d; });
  proc.stderr.on('data', (d) => { logs += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) return { base, logs: () => logs, kill: () => proc.kill() }; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error(`server did not start:
${logs}`);
}

// A "guacd" that accepts connections and never answers. guacamole-lite then
// holds the WebSocket open, which keeps a session in the desktop lock -- enough
// to test the lock without a real VNC server.
async function startSilentGuacd() {
  const sockets = [];
  const server = net.createServer((s) => { sockets.push(s); s.on('error', () => {}); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, close: () => { sockets.forEach((s) => s.destroy()); server.close(); } };
}

module.exports = { KEY, baseEnv, applyEnv, startJwks, writeConnections, freePort, startServer, startSilentGuacd };
