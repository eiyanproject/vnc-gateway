'use strict';

const crypto = require('crypto');
const config = require('./config');

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
// hands back an opaque single-use handle. The key never leaves this process and
// the browser never sees a VNC password.
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

// Opaque handle -> { expiresAt, user, target }. In-memory is fine: a restart
// just means everyone reconnects, and handles live for ~60s anyway.
// [STAGE 4] Swap for Postgres/Redis if you ever run more than one app replica --
// with two replicas an in-memory store means half your handles miss.
const handles = new Map();

function mint({ user, hostname, port, password, width, height, label }) {
  const guacToken = encryptToken({
    connection: {
      type: 'vnc',
      settings: {
        hostname,
        port: String(port),
        password,
        width: width || 1280,
        height: height || 720,
        dpi: 96,
        'swap-red-blue': false,
        cursor: 'local',
      },
    },
  });

  const sid = crypto.randomBytes(24).toString('base64url');
  handles.set(sid, {
    expiresAt: Date.now() + config.sessionTtlMs,
    user: user.email,
    target: `${hostname}:${port}`,
    label,
  });

  console.log(`[session] minted sid for ${user.email} -> ${label} (${hostname}:${port})`);
  return { sid, guacToken, expiresInSeconds: Math.floor(config.sessionTtlMs / 1000) };
}

// Called during the WebSocket upgrade. Single-use: claiming removes it, so a
// leaked handle in a log or a browser history entry cannot be replayed.
function claim(sid) {
  if (!sid) return null;
  const entry = handles.get(sid);
  if (!entry) return null;
  handles.delete(sid);
  if (Date.now() > entry.expiresAt) {
    console.warn(`[session] rejected expired sid for ${entry.user}`);
    return null;
  }
  console.log(`[session] claimed by ${entry.user} -> ${entry.label} (${entry.target})`);
  return entry;
}

// Handles that are minted but never used would otherwise leak slowly.
setInterval(() => {
  const now = Date.now();
  for (const [sid, entry] of handles) {
    if (now > entry.expiresAt) handles.delete(sid);
  }
}, 60_000).unref();

module.exports = { mint, claim };
