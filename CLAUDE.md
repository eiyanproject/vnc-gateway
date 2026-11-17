# vnc-gateway

Browser remote desktop: Node app (`src/`) in front of `guacd`, static frontend
(`public/`), deploy scripts in `proxmox/`, `oci/` and `install.sh`. README.md
explains the architecture and security model; docs/HANDOVER.md has the state of
play.

Invariants — each one exists because the alternative was a real hole:

- The browser never receives the encrypted connection token, a VNC password or
  the key. It gets an opaque sid; `src/index.js` swaps the server-held token into
  `req.url` during the upgrade. guacamole-lite 1.2.0 crashes the process on a
  token it cannot decrypt, and its token format can also JOIN other sessions.
- Every request and every WebSocket upgrade goes through `guard.evaluate()`
  first. Never add a route or listener that bypasses it, including health checks.
- guacamole-lite is attached to an EventEmitter that only emits upgrades already
  accepted. Never pass it the real HTTP server: Node runs 'upgrade' listeners
  synchronously and the gate is async.
- Labels on metrics are route templates and fixed `kind` values only.
- Never log a password, token or sid.
- Deploy scripts follow the homelab convention: host scripts print a plan until
  `--yes`; `install.sh` is idempotent and is also the update path.
- New .sh files: `git update-index --chmod=+x` (authored on Windows).

Tests (Docker only): `bash test/run-unit.sh`, `bash test/e2e/run.sh`,
`bash test/run-scripts.sh`. Run the first two after any change under `src/` or
`public/`.

## Observability

Every HTTP service in this repo exposes:
  - GET /healthz  - liveness, no dependency checks, unauthenticated
  - GET /readyz   - 200 only when dependencies are reachable
  - GET /metrics  - Prometheus text format via @prometheus-io/client
                    (the maintained successor of prom-client, same API)

Metrics: <svc>_build_info, <svc>_requests_total{route,method,status},
<svc>_request_duration_seconds{route}, <svc>_errors_total{kind}.
Label with route templates, never with IDs or full paths. Prefix here: vncgw_.

Logs: single-line JSON to stdout with keys ts, level, msg, svc. Never log files.

Register new services in the monitoring repo's targets/services.json.
