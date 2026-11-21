# vnc-gateway

Remote desktop in a browser. `guacd` speaks VNC; a small Node app decides who
may open which desktop and mints single-use sessions; the frontend is
`guacamole-common-js` with no build step. Runs on amd64 and arm64.

```
browser ──https──▶ Cloudflare edge ─Access─▶ tunnel ─▶ OCI box: cloudflared ─▶ Caddy
                                                                                │ Tailscale
LAN browser ──http──────────────────────────────────────────────────────────┐   ▼
                                                                             ▼  LXC :8088
                                                     ┌──────── app (Node) ──────────┐
                                                     │ host guard · Access JWT       │
                                                     │ sessions · allowlist · metrics│
                                                     └───────────┬───────────────────┘
                                                                 │ guacamole protocol
                                                             guacd (no port published)
                                                                 │ RFB
                                                         Windows :5900 (TightVNC)
```

Public access follows the same path as `learnbox`, `l18.` and `cms.`: no open
ports anywhere, Cloudflare Access in front, and the app verifying the Access
token itself. See [docs/REMOTE-ACCESS.md](docs/REMOTE-ACCESS.md).

---

## Using it

The page is one list of desktops:

- **Shared desktops** come from `connections.json` on the gateway. One click
  connects; the password lives on the server.
- **Your kept profiles**. Type an address under *New connection* and press
  **Keep profile** to save its name, address and port on the gateway -- never
  the password. Clicking a profile asks for the password, then connects. Each
  Cloudflare Access user has their own profiles; the LAN shares one list.
  Profiles follow you between devices, and between the LAN address and the
  public hostname.

While connected: **Fit / 1:1**, **Clipboard** (both directions), **Fullscreen**,
**Ctrl-Alt-Del**, **Disconnect**. If a session drops, a dialog offers
**Reconnect** (no retyping) or **Back to list**. Fit/1:1 and the last desktop
you used are remembered per browser.

**One session per desktop.** If someone else has a desktop open, it shows *In
use since ...* and cannot be opened. If *you* have it open in another window,
opening it again takes it over and the other window is told so -- there are
never two sessions on one machine.

**Idle sessions are closed** after `IDLE_TIMEOUT_MINUTES` (default 15) without
mouse or keyboard input, so a forgotten tab does not hold a desktop. The page
warns first and offers *Stay connected*.

---

## Security model

Every layer is independent; none relies on another being configured right.

| Layer | What it stops |
|---|---|
| **Cloudflare Access** (edge) | Strangers never reach the origin. One-time PIN to your email. |
| **Access JWT verified in the app** | If Access is deleted, misconfigured or bypassed, the public hostname answers 403. Signature, issuer and *this app's* audience are all checked. |
| **Host guard** | Any hostname not listed answers 421. Stops DNS rebinding against a LAN service with no login, and a half-configured public name answers 503 rather than serving a desktop. |
| **Server-side sessions** | The browser sends a connection *ID*. The server looks up the VNC password, encrypts the connection token, and keeps it: the browser only ever holds an opaque handle that works **once**, within 60 s, for the identity that minted it. |
| **Origin + `X-VNCGW` header** | Cross-site POSTs and cross-site WebSocket hijacking are refused. |
| **Free-form allowlist** | "Connect to an address" accepts IPv4 literals in `ALLOWED_CIDRS` on `ALLOWED_PORTS` only. Hostnames are refused, so DNS cannot be used to redirect it. |
| **Rate limit** | Session minting is limited per user (or per LAN address), so it cannot be used to guess VNC passwords or sweep the allowlisted range. |
| **Containers** | App runs as non-root on a read-only filesystem with no capabilities. `guacd` has no published port; it has no authentication of its own. |
| **Headers** | Strict CSP, `frame-ancestors 'none'`, `X-Robots-Tag: noindex`, no referrer. |

**On the LAN there is no login**, by design and the same as learnbox: anyone who
can reach `<lxc-ip>:8088` can open the desktops in `connections.json`. Narrow
the Windows firewall rule for TCP 5900 to the LXC's address so the VNC server
itself is only reachable through the gateway, and never forward port 8088 on
the router.

VNC's own password is 8 characters of weak DES. It is a speed bump on the LAN,
not a control; the layers above are the controls.

---

## Deploy

### New container

On the Proxmox host. It asks for the address, shows a plan, and asks before
creating anything (2 vCPU / 2 GB / 8 GB, unprivileged, `nesting=1,keyctl=1`):

```bash
curl -fsSLO https://raw.githubusercontent.com/eiyanproject/vnc-gateway/main/proxmox/create-lxc.sh
bash create-lxc.sh
```

### Update an existing container

On the Proxmox node that hosts it. Plan only until `--yes`; `--snapshot` gives a
rollback point:

```bash
curl -fsSLO https://raw.githubusercontent.com/eiyanproject/vnc-gateway/main/proxmox/update-lxc.sh
bash update-lxc.sh --ctid <CTID>
bash update-lxc.sh --ctid <CTID> --snapshot --yes
```

The update runs `install.sh` inside the container. It is idempotent: it keeps
your `.env`, token key and `connections.json`, adds settings new versions
introduce, retires obsolete ones as comments, and then **checks the gates on the
running app** — an unknown hostname must get 421 and a public hostname without a
token must get 403, or the update fails loudly.

Sizing, storage backends and the LXC feature flags are in
[docs/lxc-setup.md](docs/lxc-setup.md).

### The Windows side

TightVNC Server: set a password, keep port 5900, then restrict the Windows
Firewall rule for TCP 5900 to the gateway LXC's IP. Windows 11 Home has no RDP
host, so VNC is the right protocol for this machine.

### Saved connections

`/opt/vnc-gateway/connections.json`, readable only by the app:

```json
[
  { "id": "desk", "label": "Windows desktop", "hostname": "192.168.0.213", "port": 5900, "password": "..." },
  { "id": "lab",  "label": "Lab box", "hostname": "192.168.0.50", "password": "...",
    "allowedUsers": ["you@example.com"] }
]
```

`allowedUsers` restricts who may use a connection **through Cloudflare Access**.
LAN users are trusted and see everything. Restart after editing:
`docker compose -f /opt/vnc-gateway/docker-compose.yml restart app`.

---

## Configuration (`.env`)

| Key | Default | |
|---|---|---|
| `TOKEN_ENCRYPTION_KEY` | generated | 32 characters. Encrypts connection tokens. |
| `HOST_PORT` | `8088` | Port on the LXC. |
| `ALLOWED_HOSTS` | container name | LAN hostnames besides IPs and `localhost`. |
| `ACCESS_HOSTS` / `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` | empty | Public hostname behind Cloudflare Access. All three or none. Set via `update-lxc.sh --access-*`. |
| `ALLOWED_CIDRS` | the LXC's subnet | Free-form targets and kept profiles. Empty disables both. |
| `ALLOWED_PORTS` | `5900,5901` | Free-form target ports. |
| `SESSION_TTL_SECONDS` | `60` | Life of an unused session handle. |
| `IDLE_TIMEOUT_MINUTES` | `15` | Close a session after this long without input. `0` = never. |
| `SESSIONS_PER_MINUTE` | `20` | Per user (Access) or per address (LAN). |
| `RECORDING` | `0` | `1` records every session into `recordings/`. |
| `LOG_LEVEL` | `info` | |
| `LOG_DRIVER` | `journald` if present | Docker log driver; otherwise `local`, which rotates. |

---

## Operations

**Logs** — one JSON object per line (`ts`, `level`, `msg`, `svc`) via journald
to VictoriaLogs. They double as the audit trail: `session minted`, `session
opened`, `session denied`, `request refused` and `websocket refused` carry the
user, the target and the reason. Passwords and tokens are never logged.

```bash
docker compose -f /opt/vnc-gateway/docker-compose.yml logs -f app
```

**Health and metrics** — the homelab service contract:

| | |
|---|---|
| `GET /healthz` | liveness, version |
| `GET /readyz` | 503 unless guacd is reachable and any public hostname is fully configured |
| `GET /metrics` | `vncgw_build_info`, `vncgw_requests_total{route,method,status}`, `vncgw_request_duration_seconds{route}`, `vncgw_errors_total{kind}`, plus `vncgw_active_sessions` and `vncgw_sessions_total{kind}` |

Register it with the monitoring stack once per node (homelab-monitoring):

```bash
./scripts/register-service.sh --ctid <mon CTID> --service vnc-gateway --target <lxc-ip>:8088 --yes
```

`errors_total{kind}` kinds: `host_rejected`, `access_no_token`, `access_denied`,
`access_unconfigured`, `access_keys_unavailable`, `csrf_rejected`,
`origin_rejected`, `sid_rejected`, `rate_limited`, `connection_denied`,
`allowlist_denied`, `target_busy`, `guacd`, `not_ready`, `internal`.

**Kept profiles** live in `/opt/vnc-gateway/data/profiles.json` (name, host,
port per user; no passwords). It is the only state the app writes; include it in
backups if you care about the list.

The one-session lock compares the address as written, so an IP and a hostname
for the same machine count as two desktops. Keep `connections.json` on IP
addresses to make it reliable.

**Recordings** — with `RECORDING=1`, guacd writes one file per session into
`/opt/vnc-gateway/recordings/` (Guacamole protocol dumps; convert to video with
`guacenc` from the guacamole-server package). They contain everything that was
on screen. Nothing deletes them automatically.

---

## Tests

| | |
|---|---|
| `bash test/run-unit.sh` | 61 unit + integration tests: allowlist, sessions, Access JWT (valid, wrong audience/issuer, expired, unknown key, foreign key, `alg:none`), host guard, CSRF, WebSocket gates, rate limiting, profiles (never a password, per-user), the one-session lock, idle sweep, logs. Boots the real server. |
| `bash test/e2e/run.sh` | Real Chromium → app → guacd → a real VNC server, on the production compose file: pixels, fit-to-window scaling, mouse mapping, keyboard, clipboard both ways, keep profile → connect, takeover and Reconnect across two windows, remembered prefs, idle close, recording, metrics, CSP. |
| `bash test/run-scripts.sh` | `create-lxc.sh`, `update-lxc.sh`, `setup-oci.sh` and `install.sh` against stubbed Proxmox / OCI hosts, plus shellcheck. |

All need only Docker.

---

## Layout

```
src/            server: index (wiring), guard (host + Access), access (JWT),
                sessions (handles, one-session lock, idle), profiles,
                allowlist, ratelimit, metrics, log, config
public/         the page; guacamole-common-js is wrapped into vendor/ at build
proxmox/        create-lxc.sh, update-lxc.sh   (run on the Proxmox host)
oci/            setup-oci.sh                   (run on the OCI tunnel host)
install.sh      runs inside the container; install and update
docs/           REMOTE-ACCESS.md, lxc-setup.md, HANDOVER.md
test/           unit/, integration/, e2e/, scripts/
```
