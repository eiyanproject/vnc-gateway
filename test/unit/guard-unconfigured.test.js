'use strict';

// A public hostname listed without the team domain and audience must fail
// closed: 503 for that name, while the LAN keeps working.

const test = require('node:test');
const assert = require('node:assert/strict');
const { baseEnv, applyEnv } = require('../helpers');

applyEnv(baseEnv({ ACCESS_HOSTS: 'vnc.example.com', ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '' }));
const guard = require('../../src/guard');

test('half-configured public hostname answers 503', async () => {
  const v = await guard.evaluate({ headers: { host: 'vnc.example.com' } });
  assert.equal(v.ok, false);
  assert.equal(v.status, 503);
  assert.equal(v.kind, 'access_unconfigured');
  assert.equal(guard.accessConfigured, false);
});

test('LAN is unaffected', async () => {
  const v = await guard.evaluate({ headers: { host: '192.168.0.30:8088' } });
  assert.equal(v.ok, true);
});
