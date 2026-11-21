'use strict';

// Boots the real server (src/index.js) in a child process and drives it over
// HTTP and WebSocket. guacd is deliberately absent: everything here is about the
// gate in front of it. test/e2e covers real pixels.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const { baseEnv, startJwks } = require('../helpers');

const TEAM = 'team.cloudflareaccess.com';
const AUD = 'aud-0123456789abcdef';
const PUBLIC = 'vnc.example.com';
const SECRET = 'S3cr3t-VNC-pw';

let proc;
let base;
let jwks;
let logs = '';
let dataDir;

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

test.before(async () => {
  jwks = await startJwks();
  const port = await freePort();
  const deadGuacd = await freePort(); // nothing listens here
  base = `http://127.0.0.1:${port}`;
  const env = baseEnv({
    PORT: String(port),
    GUACD_HOST: '127.0.0.1',
    GUACD_PORT: String(deadGuacd),
    ALLOWED_HOSTS: 'vnc-gateway',
    ACCESS_HOSTS: PUBLIC,
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    ACCESS_CERTS_URL: jwks.url,
    SESSIONS_PER_MINUTE: '40',
    LOG_LEVEL: 'debug',
  });
  dataDir = env.DATA_DIR;
  proc = spawn(process.execPath, [path.join(__dirname, '..', '..', 'src', 'index.js')], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => { logs += d; });
  proc.stderr.on('data', (d) => { logs += d; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start:\n${logs}`);
});

test.after(() => { proc.kill(); jwks.close(); });

const token = (email = 'owner@example.com') => jwks.sign({ email, aud: AUD, iss: `https://${TEAM}` });

// fetch() will not let us set Host, so go through http.request for that.
function request(method, urlPath, { host, headers = {}, body } = {}) {
  const http = require('http');
  const u = new URL(base + urlPath);
  return new Promise((resolve, reject) => {
    const req = http.request({
      method, hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: { host: host || u.host, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text: data, json });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const post = (body, opts = {}) => request('POST', '/api/sessions', { body, ...opts, headers: { 'x-vncgw': '1', ...(opts.headers || {}) } });

function ws({ sid, host, origin, headers = {} }) {
  const u = new URL(base);
  return new Promise((resolve) => {
    const sock = new WebSocket(`ws://${u.host}/?token=x&sid=${encodeURIComponent(sid || '')}`, {
      headers: { host: host || u.host, ...(origin ? { origin } : {}), ...headers },
    });
    const done = (r) => { try { sock.terminate(); } catch { /* gone */ } resolve(r); };
    sock.on('open', () => done(101));
    sock.on('unexpected-response', (_req, res) => done(res.statusCode));
    sock.on('error', () => done('error'));
    setTimeout(() => done('timeout'), 5000);
  });
}

// ------------------------------------------------------------------ contract
test('/healthz answers with the version', async () => {
  const r = await request('GET', '/healthz');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { status: 'ok', version: require('../../package.json').version });
});

test('/readyz reports guacd unreachable', async () => {
  const r = await request('GET', '/readyz');
  assert.equal(r.status, 503);
  assert.match(r.json.problems.join(' '), /guacd unreachable/);
});

test('/metrics exposes the contract metrics', async () => {
  await request('GET', '/', { host: 'evil.example' }); // produce one host_rejected
  const r = await request('GET', '/metrics');
  assert.equal(r.status, 200);
  for (const m of ['vncgw_build_info{version=', 'vncgw_requests_total', 'vncgw_request_duration_seconds_bucket', 'vncgw_errors_total{kind="host_rejected"}', 'vncgw_active_sessions']) {
    assert.ok(r.text.includes(m), m);
  }
  // route templates only: no raw paths or hosts as label values
  assert.ok(!/route="\/api\/sessions\/[^"]/.test(r.text));
  assert.ok(!r.text.includes('evil.example'));
});

// ---------------------------------------------------------------- the gate
test('unknown Host is 421, even for /healthz', async () => {
  assert.equal((await request('GET', '/healthz', { host: 'evil.example' })).status, 421);
});

test('security headers are set', async () => {
  const r = await request('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(r.headers['content-security-policy'], /script-src 'self'/);
  assert.equal(r.headers['x-frame-options'], 'DENY');
  assert.equal(r.headers['x-robots-tag'], 'noindex, nofollow');
  assert.equal(r.headers['x-powered-by'], undefined);
});

test('the public hostname needs a token for everything, static files included', async () => {
  for (const p of ['/', '/healthz', '/api/connections', '/vendor/guacamole-common.js']) {
    assert.equal((await request('GET', p, { host: PUBLIC })).status, 403, p);
  }
});

test('connection list: labels only, filtered by allowedUsers for Access users', async () => {
  const lan = await request('GET', '/api/connections');
  assert.equal(lan.status, 200);
  assert.deepEqual(lan.json.connections.map((c) => c.id), ['desk', 'owner-only']);
  assert.ok(!lan.text.includes(SECRET) && !lan.text.includes('192.168.0.213'));

  const other = await request('GET', '/api/connections', { host: PUBLIC, headers: { 'cf-access-jwt-assertion': await token('other@example.com') } });
  assert.equal(other.status, 200);
  assert.equal(other.json.user, 'other@example.com');
  assert.deepEqual(other.json.connections.map((c) => c.id), ['desk']);
});

test('POST without the X-VNCGW header is refused (CSRF)', async () => {
  const r = await request('POST', '/api/sessions', { body: { connectionId: 'desk' } });
  assert.equal(r.status, 403);
});

test('POST with a foreign Origin is refused even with the header', async () => {
  const r = await post({ connectionId: 'desk' }, { headers: { origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
});

test('minting: saved, denied, allowlisted', async () => {
  const ok = await post({ connectionId: 'desk' });
  assert.equal(ok.status, 200);
  assert.ok(ok.json.sid);
  assert.equal(ok.json.guacToken, undefined, 'the connection token must never leave the server');
  assert.ok(!ok.text.includes(SECRET), 'password must not appear in the response');

  const hidden = await post({ connectionId: 'owner-only' }, { host: PUBLIC, headers: { 'cf-access-jwt-assertion': await token('other@example.com') } });
  assert.equal(hidden.status, 404, 'not permitted looks the same as not existing');

  assert.equal((await post({ connectionId: 'nope' })).status, 404);
  assert.equal((await post({ host: '8.8.8.8', port: 5900 })).status, 403);
  assert.equal((await post({ host: '192.168.0.50', port: 22 })).status, 403);
  assert.equal((await post({ host: '192.168.0.50', port: 5900 })).status, 200);
});

// ---------------------------------------------------------------- websocket
test('WebSocket: no sid, forged sid and replayed sid are 401; a fresh one upgrades', async () => {
  assert.equal(await ws({}), 401);
  assert.equal(await ws({ sid: 'forged-forged-forged' }), 401);
  const { json } = await post({ connectionId: 'desk' });
  assert.equal(await ws({ sid: json.sid }), 101);
  assert.equal(await ws({ sid: json.sid }), 401);
});

test('WebSocket: a tampered token cannot reach guacamole-lite (it used to crash the server)', async () => {
  const { json } = await post({ connectionId: 'desk' });
  const u = new URL(base);
  const code = await new Promise((resolve) => {
    const s = new WebSocket(`ws://${u.host}/?token=garbage&sid=${json.sid}`);
    s.on('open', () => { resolve(101); setTimeout(() => s.terminate(), 500); });
    s.on('unexpected-response', (_q, res) => resolve(res.statusCode));
    s.on('error', () => resolve('error'));
  });
  assert.equal(code, 101);
  await new Promise((r) => setTimeout(r, 800));
  assert.equal((await request('GET', '/healthz')).status, 200, 'server must still be alive');
  assert.ok(!logs.includes('uncaught exception'));
});

test('WebSocket: a foreign Origin is refused (cross-site WebSocket hijacking)', async () => {
  const { json } = await post({ connectionId: 'desk' });
  assert.equal(await ws({ sid: json.sid, origin: 'https://evil.example' }), 403);
});

test('WebSocket: unknown Host is 421', async () => {
  const { json } = await post({ connectionId: 'desk' });
  assert.equal(await ws({ sid: json.sid, host: 'evil.example' }), 421);
});

test('WebSocket on the public hostname needs a token, and the same identity that minted', async () => {
  const t = await token('owner@example.com');
  const auth = { 'cf-access-jwt-assertion': t };
  const mk = async () => (await post({ connectionId: 'owner-only' }, { host: PUBLIC, headers: auth })).json.sid;

  assert.equal(await ws({ sid: await mk(), host: PUBLIC }), 403, 'no token');
  assert.equal(await ws({ sid: await mk(), host: PUBLIC, headers: { 'cf-access-jwt-assertion': await token('other@example.com') } }), 401, 'other identity');
  assert.equal(await ws({ sid: await mk(), host: PUBLIC, headers: auth, origin: `https://${PUBLIC}` }), 101, 'owner');

  const lanSid = (await post({ connectionId: 'desk' })).json.sid;
  assert.equal(await ws({ sid: lanSid, host: PUBLIC, headers: auth }), 401, 'LAN handle via public name');
});

// ---------------------------------------------------------------- profiles
const papi = (method, p, body, opts = {}) =>
  request(method, p, { body, ...opts, headers: { 'x-vncgw': '1', ...(opts.headers || {}) } });

test('profiles: keep, list, rename, delete -- and never the password', async () => {
  const kept = await papi('POST', '/api/profiles', { name: 'Lab', host: '192.168.0.50', port: 5900, password: 'MUST-NOT-BE-STORED' });
  assert.equal(kept.status, 201);
  assert.deepEqual(Object.keys(kept.json).sort(), ['createdAt', 'host', 'id', 'name', 'port']);
  const onDisk = fs.readFileSync(path.join(dataDir, 'profiles.json'), 'utf8');
  assert.ok(onDisk.includes('192.168.0.50'));
  assert.ok(!onDisk.includes('MUST-NOT-BE-STORED'), 'password reached the profile store');

  const list = await request('GET', '/api/connections');
  const mine = list.json.profiles.find((p) => p.id === kept.json.id);
  assert.deepEqual({ name: mine.name, host: mine.host, port: mine.port, busy: mine.busy }, { name: 'Lab', host: '192.168.0.50', port: 5900, busy: null });

  const renamed = await papi('PATCH', `/api/profiles/${kept.json.id}`, { name: 'Lab box' });
  assert.equal(renamed.json.name, 'Lab box');
  assert.equal((await papi('DELETE', `/api/profiles/${kept.json.id}`)).status, 204);
  assert.equal((await papi('DELETE', `/api/profiles/${kept.json.id}`)).status, 404);
});

test('profiles: state-changing calls need the CSRF header', async () => {
  assert.equal((await request('POST', '/api/profiles', { body: { host: '192.168.0.51' } })).status, 403);
  const kept = await papi('POST', '/api/profiles', { host: '192.168.0.52' });
  assert.equal((await request('DELETE', `/api/profiles/${kept.json.id}`)).status, 403);
  assert.equal((await papi('DELETE', `/api/profiles/${kept.json.id}`)).status, 204);
});

test('profiles: only addresses you could connect to can be kept', async () => {
  assert.equal((await papi('POST', '/api/profiles', { host: '8.8.8.8' })).status, 403);
  assert.equal((await papi('POST', '/api/profiles', { host: 'nas.lan' })).status, 403);
  assert.equal((await papi('POST', '/api/profiles', { host: '192.168.0.53', port: 22 })).status, 403);
  const a = await papi('POST', '/api/profiles', { host: '192.168.0.53' });
  assert.equal(a.status, 201);
  assert.equal(a.json.name, '192.168.0.53:5900', 'unnamed profiles are named after their address');
  assert.equal((await papi('POST', '/api/profiles', { host: '192.168.0.53', port: 5900 })).status, 409);
  await papi('DELETE', `/api/profiles/${a.json.id}`);
});

test('profiles: each Access user has their own; LAN has its own', async () => {
  const lan = await papi('POST', '/api/profiles', { name: 'LAN one', host: '192.168.0.54' });
  const other = { host: PUBLIC, headers: { 'cf-access-jwt-assertion': await token('other@example.com') } };
  const owner = { host: PUBLIC, headers: { 'cf-access-jwt-assertion': await token('owner@example.com') } };

  const theirs = await papi('POST', '/api/profiles', { name: 'Theirs', host: '192.168.0.55' }, other);
  assert.equal(theirs.status, 201);

  const seenByOther = (await request('GET', '/api/connections', other)).json.profiles.map((p) => p.name);
  const seenByOwner = (await request('GET', '/api/connections', owner)).json.profiles.map((p) => p.name);
  const seenByLan = (await request('GET', '/api/connections')).json.profiles.map((p) => p.name);
  assert.deepEqual(seenByOther, ['Theirs']);
  assert.deepEqual(seenByOwner, []);
  assert.ok(seenByLan.includes('LAN one') && !seenByLan.includes('Theirs'));

  assert.equal((await papi('DELETE', `/api/profiles/${lan.json.id}`, undefined, other)).status, 404, "cannot delete someone else's");
  assert.equal((await papi('PATCH', `/api/profiles/${lan.json.id}`, { name: 'x' }, other)).status, 404);
  assert.equal((await post({ profileId: lan.json.id, password: 'x' }, other)).status, 404, "cannot connect with someone else's");

  const ok = await post({ profileId: theirs.json.id, password: 'pw' }, other);
  assert.equal(ok.status, 200);
  assert.ok(ok.json.sid);
  await papi('DELETE', `/api/profiles/${lan.json.id}`);
  await papi('DELETE', `/api/profiles/${theirs.json.id}`, undefined, other);
});

// ------------------------------------------------------------ rate limiting
test('session minting is rate limited per identity', async () => {
  const auth = { 'cf-access-jwt-assertion': await token('flood@example.com') };
  let last;
  for (let i = 0; i < 41; i++) last = await post({ connectionId: 'desk' }, { host: PUBLIC, headers: auth });
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers['retry-after']) > 0);
  // someone else is unaffected
  const other = await post({ connectionId: 'desk' }, { host: PUBLIC, headers: { 'cf-access-jwt-assertion': await token('calm@example.com') } });
  assert.equal(other.status, 200);
});

// ------------------------------------------------------------------- logs
test('logs are single-line JSON with the contract keys, and never contain the VNC password', () => {
  const lines = logs.split('\n').filter(Boolean);
  assert.ok(lines.length > 10);
  for (const line of lines) {
    const o = JSON.parse(line);
    for (const k of ['ts', 'level', 'msg', 'svc']) assert.ok(k in o, `${k} missing in ${line}`);
    assert.equal(o.svc, 'vnc-gateway');
  }
  assert.ok(!logs.includes(SECRET), 'VNC password leaked into logs');
  assert.ok(logs.includes('"msg":"session minted"'));
  assert.ok(logs.includes('"msg":"websocket refused"'));
});
