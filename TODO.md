# Todo

Agreed with the owner, not started. Each item lists what exists today and the
questions to settle before building it.

## 1. Full-fledged logging system

**Today:** one JSON line per event to stdout (`ts`, `level`, `msg`, `svc`),
shipped through journald and rsyslog to VictoriaLogs. Session minted / opened /
denied / closed for inactivity, and refused requests, are already logged with
user, target and reason.

**To decide:** what "full-fledged" adds. Candidates: a request/session ID that
ties every line of one session together; a complete audit trail (who connected
where, for how long, how it ended, profile changes); retention; and whether the
logs should be viewable in the gateway itself or only in Grafana/VictoriaLogs.

## 2. Monitoring API, Grafana, and its own monitoring page

**Today:** `/healthz`, `/readyz` and `/metrics` (homelab service contract),
not yet registered with the mon LXCs, and no dashboard.

**To do:** register the service on both mon LXCs; a Grafana dashboard in
homelab-monitoring following the existing per-service ones; a monitoring page
inside the gateway (active sessions, recent events, health).

**To decide:** who may see the in-app page (everyone who can reach the gateway,
or only some Access users), and what it shows beyond the metrics.

## 3. Emergency kill button

**To decide:** what it kills -- every open session at once, one chosen session,
or both; whether it also blocks new sessions until re-enabled (a lockout) or
only ends the current ones; and who may press it.

## 4. Remove the "Windows 11 desktop" sample connection

It is a placeholder from `connections.example.json` (`host.docker.internal`,
example password) and shows up in the list as if it were real. Remove it from
the example file, and from existing installs' `connections.json` -- that file is
not tracked, so CT 103 and the local checkout each need it removed (or the
update script needs to drop exactly this sample entry).
