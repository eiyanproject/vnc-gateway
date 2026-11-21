'use strict';

// One session per desktop, and the idle sweep, against stand-in sockets and
// guacamole-lite connections.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { baseEnv, applyEnv } = require('../helpers');

applyEnv(baseEnv());
const sessions = require('../../src/sessions');

const alice = { email: 'alice@example.com', via: 'access' };
const bob = { email: 'bob@example.com', via: 'access' };

function fakeSocket() {
  const s = new EventEmitter();
  s.destroyed = false;
  s.destroy = () => { s.destroyed = true; s.emit('close'); };
  return s;
}
function fakeConn(socket) {
  return {
    webSocket: new EventEmitter(),
    sent: [],
    closed: false,
    send(m) { this.sent.push(m); },
    close() { this.closed = true; socket.emit('close'); },
  };
}

const T = sessions.targetKey('192.168.0.213', 5900);

test('target keys ignore hostname case', () => {
  assert.equal(sessions.targetKey('Desk.LAN', 5900), sessions.targetKey('desk.lan', '5900'));
});

test('someone else is refused while a desktop is open', () => {
  const s = fakeSocket();
  assert.equal(sessions.reserve(T, alice, s).ok, true);
  const r = sessions.reserve(T, bob, fakeSocket());
  assert.equal(r.ok, false);
  assert.ok(r.since > 0);
  s.emit('close');
  assert.equal(sessions.occupant(T), null, 'closing releases the desktop');
  const again = fakeSocket();
  assert.equal(sessions.reserve(T, bob, again).ok, true);
  again.emit('close');
});

test('the same person takes over, and the old session is told why', () => {
  const s1 = fakeSocket();
  sessions.reserve(T, alice, s1);
  const c1 = fakeConn(s1);
  sessions.attach(T, c1);

  const s2 = fakeSocket();
  const r = sessions.reserve(T, alice, s2);
  assert.equal(r.ok, true);
  assert.equal(r.tookOver, true);
  assert.equal(c1.closed, true);
  assert.match(c1.sent.join(''), /^5\.error,\d+\.This desktop was opened in another window\.,3\.776;$/);
  // The old socket closing late must not release the new session.
  s1.emit('close');
  assert.equal(sessions.occupant(T).socket, s2);
  s2.emit('close');
});

test('a takeover before guacd answered just drops the old socket', () => {
  const s1 = fakeSocket();
  sessions.reserve(T, alice, s1);
  const s2 = fakeSocket();
  sessions.reserve(T, alice, s2);
  assert.equal(s1.destroyed, true);
  s2.emit('close');
});

test('only mouse, key and clipboard count as input', () => {
  const s = fakeSocket();
  sessions.reserve(T, alice, s);
  const c = fakeConn(s);
  sessions.attach(T, c);
  const e = sessions.occupant(T);

  e.lastInput = 0;
  c.webSocket.emit('message', Buffer.from('4.sync,13.1700000000000;'));
  c.webSocket.emit('message', Buffer.from('0.,4.ping,13.1700000000000;'));
  assert.equal(e.lastInput, 0, 'background traffic is not input');
  c.webSocket.emit('message', Buffer.from('4.sync,1.1;5.mouse,3.100,3.200,1.0;'));
  assert.ok(e.lastInput > 0, 'a mouse move is input');
  e.lastInput = 0;
  c.webSocket.emit('message', Buffer.from('3.key,5.65307,1.1;'));
  assert.ok(e.lastInput > 0, 'a key is input');
  s.emit('close');
});

test('idle sessions are closed with a reason; active ones are left alone', () => {
  const s = fakeSocket();
  sessions.reserve(T, alice, s);
  const c = fakeConn(s);
  sessions.attach(T, c);
  const e = sessions.occupant(T);

  e.lastInput = Date.now() - 5_000;
  assert.deepEqual(sessions.sweepIdle(60_000), [], 'within the limit');
  assert.deepEqual(sessions.sweepIdle(0), [], '0 disables the timeout');
  assert.equal(c.closed, false);

  e.lastInput = Date.now() - 16 * 60_000;
  const closed = sessions.sweepIdle(15 * 60_000);
  assert.equal(closed.length, 1);
  assert.equal(c.closed, true);
  assert.match(c.sent.join(''), /Disconnected after 15 minutes without input\./);
  assert.equal(sessions.occupant(T), null);
});
