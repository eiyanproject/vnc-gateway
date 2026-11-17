#!/usr/bin/env bash
#
# vnc-gateway installer / updater. Runs INSIDE the container (or any Debian
# host with Docker). From the Proxmox host, use proxmox/update-lxc.sh, which
# calls this.
#
# Re-running this script IS the update path. It is idempotent: it never
# overwrites your .env or connections.json, it only fills in what is missing.
#
#   Install:  bash install.sh
#   Update:   bash /opt/vnc-gateway/install.sh
#
# Cloudflare Access for a public hostname: pass all three, or none. They are
# written into .env; proxmox/update-lxc.sh passes them for one exec only.
#   ACCESS_HOSTS=vnc-xyz.example.com ACCESS_TEAM_DOMAIN=team.cloudflareaccess.com \
#   ACCESS_AUD=<64 hex> bash install.sh
#
# Environment overrides:
#   VNCGW_DIR   install location   (default /opt/vnc-gateway)
#   VNCGW_REPO  git remote to pull (default the public repo)
#   VNCGW_REF   branch or tag      (default main)

set -euo pipefail

VNCGW_DIR="${VNCGW_DIR:-/opt/vnc-gateway}"
VNCGW_REPO="${VNCGW_REPO:-https://github.com/eiyanproject/vnc-gateway.git}"
VNCGW_REF="${VNCGW_REF:-main}"

# Captured before anything reads .env, so they are unambiguously "from the caller".
IN_ACCESS_HOSTS="${ACCESS_HOSTS:-}"
IN_ACCESS_TEAM="${ACCESS_TEAM_DOMAIN:-}"
IN_ACCESS_AUD="${ACCESS_AUD:-}"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m warn\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m fail\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (or under sudo): sudo bash install.sh"

# --- 0. Validate Access input before touching anything ----------------------
if [ -n "$IN_ACCESS_HOSTS$IN_ACCESS_TEAM$IN_ACCESS_AUD" ]; then
  [ -n "$IN_ACCESS_HOSTS" ] && [ -n "$IN_ACCESS_TEAM" ] && [ -n "$IN_ACCESS_AUD" ] ||
    die "ACCESS_HOSTS, ACCESS_TEAM_DOMAIN and ACCESS_AUD go together: a public hostname without the other two fails closed"
  IN_ACCESS_HOSTS="$(printf '%s' "$IN_ACCESS_HOSTS" | tr 'A-Z' 'a-z')"
  IN_ACCESS_TEAM="$(printf '%s' "$IN_ACCESS_TEAM" | tr 'A-Z' 'a-z' | sed -e 's#^https\?://##' -e 's#/*$##')"
  printf '%s' "$IN_ACCESS_HOSTS" | grep -Eq '^[a-z0-9.-]+\.[a-z]{2,}(,[a-z0-9.-]+\.[a-z]{2,})*$' ||
    die "ACCESS_HOSTS does not look like a hostname: $IN_ACCESS_HOSTS"
  printf '%s' "$IN_ACCESS_TEAM" | grep -Eq '^[a-z0-9-]+\.cloudflareaccess\.com$' ||
    die "ACCESS_TEAM_DOMAIN should look like <team>.cloudflareaccess.com, got: $IN_ACCESS_TEAM"
  printf '%s' "$IN_ACCESS_AUD" | grep -Eq '^[0-9a-f]{64}$' ||
    die "ACCESS_AUD should be the 64-character hex Application Audience tag"
fi

# --- 1. LXC sanity check ----------------------------------------------------
# Docker inside an unprivileged Proxmox LXC needs nesting=1 and keyctl=1. Without
# them Docker installs cleanly and then fails at the first `docker run`.
if grep -qa 'container=lxc' /proc/1/environ 2>/dev/null; then
  say "Proxmox LXC detected."
fi

# --- 2. Dependencies --------------------------------------------------------
# Only probe real binaries: ca-certificates is a package, not a command.
need_apt=0
for bin in git curl; do
  command -v "$bin" >/dev/null 2>&1 || need_apt=1
done
if [ "$need_apt" -eq 1 ]; then
  say "Installing base packages..."
  apt-get update -qq
  apt-get install -y -qq git curl ca-certificates
fi

if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker from the official repository..."
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
  systemctl enable --now docker
else
  say "Docker already present: $(docker --version)"
fi

docker info >/dev/null 2>&1 || die "Docker is installed but not working. In an LXC this is almost always missing features: on the Proxmox host, pct set <CTID> --features nesting=1,keyctl=1 && pct reboot <CTID>"

# --- 3. Fetch or update the source -----------------------------------------
if [ -d "$VNCGW_DIR/.git" ]; then
  say "Updating existing install at $VNCGW_DIR ..."
  git -C "$VNCGW_DIR" fetch --quiet origin "$VNCGW_REF"
  git -C "$VNCGW_DIR" checkout --quiet "$VNCGW_REF"
  # Safe: .env, connections.json and recordings/ are gitignored, so the only
  # things discarded are local edits to tracked source files.
  git -C "$VNCGW_DIR" reset --hard --quiet "origin/$VNCGW_REF"
else
  say "Cloning into $VNCGW_DIR ..."
  mkdir -p "$(dirname "$VNCGW_DIR")"
  git clone --quiet --branch "$VNCGW_REF" "$VNCGW_REPO" "$VNCGW_DIR"
fi

cd "$VNCGW_DIR"
COMMIT="$(git rev-parse --short HEAD)"

# --- 4. Config: create if missing, top up if incomplete ---------------------
get_kv() { grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- || true; }

# Replace (or append) KEY=VALUE without sed, so no value can collide with a
# sed delimiter. Values reaching here are validated or generated.
set_kv() {
  local tmp
  tmp="$(mktemp)"
  awk -v k="$1" -v v="$2" '
    index($0, k "=") == 1 { if (!done) { print k "=" v; done = 1 }; next }
    { print }
    END { if (!done) print k "=" v }
  ' .env > "$tmp"
  cat "$tmp" > .env
  rm -f "$tmp"
}

if [ ! -f .env ]; then
  say "Creating .env ..."
  cp .env.example .env
else
  say "Keeping existing .env."
fi

# Settings from before Access became per-hostname. Commented out rather than
# deleted, so nothing you wrote disappears silently.
for old in AUTH_MODE CF_ACCESS_TEAM_DOMAIN CF_ACCESS_AUD; do
  if grep -q "^${old}=" .env; then
    sed -i "s|^${old}=|# obsolete since 0.2 (see ACCESS_*): ${old}=|" .env
    say "Retired obsolete setting $old."
  fi
done

# New settings arrive with updates: append any key in .env.example that .env
# lacks, without touching values already set.
added=""
while IFS= read -r line; do
  case "$line" in
    [A-Z_]*=*)
      key="${line%%=*}"
      if ! grep -q "^${key}=" .env; then
        printf '%s\n' "$line" >> .env
        added="$added $key"
      fi
      ;;
  esac
done < .env.example
# A full `if`: under `set -e` a trailing && list whose test fails ends the script.
if [ -n "$added" ]; then
  say "Added new settings to .env:$added"
fi

# The token key must be exactly 32 bytes; alphanumerics only, so it never needs
# quoting. Not `tr < /dev/urandom | head`: head exits first, tr dies of SIGPIPE,
# and pipefail turns that into an intermittent silent exit.
if grep -q '^TOKEN_ENCRYPTION_KEY=CHANGE_ME' .env || ! grep -q '^TOKEN_ENCRYPTION_KEY=.\{32\}$' .env; then
  say "Generating TOKEN_ENCRYPTION_KEY ..."
  raw="$(head -c 256 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9')"
  newkey="${raw:0:32}"
  [ "${#newkey}" -eq 32 ] || die "could not generate a 32-character key (got ${#newkey})"
  set_kv TOKEN_ENCRYPTION_KEY "$newkey"
else
  say "Keeping existing TOKEN_ENCRYPTION_KEY."
fi

# The container's own name, so http://<hostname>:8088 works on the LAN. Any
# name not listed is refused (DNS rebinding defence).
if [ -z "$(get_kv ALLOWED_HOSTS)" ]; then
  hn="$(hostname -s 2>/dev/null | tr 'A-Z' 'a-z' || true)"
  if [ -n "$hn" ]; then
    set_kv ALLOWED_HOSTS "$hn"
    say "ALLOWED_HOSTS set to this container's name: $hn"
  fi
fi

if [ -n "$IN_ACCESS_HOSTS" ]; then
  set_kv ACCESS_HOSTS "$IN_ACCESS_HOSTS"
  set_kv ACCESS_TEAM_DOMAIN "$IN_ACCESS_TEAM"
  set_kv ACCESS_AUD "$IN_ACCESS_AUD"
  say "Cloudflare Access configured for $IN_ACCESS_HOSTS"
fi

# journald when it runs here, so container logs reach VictoriaLogs through the
# guest's rsyslog. Docker's journald driver fails to start containers without it.
if [ -z "$(get_kv LOG_DRIVER)" ] && systemctl is-active --quiet systemd-journald 2>/dev/null; then
  set_kv LOG_DRIVER journald
  say "Container logs go to journald."
fi

# Must exist before compose runs: it is bind-mounted, and Docker would otherwise
# helpfully create a *directory* at that path.
if [ ! -f connections.json ]; then
  say "Creating connections.json from the example -- EDIT IT before connecting."
  cp connections.example.json connections.json
else
  say "Keeping existing connections.json."
fi

# Secrets: .env holds the token key, connections.json holds VNC passwords. The
# app runs as uid 1000 in its container and must still read connections.json;
# guacd (also uid 1000) writes recordings.
chmod 600 .env
chown 1000:1000 connections.json && chmod 600 connections.json
mkdir -p recordings && chown 1000:1000 recordings && chmod 700 recordings

# --- 5. Build and start -----------------------------------------------------
say "Building and starting $COMMIT ..."
VNCGW_COMMIT="$COMMIT" docker compose up -d --build --remove-orphans

HOST_PORT="$(get_kv HOST_PORT)"
HOST_PORT="${HOST_PORT:-8088}"
BASE="http://127.0.0.1:${HOST_PORT}"

say "Waiting for the app..."
ok=0
for _ in $(seq 1 45); do
  if curl -fsS "$BASE/healthz" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
[ "$ok" = "1" ] || die "app did not answer /healthz within 45s. Check: docker compose -f $VNCGW_DIR/docker-compose.yml logs app"

ready="$(curl -s "$BASE/readyz" || true)"
case "$ready" in
  *'"ready"'*) say "Ready: $ready" ;;
  *) warn "Not ready yet: $ready" ;;
esac

# --- 6. Prove the gates, rather than assume them -----------------------------
code="$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: rebind-check.invalid' "$BASE/healthz" || true)"
if [ "$code" = "421" ]; then
  say "Host guard: unknown hostnames refused (421)."
else
  die "Host guard NOT working: an unknown Host header got $code, expected 421"
fi

ACCESS_HOSTS_NOW="$(get_kv ACCESS_HOSTS)"
if [ -n "$ACCESS_HOSTS_NOW" ]; then
  first="${ACCESS_HOSTS_NOW%%,*}"
  code="$(curl -s -o /dev/null -w '%{http_code}' -H "Host: $first" "$BASE/healthz" || true)"
  case "$code" in
    403) say "Access gate: $first without a token is refused (403)." ;;
    503) warn "Access gate: $first answers 503 -- ACCESS_TEAM_DOMAIN/ACCESS_AUD missing. Failing closed, which is safe, but it will not work until set." ;;
    *)   die "ACCESS GATE NOT ENFORCED: $first without a token got $code. Do not publish this hostname until fixed." ;;
  esac
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
cat <<EOF

  URL          http://${IP:-<this-host>}:${HOST_PORT}
  Version      $(curl -s "$BASE/healthz" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p') ($COMMIT)
  Directory    $VNCGW_DIR
  Logs         docker compose -f $VNCGW_DIR/docker-compose.yml logs -f app
  Update       bash $VNCGW_DIR/install.sh   (or proxmox/update-lxc.sh from the host)

  Saved connections live in $VNCGW_DIR/connections.json. After editing:
    docker compose -f $VNCGW_DIR/docker-compose.yml restart app

  Metrics      http://${IP:-<this-host>}:${HOST_PORT}/metrics  -- register with the
               monitoring stack, once per node (homelab-monitoring):
                 ./scripts/register-service.sh --ctid <mon CTID> --service vnc-gateway --target ${IP:-<ip>}:${HOST_PORT} --yes

EOF
if [ -z "$ACCESS_HOSTS_NOW" ]; then
  cat <<EOF
  No public hostname is configured: LAN only. To publish one behind Cloudflare
  Access, follow docs/REMOTE-ACCESS.md.

EOF
fi
