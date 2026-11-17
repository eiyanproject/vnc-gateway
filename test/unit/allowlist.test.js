'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { baseEnv, applyEnv } = require('../helpers');

applyEnv(baseEnv({ ALLOWED_CIDRS: '192.168.0.0/24,10.20.32.0/20' }));
const { checkTarget } = require('../../src/allowlist');

test('in-range address on an allowed port is accepted', () => {
  assert.equal(checkTarget('192.168.0.213', 5900).ok, true);
  assert.equal(checkTarget('10.20.47.255', 5901).ok, true); // top of the /20
});

test('adjacent subnets are refused', () => {
  assert.equal(checkTarget('192.168.1.50', 5900).ok, false);
  assert.equal(checkTarget('10.20.48.0', 5900).ok, false); // just past the /20
});

test('ports outside ALLOWED_PORTS are refused', () => {
  const v = checkTarget('192.168.0.50', 22);
  assert.equal(v.ok, false);
  assert.match(v.reason, /port 22/);
});

test('hostnames are refused outright (DNS rebinding)', () => {
  const v = checkTarget('evil.example.com', 5900);
  assert.equal(v.ok, false);
  assert.match(v.reason, /literal IPv4/);
});

test('malformed and out-of-range addresses are refused', () => {
  for (const h of ['300.1.1.1', '192.168.0', '192.168.0.1.2', '', '::1', '0x7f.0.0.1']) {
    assert.equal(checkTarget(h, 5900).ok, false, h);
  }
});
