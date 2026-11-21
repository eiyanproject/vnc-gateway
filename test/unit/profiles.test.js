'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { baseEnv, applyEnv } = require('../helpers');

const env = baseEnv();
applyEnv(env);
const profiles = require('../../src/profiles');

const lan = { email: 'lan', via: 'lan' };
const alice = { email: 'alice@example.com', via: 'access' };
const bob = { email: 'bob@example.com', via: 'access' };
const FILE = path.join(env.DATA_DIR, 'profiles.json');

test('a password in the request never reaches the store', () => {
  const r = profiles.create(alice, { name: 'Lab', host: '192.168.0.50', port: 5900, password: 'NEVER-STORED' });
  assert.equal(r.status, 201);
  assert.equal(r.profile.password, undefined);
  assert.ok(!fs.readFileSync(FILE, 'utf8').includes('NEVER-STORED'));
});

test('each identity has its own list', () => {
  profiles.create(bob, { host: '192.168.0.51' });
  assert.deepEqual(profiles.list(alice).map((p) => p.host), ['192.168.0.50']);
  assert.deepEqual(profiles.list(bob).map((p) => p.host), ['192.168.0.51']);
  assert.deepEqual(profiles.list(lan), []);
  const aliceId = profiles.list(alice)[0].id;
  assert.equal(profiles.get(bob, aliceId), null);
  assert.equal(profiles.remove(bob, aliceId).status, 404);
  assert.equal(profiles.rename(bob, aliceId, 'x').status, 404);
});

test('only connectable targets can be kept', () => {
  assert.equal(profiles.create(lan, { host: '10.0.0.1' }).status, 403);
  assert.equal(profiles.create(lan, { host: 'nas.lan' }).status, 403);
  assert.equal(profiles.create(lan, { host: '192.168.0.60', port: 22 }).status, 403);
  assert.equal(profiles.create(lan, { host: '' }).status, 403);
});

test('duplicates are refused and names are cleaned', () => {
  const r = profiles.create(lan, { name: '  A\u0007 name ' + 'x'.repeat(100), host: '192.168.0.61' });
  assert.equal(r.status, 201);
  assert.equal(r.profile.name.length, 60);
  assert.ok(!/[\u0000-\u001f]/.test(r.profile.name));
  assert.equal(profiles.create(lan, { host: '192.168.0.61', port: '5900' }).status, 409);
  assert.equal(profiles.rename(lan, r.profile.id, '   ').profile.name, r.profile.name, 'blank rename keeps the old name');
  assert.equal(profiles.rename(lan, r.profile.id, 'Short').profile.name, 'Short');
});

test('the store survives a restart and is written privately', () => {
  delete require.cache[require.resolve('../../src/profiles')];
  const again = require('../../src/profiles');
  assert.deepEqual(again.list(alice).map((p) => p.name), ['Lab']);
  if (process.platform !== 'win32') assert.equal(fs.statSync(FILE).mode & 0o777, 0o600);
});

test('a list has a cap', () => {
  const who = { email: 'many@example.com', via: 'access' };
  let last;
  for (let i = 1; i <= 51; i++) last = profiles.create(who, { host: `192.168.0.${i}`, port: 5901 });
  assert.equal(last.status, 409);
  assert.equal(profiles.list(who).length, 50);
});
