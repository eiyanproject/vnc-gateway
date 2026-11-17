'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { baseEnv, applyEnv, startJwks } = require('../helpers');

const TEAM = 'team.cloudflareaccess.com';
const AUD = 'aud-0123456789abcdef';
let guard;
let jwks;

test.before(async () => {
  jwks = await startJwks();
  applyEnv(baseEnv({
    ALLOWED_HOSTS: 'vnc-gateway',
    ACCESS_HOSTS: 'vnc.example.com',
    ACCESS_TEAM_DOMAIN: `https://${TEAM}/`, // normalised: scheme and slash stripped
    ACCESS_AUD: AUD,
    ACCESS_CERTS_URL: jwks.url,
  }));
  guard = require('../../src/guard');
});
test.after(() => jwks.close());

const req = (host, headers = {}) => ({ headers: { ...(host === undefined ? {} : { host }), ...headers } });
const good = () => jwks.sign({ aud: AUD, iss: `https://${TEAM}` });

test('LAN names pass without a token', async () => {
  for (const h of ['192.168.0.30:8088', '127.0.0.1', 'localhost:8088', '[::1]:8080', 'vnc-gateway:8088', 'VNC-GATEWAY']) {
    const v = await guard.evaluate(req(h));
    assert.equal(v.ok, true, h);
    assert.deepEqual(v.identity, { email: 'lan', via: 'lan' });
  }
});

test('unknown hostnames are refused with 421 (DNS rebinding)', async () => {
  for (const h of ['evil.example', 'vnc.example.com.evil.example', 'vnc.example.com.', undefined, '']) {
    const v = await guard.evaluate(req(h));
    assert.equal(v.ok, false, String(h));
    assert.equal(v.status, 421, String(h));
    assert.equal(v.kind, 'host_rejected');
  }
});

test('a public hostname with a valid Access token yields the email', async () => {
  const v = await guard.evaluate(req('vnc.example.com', { 'cf-access-jwt-assertion': await good() }));
  assert.equal(v.ok, true);
  assert.deepEqual(v.identity, { email: 'owner@example.com', via: 'access' });
});

test('the token is also accepted from the CF_Authorization cookie', async () => {
  const v = await guard.evaluate(req('vnc.example.com:443', { cookie: `a=b; CF_Authorization=${await good()}` }));
  assert.equal(v.ok, true);
});

test('public hostname matching is case-insensitive, so case is not a bypass', async () => {
  const v = await guard.evaluate(req('VNC.Example.COM'));
  assert.equal(v.ok, false);
  assert.equal(v.status, 403);
});

test('no token on a public hostname is 403', async () => {
  const v = await guard.evaluate(req('vnc.example.com'));
  assert.equal(v.status, 403);
  assert.equal(v.kind, 'access_no_token');
});

test('tokens that must be refused', async () => {
  const cases = {
    'wrong audience': await jwks.sign({ aud: 'some-other-app', iss: `https://${TEAM}` }),
    'no audience': await jwks.sign({ iss: `https://${TEAM}` }),
    'wrong issuer': await jwks.sign({ aud: AUD, iss: 'https://evil.cloudflareaccess.com' }),
    'expired': await jwks.sign({ aud: AUD, iss: `https://${TEAM}`, exp: Math.floor(Date.now() / 1000) - 3600 }),
    'unknown key id': await jwks.sign({ aud: AUD, iss: `https://${TEAM}`, kid: 'nope' }),
    'signed by a key the team never published': await jwks.sign({ aud: AUD, iss: `https://${TEAM}`, key: jwks.otherKey }),
    'garbage': 'not.a.jwt',
  };
  // alg "none": header and claims are fine, there is simply no signature.
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  cases['alg none'] = `${b64({ alg: 'none', kid: 'k1' })}.${b64({ email: 'owner@example.com', aud: AUD, iss: `https://${TEAM}`, exp: 9999999999 })}.`;

  for (const [name, token] of Object.entries(cases)) {
    const v = await guard.evaluate(req('vnc.example.com', { 'cf-access-jwt-assertion': token }));
    assert.equal(v.ok, false, name);
    assert.equal(v.status, 403, name);
  }
});

test('Origin must match Host when a browser sends one', () => {
  assert.equal(guard.originMatches(req('vnc.example.com', { origin: 'https://vnc.example.com' })), true);
  assert.equal(guard.originMatches(req('192.168.0.30:8088', { origin: 'http://192.168.0.30:8088' })), true);
  assert.equal(guard.originMatches(req('192.168.0.30:8088', { origin: 'https://evil.example' })), false);
  assert.equal(guard.originMatches(req('192.168.0.30:8088', { origin: 'null' })), false);
  assert.equal(guard.originMatches(req('192.168.0.30:8088')), true); // non-browser client
});
