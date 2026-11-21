'use strict';

const crypto = require('crypto');
const config = require('./config');
const log = require('./log');

// ---------------------------------------------------------------------------
// THE IMPORTANT PART.
//
// guacamole-lite is driven by a token containing hostname, port and password,
// encrypted with a shared key. Most examples on the internet build that token
// in the *browser*. Don't. That ships the encryption key to the client, and it
// lets the client choose its own target and credentials -- which makes every
// check in allowlist.js decorative.
//
// Here the browser only ever names a connection ID (or asks for a host that we
// then validate). The server looks up the credential, mints the token, and
// hands back an opaque single-use handle bound to the caller's identity. The key
// never leaves this process and the browser never sees a VNC password.
// ---------------------------------------------------------------------------

// Byte-compatible with guacamole-lite's own lib/Crypt.js, kept local rather than
// deep-importing from the package's internals.
function encryptToken(payload) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('AES-256-CBC', Buffer.from(config.tokenKey, 'utf8'), iv);
  const value = cipher.update(JSON.stringify(payload), 'utf8', 'base64') + cipher.final('base64');
  // guacamole-lite expects base64( JSON{ iv, value } ).
  return Buffer.from(JSON.stringify({ iv: iv.toString('base64'), value })).toString('base64');
}

function safeName(s) {
  return String(s).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60);
}

// One key per desktop. Two names for the same machine (an IP and a hostname)
// are not detected as the same desktop; keep connections.json and profiles on
// IP addresses to make the lock reliable.
function targetKey(hostname, port) {
  return `${String(hostname).toLowerCase()}:${port}`;
}

function clampDim(n, fallback) {
  const v = parseInt(n, 10);
  return Number.isInteger(v) && v >= 200 && v <= 8192 ? v : fallback;
}

// Opaque handle -> { expiresAt, identity, target, label, guacToken }. In-memory
// is fine for one replica: a restart just means everyone reconnects, and
// handles live ~60s.
//
// The encrypted token stays HERE and is injected into the upgrade request
// server-side. The browser only ever holds the sid. Two reasons:
//   - guacamole-lite 1.2.0 crashes the whole process on a token it cannot
//     decrypt, so a client that tampered with it could drop every session.
//   - guacamole-lite's token format can also ask to JOIN an existing session
//     or route to a different guacd. Nothing the client sends should be able to
//     reach that parser.
const handles = new Map();

function mint({ identity, hostname, port, password, width, height, label, kind }) {
  const settings = {
    hostname,
    port: String(port),
    password: password || '',
    width: clampDim(width, 1280),
    height: clampDim(height, 720),
    dpi: 96,
    cursor: 'local',
  };

  if (config.recording.enabled) {
    // guacd writes this file itself, into the volume mounted at /recordings.
    // The name is built here: guacd does not expand ${GUAC_DATE}-style tokens,
    // that substitution lives in the Java webapp we are not using.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    settings['recording-path'] = config.recording.path;
    settings['recording-name'] = `${stamp}_${safeName(label)}_${crypto.randomBytes(3).toString('hex')}`;
    settings['create-recording-path'] = 'true';
  }

  const guacToken = encryptToken({ connection: { type: 'vnc', settings } });

  const sid = crypto.randomBytes(24).toString('base64url');
  handles.set(sid, {
    expiresAt: Date.now() + config.sessionTtlMs,
    identity,
    target: targetKey(hostname, port),
    label,
    kind,
    guacToken,
  });

  log.info('session minted', {
    user: identity.email, via: identity.via, target: `${hostname}:${port}`, label, kind,
    recording: config.recording.enabled,
  });
  return { sid, expiresInSeconds: Math.floor(config.sessionTtlMs / 1000) };
}

// Called during the WebSocket upgrade. Single-use: claiming removes the handle,
// so one leaked into a log or browser history cannot be replayed. The upgrade
// must also come from the same identity that minted it, so a handle lifted
// from one Access user's browser is useless in anyone else's.
function claim(sid, identity) {
  if (!sid) return { ok: false, reason: 'missing sid' };
  const entry = handles.get(sid);
  if (!entry) return { ok: false, reason: 'unknown or already used sid' };
  handles.delete(sid);
  if (Date.now() > entry.expiresAt) return { ok: false, reason: 'expired sid', entry };
  if (entry.identity.email !== identity.email || entry.identity.via !== identity.via) {
    return { ok: false, reason: 'sid minted for a different identity', entry };
  }
  return { ok: true, entry };
}

setInterval(() => {
  const now = Date.now();
  for (const [sid, entry] of handles) if (now > entry.expiresAt) handles.delete(sid);
}, 60_000).unref();

// ---------------------------------------------------------------------------
// One open session per desktop.
//
// Someone else's session on the same desktop: refused. Your own (another tab,
// or a dropped session the server has not noticed yet): taken over -- the old
// one is closed with a message first. Either way there are never two, and
// Reconnect after a network drop is not blocked by your own dead session.
// ---------------------------------------------------------------------------
const active = new Map(); // target -> { target, identity, since, lastInput, socket, conn }

const sameIdentity = (a, b) => a.email === b.email && a.via === b.via;

function occupant(target) {
  return active.get(target) || null;
}

// The Guacamole protocol's own error instruction, so the browser can show why
// it was disconnected. 776 = CLIENT_TIMEOUT / session closed by the server.
function guacError(message) {
  return `5.error,${[...message].length}.${message},3.776;`;
}

function end(entry, message) {
  if (active.get(entry.target) === entry) active.delete(entry.target);
  if (entry.conn) {
    try { entry.conn.send(guacError(message)); } catch { /* already gone */ }
    entry.conn.close();
  } else {
    entry.socket.destroy(); // not handed to guacd yet
  }
}

function reserve(target, identity, socket) {
  const current = active.get(target);
  if (current && !sameIdentity(current.identity, identity)) {
    return { ok: false, since: current.since };
  }
  if (current) end(current, 'This desktop was opened in another window.');
  const entry = { target, identity, since: Date.now(), lastInput: Date.now(), socket, conn: null };
  active.set(target, entry);
  // Released when the connection ends, whichever side ends it. The identity
  // check stops a late close of an old session releasing its successor.
  socket.once('close', () => { if (active.get(target) === entry) active.delete(target); });
  return { ok: true, entry, tookOver: Boolean(current) };
}

// Mouse, key and clipboard instructions from the browser are what "in use"
// means. sync/nop/ping traffic flows constantly and must not count.
const INPUT = /(?:^|;)\d+\.(?:mouse|key|clipboard),/;

function attach(target, conn) {
  const entry = active.get(target);
  if (!entry) return;
  entry.conn = conn;
  conn.webSocket.on('message', (msg) => {
    if (INPUT.test(msg.toString())) entry.lastInput = Date.now();
  });
}

// Closes sessions with no input for longer than timeoutMs; returns them.
function sweepIdle(timeoutMs, now = Date.now()) {
  if (!timeoutMs) return [];
  const idle = [...active.values()].filter((e) => e.conn && now - e.lastInput > timeoutMs);
  const minutes = Math.round(timeoutMs / 60_000);
  const label = minutes >= 1 ? `${minutes} minute${minutes === 1 ? '' : 's'}` : `${Math.round(timeoutMs / 1000)} seconds`;
  for (const e of idle) end(e, `Disconnected after ${label} without input.`);
  return idle;
}

module.exports = { mint, claim, targetKey, occupant, reserve, attach, sweepIdle, sameIdentity };
