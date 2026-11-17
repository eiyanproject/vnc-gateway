# Reaching vnc-gateway from outside the house

Target: `https://<your-hostname>`, reachable only by you.

vnc-gateway hands out **a live desktop**. It has no login of its own on the LAN,
so every layer here matters. Do not shorten this setup, and never open a port on
the router.

The path is the one `learnbox`, `l18.` and `cms.` already use:

```
you ─https─▶ Cloudflare edge ─Access check─▶ Tunnel ─▶ OCI box
                                                      cloudflared ─▶ Caddy
                                                                      │ Tailscale
                                                                      ▼
                                                        vnc-gateway LXC :8088
```

Three protections, each independent:

1. **Cloudflare Access** in front: one-time PIN to your email; nobody else ever
   reaches the origin.
2. **vnc-gateway verifies the Access token itself.** Requests for the public
   hostname must carry a valid, unexpired Cloudflare Access JWT signed by your
   team, with this application's audience tag — on every page, API call and
   WebSocket. If Access is removed, misconfigured or bypassed, it answers 403.
3. **No open ports.** The tunnel dials out; the LXC is reachable only on the LAN
   and over Tailscale.

LAN access by IP keeps working unchanged, without a token.

## Choosing the hostname

Pick one that is **not guessable**. `vnc.`, `remote.`, `desktop.`, `rdp.` and the
like are probed by scanners within minutes of a DNS record appearing. Something
like `quiet-otter-7.<domain>` costs nothing.

Keep it **one level deep** (`name.<domain>`, not `a.b.<domain>`). Behind the
tunnel the origin has no certificate of its own, and Cloudflare's Universal SSL
certificate covers `*.<domain>` as a wildcard, so a first-level name never
appears individually in Certificate Transparency logs — the usual way new
subdomains get discovered. A deeper name needs a dedicated edge certificate that
*does* list it. The name is still visible to anyone who can query your DNS zone,
so treat obscurity as noise reduction, not protection: Access is the protection.

`X-Robots-Tag: noindex` and `<meta name="robots">` are set on every response,
and Access redirects crawlers to its login page anyway.

## 1. Cloudflare: Access application first

In Zero Trust → Access → Applications:

1. **Add an application** → Self-hosted.
   - Application domain: `<your-hostname>`
   - Session duration: **8 hours or shorter**. This is a desktop.
2. **Policy**: Action *Allow*, Include → *Emails* → your address. That is the only
   rule; leave no bypass rule.
3. After saving, open the application's **Overview** and copy the **Application
   Audience (AUD) tag** (64 hex characters).
4. Note your **team domain**: Zero Trust → Settings → Custom Pages shows
   `https://<team>.cloudflareaccess.com`. You need `<team>.cloudflareaccess.com`.

Do this **before** the DNS record exists, so the name is never reachable without
the gate. (The gateway would refuse it anyway — see step 3 — but there is no
reason to rely on the second layer alone.)

## 2. OCI box: Caddy, tunnel ingress, DNS

`oci/setup-oci.sh` does it in the house style: marked blocks, backup, validate,
rollback, plan until `--yes`. Copy it to the OCI host and run as root:

```bash
sudo ./setup-oci.sh --host <your-hostname> --gateway-ip <lxc-lan-ip>          # plan
sudo ./setup-oci.sh --host <your-hostname> --gateway-ip <lxc-lan-ip> --yes    # apply
```

It refuses to publish when:

- the gateway does not answer `/healthz` from the OCI box (check the Tailscale
  subnet route and `--accept-routes`), or
- the gateway answers the hostname **with 200 without a token** — that would be
  an open desktop.

It leaves other services' blocks alone (its marker is its own), detects a
token-managed tunnel and prints the dashboard steps instead of editing a file
that would be ignored, and prints the DNS command:

```bash
cloudflared tunnel route dns <TUNNEL_NAME_OR_ID> <your-hostname>
```

Caddy passes the original `Host` and `Cf-Access-Jwt-Assertion` headers through
and proxies WebSockets without extra configuration.

## 3. Arm the gateway's own token check

From the Proxmox host:

```bash
bash update-lxc.sh --ctid <CTID> --snapshot --yes \
  --access-host <your-hostname> \
  --access-team <team>.cloudflareaccess.com \
  --access-aud  <the AUD tag from step 1>
```

All three go together; one or two of three is refused, because a half-configured
hostname fails closed. The values are passed to the container for that one
command and written to its `.env`; nothing is stored on the host.

Until this step, the hostname answers **421**: the gateway refuses names it was
not told about. After it, `install.sh` checks the gate on the running app and
fails the update unless a token-less request gets 403.

## 4. Check it

- In a browser: Cloudflare asks for your email, sends a PIN, then the gateway
  loads with your address top-right. Open a desktop: WebSockets work through the
  tunnel.
- Without a token, from anywhere:

  ```bash
  curl -sS -o /dev/null -w '%{http_code}\n' https://<your-hostname>/
  ```

  **302** to the Access login. If you ever see **200**, stop and re-check the
  Access policy.

- Spoofing the hostname from the LAN is refused by the gateway itself:

  ```bash
  curl -sS -H 'Host: <your-hostname>' http://<lxc-ip>:8088/healthz
  # {"error":"access denied"}   (403)
  ```

## Troubleshooting

| Symptom | Cause |
|---|---|
| **421** on the public URL | `ACCESS_HOSTS` does not list the name. Run step 3. Do **not** put it in `ALLOWED_HOSTS` instead: that accepts the name *without* checking the token. |
| **503** "requires Cloudflare Access verification" | Name listed, team domain or audience missing. Re-run step 3 with all three. |
| **403** "access denied" | Token missing, expired, or for another application. `docker compose logs app` shows the reason (`wrong audience`, `expired`, ...). |
| Cloudflare answers 200 or 421 instead of **302** | The Access application does not cover the hostname. Fix that first; the gateway's check is the second layer, not the first. |
| Page loads, desktop says "Could not reach the gateway" after a while | The Access session expired mid-use. Reload to sign in again; an open session is not cut off, but new requests need a fresh token. |
| Clipboard "copy to this device" does nothing on the LAN | Browsers only allow clipboard writes on https. Through Cloudflare it works; on `http://` use the Clipboard panel's text box. |

## Notes

- **Key rotation**: Cloudflare rotates its signing keys; the gateway caches them
  for an hour and re-fetches immediately on an unknown key id.
- **Stopping**: remove the hostname from `ACCESS_HOSTS`, then delete the Access
  application, the DNS record, the ingress rule and the Caddy block. A DNS
  record pointing at the tunnel with no Access application is the one dangerous
  combination — the gateway would still refuse it, but nothing should depend on
  that.
- Do not put the gateway behind a plain Cloudflare proxy without Access, a
  "hidden" URL alone, or basic auth in Caddy alone. It is a desktop.
