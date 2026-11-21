'use strict';

// One session per desktop, through the real server. A silent stand-in for
// guacd keeps each accepted WebSocket open, which is all the lock needs.

const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { baseEnv, startJwks, startServer, startSilentGuacd } = require('../helpers');

const TEAM = 'team.cloudflareaccess.com';
const AUD = 'aud-0123456789abcdef';
const PUBLIC = 'vnc.example.com';

let srv;
let guacd;
let jwks;

test.before(async () => {
  jwks = await startJwks();
  guacd = await startSilentGuacd();
  srv = await startServer(baseEnv({
    GUACD_HOST: '127.0.0.1',
    GUACD_PORT: String(guacd.port),
    ACCESS_HOSTS: PUBLIC,
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    ACCESS_CERTS_URL: jwks.url,
    SESSIONS_PER_MINUTE: '100',
  }));
});
test.after(() => { srv.kill(); guacd.close(); jwks.close(); });

async function as(email) {
  return email
    ? { host: PUBLIC, 'cf-access-jwt-assertion': await jwks.sign({ email, aud: AUD, iss: `https://${TEAM}` }) }
    : {};
}

async function call(method, path, headers, body) {
  const http = require('http');
  const u = new URL(srv.base + path);
  return new Promise((resolve, reject) => {
    const req = http.request({
      method, hostname: u.hostname, port: u.port, path: u.pathname,
      headers: { host: u.host, 'x-vncgw': '1', 'content-type': 'application/json', ...headers },
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: d ? JSON.parse(d) : null }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Opens a session and keeps it open. Resolves with the socket, or the HTTP
// status when refused.
async function open(headers) {
  const m = await call('POST', '/api/sessions', headers, { connectionId: 'desk' });
  if (m.status !== 200) return { status: m.status, json: m.json };
  const u = new URL(srv.base);
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://${u.host}/?sid=${m.json.sid}`, { headers: { host: headers.host || u.host, ...headers } });
    ws.on('open', () => resolve({ status: 101, ws }));
    ws.on('unexpected-response', (_q, res) => resolve({ status: res.statusCode }));
    ws.on('error', () => resolve({ status: 'error' }));
  });
}

const closed = (ws) => new Promise((resolve) => {
  if (ws.readyState === WebSocket.CLOSED) return resolve(true);
  ws.on('close', () => resolve(true));
  setTimeout(() => resolve(false), 3000);
});

const desk = async (headers) => (await call('GET', '/api/connections', headers)).json.connections.find((c) => c.id === 'desk');

test('a desktop in use is refused to someone else, with when', async () => {
  const alice = await as('alice@example.com');
  const a = await open(alice);
  assert.equal(a.status, 101);

  assert.equal((await desk(alice)).busy.mine, true);
  const seenByBob = (await desk(await as('bob@example.com'))).busy;
  assert.equal(seenByBob.mine, false);
  assert.ok(Date.parse(seenByBob.since) > 0);

  const bob = await open(await as('bob@example.com'));
  assert.equal(bob.status, 409);
  assert.ok(bob.json.since);
  assert.equal((await open({})).status, 409, 'the LAN is someone else too');

  a.ws.close();
  await closed(a.ws);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await desk(alice)).busy, null, 'closing frees the desktop');
});

test('the same person opening it again takes it over', async () => {
  const alice = await as('alice@example.com');
  const first = await open(alice);
  const second = await open(await as('alice@example.com'));
  assert.equal(second.status, 101);
  assert.equal(await closed(first.ws), true, 'the first window was closed');
  assert.equal((await desk(alice)).busy.mine, true, 'and the second still holds it');
  second.ws.close();
  await closed(second.ws);
  await new Promise((r) => setTimeout(r, 200));
});

test('two handles minted before either is used: the second upgrade is refused', async () => {
  const alice = await as('alice@example.com');
  const bob = await as('bob@example.com');
  const sa = await call('POST', '/api/sessions', alice, { connectionId: 'desk' });
  const sb = await call('POST', '/api/sessions', bob, { connectionId: 'desk' });
  assert.equal(sa.status, 200);
  assert.equal(sb.status, 200, 'both minted while the desktop was free');

  const u = new URL(srv.base);
  const up = (sid, headers) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://${u.host}/?sid=${sid}`, { headers });
    ws.on('open', () => resolve({ status: 101, ws }));
    ws.on('unexpected-response', (_q, res) => resolve({ status: res.statusCode }));
  });
  const a = await up(sa.json.sid, alice);
  assert.equal(a.status, 101);
  assert.equal((await up(sb.json.sid, bob)).status, 409);
  a.ws.close();
});
