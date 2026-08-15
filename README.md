# vnc-gateway

Browser-based VNC gateway. `guacd` handles the RFB protocol; a small Node app
owns authentication, target selection, and token minting; the frontend is
`guacamole-common-js` with no build step.

Built in stages. **Stage 1 is local-only and has no login** — that is deliberate,
not an oversight. Get pixels on screen first, then add the perimeter.

---

## Stage 1 — make it work on your LAN

### 1. A VNC server on the Windows box

Install TightVNC Server. In its settings:

- set a primary password (max 8 chars — that's a VNC protocol limit, not a bug)
- note the port, default `5900`
- allow it through Windows Firewall

> Windows 11 Home Single Language has no RDP *host*, so VNC is the right call
> here — the usual "just use RDP through Guacamole, it's faster" advice doesn't
> apply to this machine.

Once it works, tighten the Windows Firewall rule for port 5900 to accept only
the gateway's IP. VNC's own auth is 8 characters of weak DES — treat it as a
speed bump, not a control.

### 2. Configure

```bash
cp .env.example .env
cp connections.example.json connections.json
```

Generate the key (must be exactly 32 characters):

```bash
docker run --rm node:22-alpine node -e "console.log(require('crypto').randomBytes(24).toString('base64').slice(0,32))"
```

Put it in `.env` as `TOKEN_ENCRYPTION_KEY`, then edit `connections.json`:

- **testing from the same machine as Docker**: leave `hostname` as
  `host.docker.internal`
- **running on the Proxmox LXC**: set `hostname` to the Windows box's LAN IP

### 3. Run

```bash
docker compose up --build
```

Open <http://localhost:8088> and click the connection. You should get a desktop.

(Port 8088 because `catalog-api-dev` already owns 8080 on this machine. Change
`HOST_PORT` in `.env` if you want something else.)

---

## What Stage 1 already does right

The security model is in place even though the login isn't:

- **The browser never sees a VNC password or the encryption key.** It sends a
  connection *ID*; the server looks up the credential and mints the token. Most
  guacamole-lite examples build the token client-side, which hands the client
  both the key and free choice of target.
- **Session handles are single-use and expire in 60s**, checked during the
  WebSocket upgrade before guacamole-lite sees the request.
- **`guacd` is not published.** It has no authentication whatsoever, so it stays
  inside the compose network.
- **Free-form IPs are allowlisted by CIDR and port**, and hostnames are refused
  outright to close off DNS rebinding. Empty `ALLOWED_CIDRS` disables it.

Every deferred piece is marked in the source with `[STAGE n: ...]`.

### Verified

The gates were exercised against the running stack:

| Test | Result |
|---|---|
| WebSocket upgrade, no `sid` | 401 |
| WebSocket upgrade, forged `sid` | 401 |
| WebSocket upgrade, valid `sid` | accepted, guacd creates a VNC client |
| Same `sid` replayed | 401 |
| `POST /api/sessions` for `192.168.1.50:5900` | 200 (in `ALLOWED_CIDRS`) |
| `POST /api/sessions` for `8.8.8.8` | 403, logged as DENIED |
| `POST /api/sessions` for `192.168.2.50` | 403, adjacent subnet |
| `POST /api/sessions` for `192.168.1.50:22` | 403, port not allowed |
| `POST /api/sessions` for a hostname | 403, DNS-rebinding guard |
| `GET /api/connections` | labels + IDs only, no hostname or password |
| guacd port 4822 from the host | not reachable |

The only untested link is guacd → an actual VNC server, which needs TightVNC
running on the Windows box.

---

## Stage 2 — deploy to the Proxmox LXC

### If you have no container yet

Run this on the **Proxmox host** as root. It creates an unprivileged LXC with
the recommended specs (2 vCPU / 2 GB / 8 GB, `nesting=1,keyctl=1`, `onboot`),
then installs vnc-gateway inside it:

```bash
CT_IP=192.168.1.20/24 CT_GW=192.168.1.1 bash proxmox/create-lxc.sh
```

It picks the newest Debian template and an appropriate storage automatically,
refuses to run anywhere but a Proxmox host, and stops if the rootfs storage is
ZFS older than 2.2 (where Docker's `overlay2` driver cannot run). Use
`CT_SSHKEY=/root/.ssh/id_ed25519.pub` to inject a key instead of being prompted
for a root password. Sizing rationale and the full list of overrides are in
[docs/lxc-setup.md](docs/lxc-setup.md).

### If the container already exists

As root inside it:

```bash
curl -fsSL https://raw.githubusercontent.com/eiyanproject/vnc-gateway/main/install.sh | bash
```

Then edit `/opt/vnc-gateway/connections.json` — set `hostname` to the Windows
box's LAN IP — and restart:

```bash
docker compose -f /opt/vnc-gateway/docker-compose.yml restart app
```

### Updating

Re-run the same script. That *is* the update path:

```bash
bash /opt/vnc-gateway/install.sh
```

It is idempotent. It pulls the latest source, rebuilds, and:

- **keeps** your `.env`, your generated `TOKEN_ENCRYPTION_KEY`, and your
  `connections.json`
- **adds** any new setting that has appeared in `.env.example` since you
  installed, so new options arrive without clobbering your values
- checks the Proxmox `nesting=1,keyctl=1` flags up front, because without them
  Docker installs cleanly and then fails at the first `docker run` — which is a
  confusing way to find out

Overrides: `VNCGW_DIR` (default `/opt/vnc-gateway`), `VNCGW_REPO`, `VNCGW_REF`.

Manual setup, and the detail on the LXC feature flags, is in
[docs/lxc-setup.md](docs/lxc-setup.md).

## Stage 3 — Cloudflare Tunnel + Access

Deferred until the domain exists. When you get there:

1. Create a tunnel, add `cloudflared` to `docker-compose.yml`, point the ingress
   rule at `http://app:8080`.
2. Change the app's port mapping to `127.0.0.1:8080:8080` so only the tunnel can
   reach it.
3. Create an Access application for the hostname. Copy its **Application
   Audience (AUD) tag**.
4. Set `AUTH_MODE=cloudflare`, `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` in `.env`.
5. **Verify the gate is real**: with the tunnel up, `curl` the LXC's IP:8080
   directly. It must return 401, not the app. If it returns the app, the JWT
   check isn't running.

Two things that bite here:
- WebSockets through the tunnel work, but add an app-level keepalive so idle
  sessions aren't reaped by an intermediate timeout.
- Use a **wildcard certificate** if you ever terminate TLS yourself. Every
  publicly-trusted cert is published to Certificate Transparency logs, and
  subdomain-enumeration services scrape them continuously — a cert for
  `vnc.yourdomain.com` makes that hostname public knowledge within minutes.
  Behind a Cloudflare tunnel your origin has no public cert at all, which sides
  steps this entirely.

## Stage 4 — hardening

- Per-user authorisation on connections (`src/index.js`, marked)
- Postgres for connections + an audit log (currently a JSON file + stdout)
- Rate-limit `/api/sessions`
- Session recording via guacd's `recording-path`
