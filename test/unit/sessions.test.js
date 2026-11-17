'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { baseEnv, applyEnv, KEY } = require('../helpers');

applyEnv(baseEnv({ SESSION_TTL_SECONDS: '1' }));
const sessions = require('../../src/sessions');
// guacamole-lite's own decryptor: proves our token is byte-compatible with it.
const Crypt = require('guacamole-lite/lib/Crypt.js');

const alice = { email: 'alice@example.com', via: 'access' };
const lan = { email: 'lan', via: 'lan' };

function mint(identity = alice, extra = {}) {
  return sessions.mint({
    identity, hostname: '192.168.0.213', port: 5900, password: 'secret',
    label: 'Desk', kind: 'saved', ...extra,
  });
}

test('the browser gets only the sid; the token stays server-side', () => {
  const r = mint();
  assert.deepEqual(Object.keys(r).sort(), ['expiresInSeconds', 'sid']);
});

test('the kept token decrypts with guacamole-lite and carries the server-side settings', () => {
  const { sid } = mint();
  const { entry } = sessions.claim(sid, alice);
  const decoded = new Crypt('AES-256-CBC', KEY).decrypt(entry.guacToken);
  assert.equal(decoded.connection.type, 'vnc');
  assert.equal(decoded.connection.settings.hostname, '192.168.0.213');
  assert.equal(decoded.connection.settings.port, '5900');
  assert.equal(decoded.connection.settings.password, 'secret');
});

test('silly client dimensions are clamped', () => {
  const { sid } = mint(alice, { width: 99999, height: -5 });
  const s = new Crypt('AES-256-CBC', KEY).decrypt(sessions.claim(sid, alice).entry.guacToken).connection.settings;
  assert.equal(s.width, 1280);
  assert.equal(s.height, 720);
});

test('a handle works exactly once', () => {
  const { sid } = mint();
  assert.equal(sessions.claim(sid, alice).ok, true);
  const again = sessions.claim(sid, alice);
  assert.equal(again.ok, false);
  assert.match(again.reason, /unknown or already used/);
});

test('a handle is bound to the identity that minted it', () => {
  const { sid } = mint(alice);
  const r = sessions.claim(sid, { email: 'mallory@example.com', via: 'access' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /different identity/);
  // ...and the attempt burns it, so the rightful owner cannot be raced either.
  assert.equal(sessions.claim(sid, alice).ok, false);
});

test('a LAN handle cannot be used through the public hostname, and vice versa', () => {
  const { sid } = mint(lan);
  assert.equal(sessions.claim(sid, { email: 'lan', via: 'access' }).ok, false);
});

test('handles expire', async () => {
  const { sid } = mint();
  await new Promise((r) => setTimeout(r, 1100));
  const r = sessions.claim(sid, alice);
  assert.equal(r.ok, false);
  assert.match(r.reason, /expired/);
});

test('missing and forged handles are refused', () => {
  assert.equal(sessions.claim('', alice).ok, false);
  assert.equal(sessions.claim(null, alice).ok, false);
  assert.equal(sessions.claim('not-a-real-sid', alice).ok, false);
});
