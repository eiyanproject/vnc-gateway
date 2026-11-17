'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLimiter } = require('../../src/ratelimit');

test('allows up to the limit, then refuses with a retry hint', () => {
  const allow = createLimiter({ perMinute: 3 });
  assert.equal(allow('a').ok, true);
  assert.equal(allow('a').ok, true);
  assert.equal(allow('a').ok, true);
  const r = allow('a');
  assert.equal(r.ok, false);
  assert.ok(r.retryAfter >= 1 && r.retryAfter <= 60);
});

test('keys are counted separately', () => {
  const allow = createLimiter({ perMinute: 1 });
  assert.equal(allow('a').ok, true);
  assert.equal(allow('b').ok, true);
  assert.equal(allow('a').ok, false);
});
