# Stage 2 — Docker in a Proxmox LXC

Running Docker inside an unprivileged LXC works fine on Proxmox 8, but it needs
two features enabled that are off by default. Without them Docker installs
cleanly and then fails at the first `docker run`, which makes the cause hard to
spot.

## 1. Create the container

Debian 12 or 13 template. Unprivileged is fine and worth keeping.

Suggested: 2 vCPU, 2 GB RAM, 8 GB disk. guacd is C and frugal; the Node app is
small. Most of the load is pixel encoding, which is CPU, not memory.

## 2. Enable nesting and keyctl

In the Proxmox UI: select the container → **Options** → **Features** → tick
**Nesting** and **keyctl**.

Or on the Proxmox host, edit `/etc/pve/lxc/<CTID>.conf` and add:

```
features: nesting=1,keyctl=1
```

Then restart the container. What these do:

- **nesting** allows the container to mount the filesystems Docker's storage
  driver needs. Missing this gives overlay mount errors on first run.
- **keyctl** gives Docker access to the kernel keyring. Missing this fails in a
  much more confusing way — usually a permission error from containerd that
  reads like a bug in Docker.

## 3. Install Docker

```bash
apt update && apt install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list
apt update && apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
```

Verify before going further:

```bash
docker run --rm hello-world
```

If that fails, it's the features flags — go back to step 2. Don't reach for
`lxc.apparmor.profile: unconfined`; it's the usual forum advice and it works,
but it removes a meaningful isolation layer from a container you're about to
expose to the internet.

## 4. Deploy

Copy the project in, then:

```bash
cp .env.example .env && cp connections.example.json connections.json
```

Set `TOKEN_ENCRYPTION_KEY` in `.env`, and in `connections.json` change
`hostname` from `host.docker.internal` to the **Windows box's LAN IP** — the
LXC reaches it directly over the LAN, so no tunnel is needed for that hop.

```bash
docker compose up -d --build
docker compose logs -f
```

## 5. Lock down the Windows side

Now that you know the LXC's IP, narrow the Windows Firewall rule for TCP 5900 to
accept only that address. Until Stage 3 exists, that firewall rule *is* your
perimeter.

## Notes

- `extra_hosts: host.docker.internal:host-gateway` on the `guacd` service maps
  that name to the LXC itself. It's only useful if you run a VNC server on the
  LXC — for the Windows target you want the LAN IP.
- If the container is ever migrated or restored, re-check the features flags.
  They live in the container config, not the disk image.
