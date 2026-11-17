'use strict';

// The four contract metrics, plus one gauge that answers the question you
// actually have about a remote-desktop gateway: is anybody connected right now?
//
// Labels are route TEMPLATES and fixed error kinds only. Never a user, a target
// host, a session id or a raw path: every distinct value is a stored series.

const client = require('@prometheus-io/client');
const config = require('./config');

const register = new client.Registry();
client.collectDefaultMetrics({ register, prefix: 'vncgw_' });

const buildInfo = new client.Gauge({
  name: 'vncgw_build_info',
  help: 'Running version.',
  labelNames: ['version', 'commit'],
  registers: [register],
});
buildInfo.set({ version: config.version, commit: config.commit }, 1);

const requests = new client.Counter({
  name: 'vncgw_requests_total',
  help: 'HTTP requests by route template, method and status.',
  labelNames: ['route', 'method', 'status'],
  registers: [register],
});

const duration = new client.Histogram({
  name: 'vncgw_request_duration_seconds',
  help: 'HTTP request duration by route template.',
  labelNames: ['route'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

// kind is one of a fixed set -- see the callers. Keep it that way.
const errors = new client.Counter({
  name: 'vncgw_errors_total',
  help: 'Failures by category.',
  labelNames: ['kind'],
  registers: [register],
});

const activeSessions = new client.Gauge({
  name: 'vncgw_active_sessions',
  help: 'Remote desktop sessions currently open.',
  registers: [register],
});

const sessionsTotal = new client.Counter({
  name: 'vncgw_sessions_total',
  help: 'Remote desktop sessions opened, by how the target was chosen.',
  labelNames: ['kind'], // saved | freeform
  registers: [register],
});

module.exports = { register, requests, duration, errors, activeSessions, sessionsTotal };
