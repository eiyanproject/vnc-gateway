'use strict';

// Kept profiles: a name, a host and a port, per identity. NEVER a password --
// only the three fields below are read from a request, so a password sent by a
// confused or malicious client has nowhere to go.
//
// One small JSON file in the data volume. Writes go to a temp file and are
// renamed over the original, so a crash mid-write cannot leave half a file.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { checkTarget } = require('./allowlist');

const FILE = path.join(config.dataDir, 'profiles.json');

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
    throw new Error('not a JSON object');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`cannot read ${FILE}: ${err.message}`);
  }
}

let db = load();

function save() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

// Access users each get their own list; everyone on the LAN shares one.
const keyOf = (identity) => (identity.via === 'access' ? `access:${identity.email}` : 'lan');

function cleanName(name, fallback) {
  const n = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60);
  return n || fallback;
}

function list(identity) {
  return (db[keyOf(identity)] || []).map((p) => ({ ...p }));
}

function get(identity, id) {
  return (db[keyOf(identity)] || []).find((p) => p.id === id) || null;
}

function create(identity, body) {
  const host = String(body.host ?? '').trim();
  const port = parseInt(body.port, 10) || 5900;
  const verdict = checkTarget(host, port);
  if (!verdict.ok) return { status: 403, error: verdict.reason };

  const mine = db[keyOf(identity)] || [];
  const dup = mine.find((p) => p.host === host && p.port === port);
  if (dup) return { status: 409, error: `already kept as "${dup.name}"` };
  if (mine.length >= config.maxProfiles) return { status: 409, error: `at most ${config.maxProfiles} profiles` };

  const profile = {
    id: crypto.randomUUID(),
    name: cleanName(body.name, `${host}:${port}`),
    host,
    port,
    createdAt: new Date().toISOString(),
  };
  db[keyOf(identity)] = [...mine, profile];
  save();
  return { status: 201, profile };
}

function rename(identity, id, name) {
  const p = get(identity, id);
  if (!p) return { status: 404, error: 'no such profile' };
  p.name = cleanName(name, p.name);
  save();
  return { status: 200, profile: { ...p } };
}

function remove(identity, id) {
  const mine = db[keyOf(identity)] || [];
  if (!mine.some((p) => p.id === id)) return { status: 404, error: 'no such profile' };
  db[keyOf(identity)] = mine.filter((p) => p.id !== id);
  save();
  return { status: 204 };
}

function writable() {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.accessSync(config.dataDir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

module.exports = { list, get, create, rename, remove, writable };
