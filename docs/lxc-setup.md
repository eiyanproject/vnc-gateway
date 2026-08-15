# Stage 2 — Docker in a Proxmox LXC

Running Docker inside an unprivileged LXC works fine on Proxmox 8, but it needs
two features enabled that are off by default. Without them Docker installs
cleanly and then fails at the first `docker run`, which makes the cause hard to
spot.

## The scripted path

On the **Proxmox host**, as root — this creates the container with the
recommended specs, enables the feature flags, and installs vnc-gateway inside:

```bash
CT_IP=192.168.1.20/24 CT_GW=192.168.1.1 bash proxmox/create-lxc.sh
```

Everything below is what that script does, for when you'd rather do it by hand
or need to understand a failure.

## 1. Create the container

Debian 12 or 13 template. Unprivileged is fine and worth keeping.

### Specs

|  | vCPU | RAM | Disk | Good for |
|---|---|---|---|---|
| Minimum | 1 | 1 GB | 6 GB | Works, but stutters when a window drags |
| **Recommended** | **2** | **2 GB** | **8 GB** | 1–2 sessions, room for the build |
| Comfortable | 4 | 4 GB | 16 GB | 3–4 sessions, 4K, or session recording |

The thing that scales is **CPU, not RAM**. guacd decodes RFB framebuffer updates
and re-encodes them as PNG/JPEG tiles for the browser, which is pure pixel work:
a static desktop is 10–30% of a core, dragging windows or playing video can
saturate one. At idle the whole stack is ~350 MB (Docker daemon ~150, Debian
~100, the Node app ~80, guacd near-nothing until someone connects), and each
live session adds roughly 100–200 MB. If it ever feels sluggish, add vCPU —
adding RAM will not help.

Bandwidth, since it is the other commonly undersized thing: roughly 1–5 Mbit/s
per session for ordinary desktop use, considerably more for video.

### Check your storage backend first

If the container's rootfs lands on **ZFS**, Docker's `overlay2` driver could not
run on it until ZFS 2.2, which shipped in Proxmox VE 8.1. On older setups Docker
falls back to `fuse-overlayfs` or the `vfs` driver, and `vfs` is painfully slow.
The failure looks like a Docker bug rather than a storage problem, which is what
makes it expensive. On LVM-thin or directory storage this is a non-issue.

`create-lxc.sh` checks this for you and refuses to continue silently.

### Give it a static IP

Or a DHCP reservation. The Windows Firewall rule restricting port 5900
references this container's address — if it moves after a reboot, VNC stops
working and it looks like a VNC fault rather than a DHCP one.

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
