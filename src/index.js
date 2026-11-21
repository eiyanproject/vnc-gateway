'use strict';

const http = require('http');
const net = require('net');
const path = require('path');
const { EventEmitter } = require('events');
const express = require('express');
const GuacamoleLite = require('guacamole-lite');

const config = require('./config');
const log = require('./log');
const metrics = require('./metrics');
const guard = require('./guard');
const { checkTarget } = require('./allowlist');
const sessions = require('./sessions');
const profiles = require('./profiles');
const { createLimiter } = require('./ratelimit');

const limitSessions = createLimiter({ perMinute: config.sessionsPerMinute });

// Saved connections may name who can use them. LAN callers have no identity to
// check against and are trusted the same way learnbox trusts them; the list
// constrains people arriving through Cloudflare Access.
function canUse(identity, conn) {
  if (!conn.allowedUsers) return true;
  if (identity.via === 'lan') return true;
  return conn.allowedUsers.includes(identity.email);
}

const app = express();
app.disable('x-powered-by');

// ---------------------------------------------------------------- metrics/log
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const route = req.route ? req.route.path : (res.locals.route || 'unmatched');
    const secs = Number(process.hrtime.bigint() - start) / 1e9;
    metrics.requests.inc({ route, method: req.method, status: String(res.statusCode) });
    metrics.duration.observe({ route }, secs);
    // Log changes and failures. Successful reads would drown everything else.
    if (req.method !== 'GET' || res.statusCode >= 400) {
      const level = res.statusCode >= 500 ? 'error' : 'info';
      log[level]('request', { route, method: req.method, status: res.statusCode, dur_ms: Math.round(secs * 1000) });
    }
  });
  next();
});

// ---------------------------------------------------------------- the gate
app.use(async (req, res, next) => {
  let v;
  try {
    v = await guard.evaluate(req);
  } catch (err) {
    metrics.errors.inc({ kind: 'internal' });
    log.error('guard failed', { error: err.message });
    res.locals.route = 'guard';
    return res.status(500).json({ error: 'internal error' });
  }
  if (!v.ok) {
    metrics.errors.inc({ kind: v.kind });
    log.warn('request refused', {
      host: guard.hostOnly(req.headers.host).slice(0, 100), path: req.path.slice(0, 100),
      status: v.status, kind: v.kind, reason: v.reason,
    });
    res.locals.route = 'guard';
    return res.status(v.status).json({ error: v.error });
  }
  req.identity = v.identity;

  // Drive-by POSTs: a custom header cannot be sent cross-site without a CORS
  // preflight, which is never approved. Origin is checked as well because it
  // costs nothing and covers clients that do send it.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (req.headers['x-vncgw'] !== '1' || !guard.originMatches(req)) {
      metrics.errors.inc({ kind: 'csrf_rejected' });
      res.locals.route = 'guard';
      return res.status(403).json({ error: 'cross-site request refused' });
    }
  }
  next();
});

app.use((req, res, next) => {
  const host = req.headers.host;
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Frame-Options', 'DENY');
  // ws:/wss: listed explicitly: older Safari does not treat them as 'self'.
  res.set('Content-Security-Policy', [
    "default-src 'self'",
    `connect-src 'self' ws://${host} wss://${host}`,
    "img-src 'self' data: blob:",
    "script-src 'self'",
    "style-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; '));
  next();
});

// Bodies are parsed only for requests that already passed the gate.
app.use(express.json({ limit: '8kb' }));

// ----------------------------------------------------------- service contract
app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', version: config.version });
});

function guacdReachable(timeoutMs = 2000) {
  return new Promise((resolve) => {
    const sock = net.connect(config.guacd.port, config.guacd.host);
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

app.get('/readyz', async (req, res) => {
  const problems = [];
  if (!(await guacdReachable())) problems.push(`guacd unreachable at ${config.guacd.host}:${config.guacd.port}`);
  if (config.accessHosts.length && !guard.accessConfigured) {
    problems.push('ACCESS_HOSTS is set without ACCESS_TEAM_DOMAIN and ACCESS_AUD');
  }
  if (!profiles.writable()) problems.push(`data directory ${config.dataDir} is not writable`);
  if (problems.length) {
    metrics.errors.inc({ kind: 'not_ready' });
    return res.status(503).json({ status: 'unavailable', problems });
  }
  res.json({ status: 'ready' });
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', metrics.register.contentType);
  res.end(await metrics.register.metrics());
});

// ------------------------------------------------------------------------ API
// Whether this desktop is open right now, from the caller's point of view.
function busyFor(identity, hostname, port) {
  const occ = sessions.occupant(sessions.targetKey(hostname, port));
  if (!occ) return null;
  return { since: new Date(occ.since).toISOString(), mine: sessions.sameIdentity(occ.identity, identity) };
}

// Shared connections arrive as labels and IDs only -- never their hostnames or
// passwords. Profiles are the caller's own, so host and port are included.
app.get('/api/connections', (req, res) => {
  const id = req.identity;
  res.set('Cache-Control', 'no-store');
  res.json({
    user: id.email,
    via: id.via,
    freeformEnabled: config.allowedCidrs.length > 0,
    recording: config.recording.enabled,
    idleTimeoutSeconds: Math.round(config.idleTimeoutMs / 1000),
    connections: config.connections
      .filter((c) => canUse(id, c))
      .map((c) => ({ id: c.id, label: c.label, busy: busyFor(id, c.hostname, c.port) })),
    profiles: profiles.list(id)
      .map((p) => ({ id: p.id, name: p.name, host: p.host, port: p.port, busy: busyFor(id, p.host, p.port) })),
  });
});

// Kept profiles. Only name, host and port are read from the body: a password
// sent along has nowhere to go.
app.post('/api/profiles', (req, res) => {
  const b = req.body || {};
  const r = profiles.create(req.identity, { name: b.name, host: b.host, port: b.port });
  if (r.error) return res.status(r.status).json({ error: r.error });
  log.info('profile kept', { user: req.identity.email, via: req.identity.via, target: `${r.profile.host}:${r.profile.port}` });
  res.status(201).json(r.profile);
});

app.patch('/api/profiles/:id', (req, res) => {
  const r = profiles.rename(req.identity, req.params.id, (req.body || {}).name);
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.json(r.profile);
});

app.delete('/api/profiles/:id', (req, res) => {
  const r = profiles.remove(req.identity, req.params.id);
  if (r.error) return res.status(r.status).json({ error: r.error });
  log.info('profile removed', { user: req.identity.email, via: req.identity.via });
  res.status(204).end();
});

// Mint a session. Body: { connectionId } | { profileId, password } | { host, port, password }.
app.post('/api/sessions', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const id = req.identity;
  const key = id.via === 'access' ? `a:${id.email}` : `l:${req.socket.remoteAddress}`;
  const rl = limitSessions(key);
  if (!rl.ok) {
    metrics.errors.inc({ kind: 'rate_limited' });
    log.warn('session rate limited', { user: id.email, via: id.via });
    res.set('Retry-After', String(rl.retryAfter));
    return res.status(429).json({ error: `too many session requests; retry in ${rl.retryAfter}s` });
  }

  const b = req.body || {};
  const password = typeof b.password === 'string' ? b.password.slice(0, 256) : '';
  let target;

  if (b.connectionId) {
    const conn = config.connections.find((c) => c.id === b.connectionId);
    // Not permitted and not existing answer the same, so the list of saved
    // connections cannot be probed by someone who may not see it.
    if (!conn || !canUse(id, conn)) {
      metrics.errors.inc({ kind: 'connection_denied' });
      log.warn('session denied', { user: id.email, via: id.via, connectionId: String(b.connectionId).slice(0, 60) });
      return res.status(404).json({ error: 'no such connection' });
    }
    target = { hostname: conn.hostname, port: conn.port, password: conn.password, label: conn.label, kind: 'saved' };
  } else if (b.profileId) {
    const p = profiles.get(id, String(b.profileId));
    if (!p) return res.status(404).json({ error: 'no such profile' });
    target = { hostname: p.host, port: p.port, password, label: p.name, kind: 'freeform' };
  } else if (b.host) {
    const p = parseInt(b.port, 10) || 5900;
    target = { hostname: String(b.host), port: p, password, label: `${b.host}:${p}`, kind: 'freeform' };
  } else {
    return res.status(400).json({ error: 'need connectionId, profileId or host' });
  }

  // Checked on every connect, not only when a profile is kept: ALLOWED_CIDRS
  // may have been narrowed since.
  if (target.kind === 'freeform') {
    const verdict = checkTarget(target.hostname, target.port);
    if (!verdict.ok) {
      metrics.errors.inc({ kind: 'allowlist_denied' });
      log.warn('session denied', { user: id.email, via: id.via, target: `${target.hostname.slice(0, 60)}:${target.port}`, reason: verdict.reason });
      return res.status(403).json({ error: verdict.reason });
    }
  }

  // One session per desktop. Your own open session is taken over at connect
  // time; someone else's is a refusal.
  const busy = busyFor(id, target.hostname, target.port);
  if (busy && !busy.mine) {
    metrics.errors.inc({ kind: 'target_busy' });
    log.warn('session denied', { user: id.email, via: id.via, target: `${target.hostname}:${target.port}`, reason: 'desktop in use' });
    return res.status(409).json({ error: 'This desktop is already in use by someone else.', since: busy.since });
  }

  res.json(sessions.mint({ identity: id, ...target, width: b.width, height: b.height }));
});

app.use((req, res, next) => { res.locals.route = 'static'; next(); });
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

// ------------------------------------------------------------------ websocket
// guacamole-lite is handed a stand-in "server" that only ever emits upgrades we
// have already accepted. The gate is async (it may fetch Access signing keys),
// and Node runs 'upgrade' listeners synchronously, so attaching guacamole-lite
// to the real server would let it handshake before the verdict arrived.
const server = http.createServer(app);
const acceptedUpgrades = new EventEmitter();

function refuseUpgrade(socket, status, kind, fields) {
  metrics.errors.inc({ kind });
  log.warn('websocket refused', { status, kind, ...fields });
  if (!socket.destroyed) {
    socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
}

server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => {}); // a client hanging up mid-check is not a crash
  (async () => {
    const v = await guard.evaluate(req);
    if (!v.ok) return refuseUpgrade(socket, v.status, v.kind, { reason: v.reason });
    if (!guard.originMatches(req)) {
      return refuseUpgrade(socket, 403, 'origin_rejected', { origin: String(req.headers.origin).slice(0, 100) });
    }
    const sid = new URL(req.url, 'http://placeholder').searchParams.get('sid');
    const c = sessions.claim(sid, v.identity);
    if (!c.ok) return refuseUpgrade(socket, 401, 'sid_rejected', { reason: c.reason, user: v.identity.email });

    // Re-checked here, not only at mint: two handles for one desktop can be
    // minted before either is used.
    const r = sessions.reserve(c.entry.target, v.identity, socket);
    if (!r.ok) return refuseUpgrade(socket, 409, 'target_busy', { user: v.identity.email, target: c.entry.target });

    metrics.sessionsTotal.inc({ kind: c.entry.kind });
    log.info('session opened', {
      user: v.identity.email, via: v.identity.via, target: c.entry.target, label: c.entry.label, took_over: r.tookOver,
    });
    // Replace whatever the client sent with the token minted for this sid.
    // guacamole-lite reads only req.url, so nothing client-supplied reaches it.
    req.url = `/?token=${encodeURIComponent(c.entry.guacToken)}`;
    acceptedUpgrades.emit('upgrade', req, socket, head);
  })().catch((err) => {
    log.error('upgrade failed', { error: err.message });
    refuseUpgrade(socket, 500, 'internal', {});
  });
});

const guacServer = new GuacamoleLite(
  { server: acceptedUpgrades },
  { host: config.guacd.host, port: config.guacd.port },
  {
    crypt: { cypher: 'AES-256-CBC', key: config.tokenKey },
    // Numeric levels, compared numerically. Anything above 20 (NORMAL) dumps
    // connection settings, and those contain the VNC password.
    log: {
      level: 10,
      stdLog: (...a) => log.debug('guacamole-lite', { detail: a.join(' ').slice(0, 300) }),
      errorLog: (...a) => log.warn('guacamole-lite', { detail: a.join(' ').slice(0, 300) }),
    },
    // Default is 10s, tight with a tunnel and a CDN in the path. The client
    // pings every 500 ms anyway, so this only fires on a truly dead peer.
    maxInactivityTime: 60000,
  }
);

let active = 0;
guacServer.on('open', (conn) => {
  active += 1;
  metrics.activeSessions.set(active);
  // Hand the live connection to the lock, so it can watch for input and close
  // it on idle or takeover. Keyed by target: the lock allows one per desktop.
  const s = conn.connectionSettings && conn.connectionSettings.connection;
  if (s) sessions.attach(sessions.targetKey(s.hostname, s.port), conn);
});
guacServer.on('close', () => { active = Math.max(0, active - 1); metrics.activeSessions.set(active); });
guacServer.on('error', (conn, err) => {
  metrics.errors.inc({ kind: 'guacd' });
  log.warn('guacd connection error', { error: err && err.message ? err.message : String(err) });
});

// Server-side, so an unattended tab cannot hold a desktop: the browser warns
// first, but this is what actually ends it.
setInterval(() => {
  for (const e of sessions.sweepIdle(config.idleTimeoutMs)) {
    log.info('session closed for inactivity', { user: e.identity.email, via: e.identity.via, target: e.target });
  }
}, Math.min(10_000, Math.max(1000, config.idleTimeoutMs / 4 || 10_000))).unref();

server.listen(config.port, () => {
  log.info('listening', {
    port: config.port,
    version: config.version,
    commit: config.commit,
    guacd: `${config.guacd.host}:${config.guacd.port}`,
    allowed_hosts: config.allowedHosts,
    access_hosts: config.accessHosts,
    access: config.accessHosts.length ? (guard.accessConfigured ? 'enforced' : 'UNCONFIGURED - access hosts answer 503') : 'no public hostnames',
    freeform_cidrs: config.allowedCidrs,
    recording: config.recording.enabled,
  });
});

// A crash should still arrive as one JSON line, then let Docker restart us.
process.on('uncaughtException', (err) => {
  log.error('uncaught exception', { error: err.message, stack: String(err.stack).split('\n').slice(0, 6).join(' | ') });
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  log.error('unhandled rejection', { error: err && err.message ? err.message : String(err) });
});

function shutdown(sig) {
  log.info('shutting down', { signal: sig });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
