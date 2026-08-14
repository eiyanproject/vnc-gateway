'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const GuacamoleLite = require('guacamole-lite');

const config = require('./config');
const { authenticate } = require('./auth');
const { checkTarget } = require('./allowlist');
const sessions = require('./sessions');

const app = express();
app.use(express.json());

app.disable('x-powered-by');
app.use((req, res, next) => {
  // Belt-and-braces. Cloudflare Access will already 302 any crawler to a login
  // page, but this costs nothing and covers the window before that exists.
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  next();
});

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, authMode: config.authMode, guacd: config.guacd });
});

// The browser gets labels and IDs only -- never hostnames or passwords.
app.get('/api/connections', authenticate, (req, res) => {
  res.json({
    user: req.user.email,
    freeformEnabled: config.allowedCidrs.length > 0,
    connections: config.connections.map((c) => ({ id: c.id, label: c.label })),
  });
});

// Mint a session. Body is either { connectionId } or { host, port }.
app.post('/api/sessions', authenticate, (req, res) => {
  const { connectionId, host, port, width, height } = req.body || {};

  if (connectionId) {
    const conn = config.connections.find((c) => c.id === connectionId);
    if (!conn) return res.status(404).json({ error: 'no such connection' });

    // [STAGE 4] Per-user authorisation goes here: check req.user.email against
    // an allowed-users list on the connection before minting.
    return res.json(sessions.mint({
      user: req.user,
      hostname: conn.hostname,
      port: conn.port,
      password: conn.password,
      label: conn.label,
      width, height,
    }));
  }

  if (host) {
    const p = parseInt(port, 10) || 5900;
    const verdict = checkTarget(String(host), p);
    if (!verdict.ok) {
      console.warn(`[allowlist] DENIED ${req.user.email} -> ${host}:${p} (${verdict.reason})`);
      return res.status(403).json({ error: verdict.reason });
    }
    return res.json(sessions.mint({
      user: req.user,
      hostname: String(host),
      port: p,
      password: req.body.password || '',
      label: `ad-hoc ${host}:${p}`,
      width, height,
    }));
  }

  res.status(400).json({ error: 'need connectionId or host' });
});

const server = http.createServer(app);

// Gate the WebSocket upgrade BEFORE guacamole-lite gets a look at it. Node runs
// every 'upgrade' listener in registration order, so destroying the socket here
// means guacamole-lite's handshake lands on a dead socket and goes nowhere.
// This listener must be registered before the GuacamoleLite constructor below.
server.on('upgrade', (req, socket) => {
  const sid = new URL(req.url, 'http://localhost').searchParams.get('sid');
  if (!sessions.claim(sid)) {
    console.warn('[ws] rejected upgrade: missing/expired/replayed sid');
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
  }
});

const guacServer = new GuacamoleLite(
  { server },
  { host: config.guacd.host, port: config.guacd.port },
  {
    crypt: { cypher: 'AES-256-CBC', key: config.tokenKey },

    // Log levels are numeric in guacamole-lite (QUIET 0 / ERRORS 10 / NORMAL 20
    // / VERBOSE 30 / DEBUG 40) and compared numerically -- passing the string
    // 'NORMAL' silently disables logging. 20 is also as high as you want to go
    // in production: the noisier levels dump connection settings, and those
    // contain the VNC password.
    log: { level: 20 },

    // Default is 10s, which is tight once there's a tunnel and a CDN in the
    // path. [STAGE 3: CLOUDFLARE] keep an eye on this if sessions drop when idle.
    maxInactivityTime: 60000,
  }
);

guacServer.on('error', (clientConnection, err) => {
  console.error('[guacd] ' + err.message);
});

server.listen(config.port, () => {
  console.log(`vnc-gateway listening on :${config.port}  (auth=${config.authMode}, guacd=${config.guacd.host}:${config.guacd.port})`);
  if (config.authMode === 'local') {
    console.log('  !! AUTH_MODE=local -- no login. Do not expose this beyond your LAN.');
  }
});
