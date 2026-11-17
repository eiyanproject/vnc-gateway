'use strict';

// Service contract (homelab-monitoring/docs/SERVICE-CONTRACT.md): one JSON
// object per line to stdout, with ts, level, msg, svc. Never a log file.
//
// This is also the audit trail. Who minted a session for which target, which
// upgrades were refused and why -- all of it lands here, and journald/rsyslog
// carries it to VictoriaLogs. Never pass a password or token as a field.

const SVC = 'vnc-gateway';
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info;

function emit(level, msg, fields) {
  if (LEVELS[level] < threshold) return;
  const line = { ts: new Date().toISOString(), level, msg, svc: SVC, ...fields };
  const out = level === 'error' ? process.stderr : process.stdout;
  out.write(JSON.stringify(line) + '\n');
}

module.exports = {
  debug: (msg, f) => emit('debug', msg, f),
  info: (msg, f) => emit('info', msg, f),
  warn: (msg, f) => emit('warn', msg, f),
  error: (msg, f) => emit('error', msg, f),
};
