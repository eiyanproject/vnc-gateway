#!/usr/bin/env bash
#
# vnc-gateway installer / updater.
#
# Re-running this script IS the update path. It is idempotent: it never
# overwrites your .env or connections.json, it only fills in things that are
# missing. Safe to run as often as you like.
#
#   Install:  bash install.sh
#   Update:   bash install.sh      (same command, from anywhere)
#
# Environment overrides:
#   VNCGW_DIR   install location   (default /opt/vnc-gateway)
#   VNCGW_REPO  git remote to pull (default the public repo)
#   VNCGW_REF   branch or tag      (default main)

set -euo pipefail

VNCGW_DIR="${VNCGW_DIR:-/opt/vnc-gateway}"
VNCGW_REPO="${VNCGW_REPO:-https://github.com/eiyanproject/vnc-gateway.git}"
VNCGW_REF="${VNCGW_REF:-main}"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m warn\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m fail\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (or under sudo): sudo bash install.sh"

# --- 1. LXC sanity check ----------------------------------------------------
# Docker inside an unprivileged Proxmox LXC needs nesting=1 and keyctl=1. Without
# them Docker installs cleanly and then fails at the first `docker run`, which
# makes the real cause hard to spot -- so check up front rather than later.
if grep -qa 'container=lxc' /proc/1/environ 2>/dev/null || [ -f /run/.containerenv ]; then
  say "Proxmox LXC detected."
  if ! grep -qs 'nesting' /proc/self/mountinfo 2>/dev/null && [ ! -d /sys/fs/cgroup/system.slice ]; then
    warn "Could not confirm nesting is enabled."
    warn "If Docker fails below, set this on the PROXMOX HOST in /etc/pve/lxc/<CTID>.conf:"
    warn "    features: nesting=1,keyctl=1"
    warn "then restart the container. Do NOT reach for apparmor:unconfined instead."
  fi
fi

# --- 2. Dependencies --------------------------------------------------------
# Only probe things that are actually binaries. ca-certificates is a package,
# not a command, so testing it with `command -v` always fails and would drag in
# a full apt-get update on every single run.
need_apt_update=0
for bin in git curl; do
  command -v "$bin" >/dev/null 2>&1 || need_apt_update=1
done

if [ "$need_apt_update" -eq 1 ]; then
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

docker info >/dev/null 2>&1 || die "Docker is installed but not working. In an LXC this is almost always the missing nesting=1,keyctl=1 features flags -- see the warning above."

# --- 3. Fetch or update the source -----------------------------------------
if [ -d "$VNCGW_DIR/.git" ]; then
  say "Updating existing install at $VNCGW_DIR ..."
  git -C "$VNCGW_DIR" fetch --quiet origin "$VNCGW_REF"
  git -C "$VNCGW_DIR" checkout --quiet "$VNCGW_REF"
  # Hard reset is safe here: .env and connections.json are gitignored, so the
  # only things discarded are local edits to tracked source files.
  git -C "$VNCGW_DIR" reset --hard --quiet "origin/$VNCGW_REF"
else
  say "Cloning into $VNCGW_DIR ..."
  mkdir -p "$(dirname "$VNCGW_DIR")"
  git clone --quiet --branch "$VNCGW_REF" "$VNCGW_REPO" "$VNCGW_DIR"
fi

cd "$VNCGW_DIR"

# --- 4. Config: create if missing, top up if incomplete ---------------------
if [ ! -f .env ]; then
  say "Creating .env ..."
  cp .env.example .env
else
  say "Keeping existing .env."
fi

# An update may introduce new settings. Append any key present in .env.example
# but missing from .env, so a re-run picks up new options without clobbering
# values you have already set.
added=""
while IFS= read -r line; do
  case "$line" in
    [A-Z_]*=*)
      key="${line%%=*}"
      grep -q "^${key}=" .env || { printf '%s\n' "$line" >> .env; added="$added $key"; }
      ;;
  esac
done < .env.example
# Written as a full `if` rather than `[ -n "$added" ] && say ...`, because under
# `set -e` a trailing && list whose test fails takes the whole script down.
if [ -n "$added" ]; then
  say "Added new settings to .env:$added"
fi

# The token key must be exactly 32 bytes. Restrict to alphanumerics so the value
# never needs quoting in .env or escaping in sed.
if grep -q '^TOKEN_ENCRYPTION_KEY=CHANGE_ME' .env || ! grep -q '^TOKEN_ENCRYPTION_KEY=.\{32\}$' .env; then
  say "Generating TOKEN_ENCRYPTION_KEY ..."
  # Deliberately NOT `tr -dc ... < /dev/urandom | head -c 32`. /dev/urandom never
  # ends, so head exits first, tr dies of SIGPIPE, and `set -o pipefail` turns
  # that into a silent early exit -- intermittently, depending on who wins the
  # race. Read a bounded chunk and slice it in the shell instead.
  raw="$(head -c 256 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9')"
  newkey="${raw:0:32}"
  [ "${#newkey}" -eq 32 ] || die "could not generate a 32-character key (got ${#newkey})"
  sed -i "s|^TOKEN_ENCRYPTION_KEY=.*|TOKEN_ENCRYPTION_KEY=${newkey}|" .env
else
  say "Keeping existing TOKEN_ENCRYPTION_KEY."
fi

# Must exist before compose runs: it is bind-mounted, and Docker would otherwise
# helpfully create a *directory* at that path.
if [ ! -f connections.json ]; then
  say "Creating connections.json from the example -- EDIT IT before connecting."
  cp connections.example.json connections.json
else
  say "Keeping existing connections.json."
fi

# --- 5. Build and start -----------------------------------------------------
say "Building and starting..."
docker compose up -d --build

HOST_PORT="$(grep -E '^HOST_PORT=' .env | cut -d= -f2 || true)"
HOST_PORT="${HOST_PORT:-8088}"

say "Waiting for the app to come up..."
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${HOST_PORT}/api/health" >/dev/null 2>&1; then
    ok=1; break
  fi
  sleep 1
done

echo
if [ "${ok:-0}" = "1" ]; then
  say "Up and healthy."
else
  warn "App did not answer /api/health within 30s. Check: docker compose -f $VNCGW_DIR/docker-compose.yml logs"
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
cat <<EOF

  URL          http://${IP:-<this-host>}:${HOST_PORT}
  Directory    $VNCGW_DIR
  Logs         docker compose -f $VNCGW_DIR/docker-compose.yml logs -f
  Update       bash $VNCGW_DIR/install.sh

  Next:
    1. Edit $VNCGW_DIR/connections.json -- set hostname to your Windows box's LAN IP.
    2. Restart:  docker compose -f $VNCGW_DIR/docker-compose.yml restart app

  NOTE: AUTH_MODE=local means there is NO LOGIN. This is Stage 1 -- keep it on a
  trusted LAN until Stage 3 (Cloudflare Access) is configured. See README.md.

EOF
