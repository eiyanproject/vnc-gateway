# Handover

State of the project as of 2026-11-21 (version 0.3.0).

## 0.3.0 -- the user flow

- **Kept profiles**: name, host and port on the gateway (`data/profiles.json`),
  per Access user, one shared list for the LAN. Never a password: only those
  three fields are read from the request. Only addresses that pass the
  allowlist can be kept, and they are re-checked on every connect.
- **One combined list**: shared connections and profiles; profiles ask for the
  password inline. Rename and delete in place.
- **One session per desktop** (`sessions.reserve`): someone else's open session
  is a 409 with "in use since"; your own is taken over and told so. Checked at
  mint and again at the WebSocket upgrade, because two handles can be minted
  before either is used.
- **Idle close**: the server closes sessions after `IDLE_TIMEOUT_MINUTES`
  (default 15) without mouse/key/clipboard input, sending the reason through the
  Guacamole protocol. The page warns first and has "Stay connected".
- **Reconnect / Back to list** dialog when a session ends; busy state on every
  connect button; Fit/1:1 and last-used desktop remembered per browser.

Verified: 61 unit + integration tests (the lock runs against a real server
with a silent stand-in guacd), and 36 end-to-end checks passing on two
consecutive runs. The E2E caught two UI bugs before release: the Fit/1:1 label
could be wrong right after connecting, and with 1:1 remembered an empty hidden
viewport covered the list and swallowed every click (`#viewport.one-to-one`
outranked `[hidden]`). `test/e2e/out/list.png` is a screenshot of the list.

Decisions taken with the user (2026-11-21): profiles on the gateway rather
than in the browser (the LAN address and the public hostname are different
origins, so browser storage would split the list). Taken without asking, easy
to change: same-person takeover instead of refusal (otherwise Reconnect after a
network drop is blocked by your own dead session for up to a minute); 15-minute
default; the lock compares the address as written.

---

## 0.2.0

## Where it stands

All four planned stages are built:

| Stage | What | State |
|---|---|---|
| 1 | Browser → guacd → VNC on the LAN | done, end-to-end tested |
| 2 | Proxmox LXC (`proxmox/create-lxc.sh`, `install.sh`) | done; CT 103 runs a 0.1 build |
| 3 | Public hostname behind Cloudflare Access | code + scripts done; **not yet enabled** (needs the dashboard steps) |
| 4 | Hardening: per-user connections, rate limit, audit log, recording, service contract | done |

Stage 3 follows the house pattern (learnbox, `l18.`, `cms.`): Cloudflare Access
→ tunnel → OCI Caddy → Tailscale → LXC, with the app verifying the Access JWT
per hostname. The earlier plan (cloudflared inside this compose file, port bound
to localhost) was dropped because it does not match how the rest of the stack is
exposed.

## To finish on the real hosts

1. **Update CT 103** (Proxmox node `eiyan`):
   `bash update-lxc.sh --ctid 103 --snapshot --yes`. The update retires the old
   `AUTH_MODE` line, adds the new settings, switches logs to journald, and checks
   the host guard on the running app.
2. **Register metrics** on both mon LXCs (homelab-monitoring
   `scripts/register-service.sh`, target `<ct-103-ip>:8088`, service
   `vnc-gateway`).
3. **Public hostname** when wanted: docs/REMOTE-ACCESS.md. Access application
   first, then `oci/setup-oci.sh` on the OCI box, then `update-lxc.sh
   --access-*`.

## Verified, and how

- `test/run-unit.sh`: 42 tests, including a real server process attacked over
  HTTP and WebSocket, and Access JWTs signed by a local key set (wrong audience,
  wrong issuer, expired, unknown key id, a key the team never published,
  `alg: none`).
- `test/e2e/run.sh`: real Chromium → app → guacd → TigerVNC, on the production
  compose file (non-root, read-only, no capabilities). 17 checks: pixels, scaling,
  mouse mapping under scale, keyboard, clipboard both ways, 1:1, recording,
  metrics, no CSP violations, password absent from logs.
- `test/run-scripts.sh`: 135 checks on create-lxc (46), update-lxc (24),
  setup-oci (32) and install.sh (33) against stubbed Proxmox and OCI hosts,
  shellcheck clean. setup-oci is run against a copy of the OCI box's layout
  (portfolio + learnbox blocks) and must leave those byte-identical.

**Not verified**: TightVNC on the actual Windows machine (the fixture is
TigerVNC, configured to refuse resizing the way TightVNC does); `setup-oci.sh`
against the real OCI box (tested on a copy of its layout with stubbed tools);
Cloudflare Access with a real token (tested with locally signed tokens of the
same shape).

## Found and fixed along the way

- **guacamole-lite crashes the whole process on a tampered token.** A client with
  a valid sid and a garbage `token=` dropped every open session. The token now
  never leaves the server.
- Unknown `Host` headers used to be served, which made the LAN app open to DNS
  rebinding. Now 421.
- WebSockets had no Origin check (CORS does not cover them). Now enforced.
- `AUTH_MODE=` with a typo would have silently meant "no auth". Removed; Access
  is per hostname and fails closed.
- `create-lxc.sh` no longer disables AppArmor when a start fails for an unrelated
  reason.
- `prom-client` is deprecated in favour of `@prometheus-io/client` (same project,
  same API, now under the prometheus org). Swapped. SERVICE-CONTRACT.md in
  homelab-monitoring still names the old package.

## Decisions taken without you (easy to change)

- **LAN is trusted**: `allowedUsers` on a connection applies to people arriving
  through Access; LAN callers see every connection. Same as learnbox.
- **Free-form targets work through the public hostname too**, limited by
  `ALLOWED_CIDRS` and the rate limit. Setting `ALLOWED_CIDRS=` empty disables it
  everywhere.
- **Recording is off by default**, and nothing prunes recordings when it is on.
- **Rate limit**: 20 session requests per minute per user / LAN address.
- **Recommended Access session**: 8 hours.
- **Hostname**: left to you; `setup-oci.sh` has no default on purpose.
