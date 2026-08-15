#!/usr/bin/env bash
#
# Create a Proxmox LXC for vnc-gateway, with the recommended specs:
#   2 vCPU / 2 GB RAM / 512 MB swap / 8 GB disk, unprivileged, nesting+keyctl.
#
# RUN THIS ON THE PROXMOX HOST, as root -- not inside a container.
#
#   Just run it. It asks for what it needs:
#     bash create-lxc.sh
#
#   Or skip the questions (for automation):
#     CT_IP=192.168.0.30/24 CT_GW=192.168.0.1 bash create-lxc.sh
#     CT_IP=dhcp bash create-lxc.sh
#
# Overrides (all optional; anything unset is prompted for or defaulted):
#   CTID           container ID            (default: next free)
#   CT_HOSTNAME    hostname                (default: vnc-gateway)
#   CT_CORES       vCPUs                   (default: 2)
#   CT_RAM         RAM in MB               (default: 2048)
#   CT_SWAP        swap in MB              (default: 512)
#   CT_DISK        disk in GB              (default: 8)
#   CT_BRIDGE      network bridge          (default: vmbr0)
#   CT_SSHKEY      path to a public key    (default: none, password prompt)
#   ROOT_STORE     rootfs storage          (default: first active rootdir store)
#   TEMPLATE_STORE template storage        (default: first active vztmpl store)
#   RUN_INSTALLER  install vnc-gateway too (default: 1)

set -euo pipefail

CT_HOSTNAME="${CT_HOSTNAME:-vnc-gateway}"
CT_CORES="${CT_CORES:-2}"
CT_RAM="${CT_RAM:-2048}"
CT_SWAP="${CT_SWAP:-512}"
CT_DISK="${CT_DISK:-8}"
CT_BRIDGE="${CT_BRIDGE:-vmbr0}"
CT_IP="${CT_IP:-}"
CT_GW="${CT_GW:-}"
CT_SSHKEY="${CT_SSHKEY:-}"
RUN_INSTALLER="${RUN_INSTALLER:-1}"
INSTALLER_URL="https://raw.githubusercontent.com/eiyanproject/vnc-gateway/main/install.sh"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m warn\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m fail\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root on the Proxmox host"
command -v pct    >/dev/null 2>&1 || die "pct not found -- run this on the Proxmox HOST, not inside a container"
command -v pvesm  >/dev/null 2>&1 || die "pvesm not found -- is this really a Proxmox host?"

# --- Storage ----------------------------------------------------------------
# Column layout of `pvesm status` is: Name Type Status Total Used Available %
ROOT_STORE="${ROOT_STORE:-$(pvesm status --content rootdir | awk 'NR>1 && $3=="active" {print $1; exit}')}"
TEMPLATE_STORE="${TEMPLATE_STORE:-$(pvesm status --content vztmpl | awk 'NR>1 && $3=="active" {print $1; exit}')}"

[ -n "$ROOT_STORE" ]     || die "no active storage with 'rootdir' content -- set ROOT_STORE=..."
[ -n "$TEMPLATE_STORE" ] || die "no active storage with 'vztmpl' content -- set TEMPLATE_STORE=..."

say "rootfs storage:   $ROOT_STORE"
say "template storage: $TEMPLATE_STORE"

# guacd only has arm64 images from 1.6.0 onward; docker-compose.yml pins that.
HOST_ARCH="$(uname -m)"
case "$HOST_ARCH" in
  x86_64|amd64|aarch64|arm64) say "host architecture: $HOST_ARCH" ;;
  *) warn "host architecture is '$HOST_ARCH'; guacd publishes amd64 and arm64 only." ;;
esac

# --- ZFS / overlayfs check --------------------------------------------------
# Docker's overlay2 driver could not run on ZFS-backed container rootfs until
# ZFS 2.2 (shipped in Proxmox VE 8.1). On older ZFS you get pushed onto
# fuse-overlayfs or the vfs driver, and vfs is painfully slow. The failure looks
# like a Docker bug rather than a storage problem, so check it here instead.
ZFS_VERSION_FILE="${ZFS_VERSION_FILE:-/sys/module/zfs/version}"
ROOT_TYPE="$(pvesm status --storage "$ROOT_STORE" | awk 'NR>1 {print $2; exit}')"
if [ "$ROOT_TYPE" = "zfspool" ]; then
  if [ -r "$ZFS_VERSION_FILE" ]; then
    ZVER="$(cut -d- -f1 < "$ZFS_VERSION_FILE")"
    ZMAJ="${ZVER%%.*}"
    ZREST="${ZVER#*.}"
    ZMIN="${ZREST%%.*}"
    if [ "$ZMAJ" -lt 2 ] || { [ "$ZMAJ" -eq 2 ] && [ "$ZMIN" -lt 2 ]; }; then
      warn "rootfs storage '$ROOT_STORE' is ZFS $ZVER, which predates overlayfs support (needs 2.2+)."
      warn "Docker will fall back to a slow storage driver, or fail outright."
      warn "Either upgrade Proxmox, or pass ROOT_STORE=<an LVM-thin or directory storage>."
      if [ "${ALLOW_OLD_ZFS:-0}" = "1" ]; then
        warn "ALLOW_OLD_ZFS=1 set -- continuing anyway."
      elif [ -t 0 ]; then
        printf '  continue anyway? [y/N] '
        read -r reply || reply=""
        case "$reply" in
          [yY]*) ;;
          *) die "aborted" ;;
        esac
      else
        # No terminal to prompt at (piped, or run from a script). Failing loudly
        # beats a silent exit that looks like the script just stopped working.
        die "aborted: old ZFS and no terminal to confirm at. Re-run with ROOT_STORE=<lvm-thin or dir storage>, or ALLOW_OLD_ZFS=1 to override."
      fi
    else
      say "ZFS $ZVER -- new enough for overlayfs, good."
    fi
  fi
fi

# --- Container ID -----------------------------------------------------------
CTID="${CTID:-$(pvesh get /cluster/nextid)}"
if pct status "$CTID" >/dev/null 2>&1; then
  die "CTID $CTID already exists -- pass CTID=<free id>"
fi
say "container ID: $CTID"

# --- Template ---------------------------------------------------------------
say "Refreshing template list..."
pveam update >/dev/null

TEMPLATE_NAME=""
for series in debian-13-standard debian-12-standard; do
  TEMPLATE_NAME="$(pveam available --section system | awk '{print $2}' | grep -E "^${series}" | sort -V | tail -1 || true)"
  if [ -n "$TEMPLATE_NAME" ]; then
    break
  fi
done
[ -n "$TEMPLATE_NAME" ] || die "could not find a Debian 12/13 template in 'pveam available'"

if pveam list "$TEMPLATE_STORE" | grep -q "$TEMPLATE_NAME"; then
  say "Template already downloaded: $TEMPLATE_NAME"
else
  say "Downloading template: $TEMPLATE_NAME"
  pveam download "$TEMPLATE_STORE" "$TEMPLATE_NAME"
fi
TEMPLATE_REF="${TEMPLATE_STORE}:vztmpl/${TEMPLATE_NAME}"

# --- Network ----------------------------------------------------------------
valid_ipv4() {
  case "$1" in
    *[!0-9.]*|"") return 1 ;;
  esac
  local o count=0
  local IFS=.
  for o in $1; do
    count=$((count + 1))
    case "$o" in ""|*[!0-9]*) return 1 ;; esac
    [ "$o" -le 255 ] || return 1
  done
  [ "$count" -eq 4 ]
}

# Network address for a given IP + prefix, e.g. 192.168.0.30 24 -> 192.168.0.0/24
cidr_network() {
  local ip="$1" bits="$2" a b c d ipint mask net
  local IFS=.
  read -r a b c d <<EOF2
$ip
EOF2
  ipint=$(( (a << 24) + (b << 16) + (c << 8) + d ))
  if [ "$bits" -eq 0 ]; then mask=0; else mask=$(( (0xFFFFFFFF << (32 - bits)) & 0xFFFFFFFF )); fi
  net=$(( ipint & mask ))
  printf '%d.%d.%d.%d/%d\n' $(( (net >> 24) & 255 )) $(( (net >> 16) & 255 )) $(( (net >> 8) & 255 )) $(( net & 255 )) "$bits"
}

HOST_GW="$(ip route 2>/dev/null | awk '/^default/ {print $3; exit}' || true)"

# Ask, rather than making the caller assemble environment variables. Anything
# already set via the environment is taken as-is, so automation still works.
if [ -z "$CT_IP" ] && [ -t 0 ]; then
  echo
  echo "  How should the container get its address?"
  echo "    1) Static IP  (recommended -- the Windows firewall rule will point at it)"
  echo "    2) DHCP"
  printf '  Choose [1]: '
  read -r choice || choice=""
  case "${choice:-1}" in
    2) CT_IP="dhcp" ;;
    *)
      while :; do
        printf '  IP address for the container (e.g. 192.168.0.30): '
        read -r ans || ans=""
        # Accept either a bare IP or one with a prefix already attached.
        case "$ans" in
          */*) ipaddr="${ans%%/*}"; prefix="${ans##*/}" ;;
          *)   ipaddr="$ans"; prefix="" ;;
        esac
        if valid_ipv4 "$ipaddr"; then
          break
        fi
        warn "Not a valid IPv4 address: '$ans'"
      done

      if [ -z "$prefix" ]; then
        printf '  Prefix length [24]: '
        read -r prefix || prefix=""
        prefix="${prefix:-24}"
      fi

      # Catch the obvious mistake before Proxmox commits to it.
      if ping -c1 -W1 "$ipaddr" >/dev/null 2>&1; then
        warn "$ipaddr already answers ping -- something is using it."
        printf '  Use it anyway? [y/N] '
        read -r yn || yn=""
        case "$yn" in
          [yY]*) ;;
          *) die "aborted -- re-run and pick a free address" ;;
        esac
      fi

      while :; do
        printf '  Gateway [%s]: ' "${HOST_GW:-192.168.0.1}"
        read -r gw || gw=""
        gw="${gw:-${HOST_GW:-192.168.0.1}}"
        if valid_ipv4 "$gw"; then
          break
        fi
        warn "Not a valid IPv4 address: '$gw'"
      done

      CT_IP="${ipaddr}/${prefix}"
      CT_GW="$gw"
      ;;
  esac
  echo
fi

CT_IP="${CT_IP:-dhcp}"

if [ "$CT_IP" = "dhcp" ]; then
  warn "Using DHCP. Set a reservation for this container on your router."
  warn "The Windows Firewall rule that restricts VNC to this gateway references"
  warn "its IP -- if the address moves after a reboot, VNC silently stops working"
  warn "and it looks like a VNC fault rather than a DHCP one."
  NET0="name=eth0,bridge=${CT_BRIDGE},ip=dhcp"
else
  case "$CT_IP" in
    */*) ;;
    *) die "CT_IP must include a prefix length, e.g. 192.168.0.30/24" ;;
  esac
  [ -n "$CT_GW" ] || die "CT_GW is required when CT_IP is static, e.g. CT_GW=192.168.0.1"
  valid_ipv4 "${CT_IP%%/*}" || die "CT_IP is not a valid IPv4 address: ${CT_IP%%/*}"
  valid_ipv4 "$CT_GW"       || die "CT_GW is not a valid IPv4 address: $CT_GW"
  NET0="name=eth0,bridge=${CT_BRIDGE},ip=${CT_IP},gw=${CT_GW}"
  say "Static address: ${CT_IP} via ${CT_GW}"
fi

# --- Credentials ------------------------------------------------------------
# An SSH key is the better option. Falling back to a password prompt means you
# type it -- it is never stored in this script or in your shell history.
PCT_AUTH=()
if [ -n "$CT_SSHKEY" ]; then
  [ -f "$CT_SSHKEY" ] || die "CT_SSHKEY does not exist: $CT_SSHKEY"
  PCT_AUTH=(--ssh-public-keys "$CT_SSHKEY")
  say "Using SSH key: $CT_SSHKEY"
else
  warn "No CT_SSHKEY given; pct will prompt you for a root password."
  PCT_AUTH=(--password)
fi

# --- Create -----------------------------------------------------------------
say "Creating container $CTID ($CT_CORES vCPU, ${CT_RAM}MB RAM, ${CT_DISK}GB disk)..."
pct create "$CTID" "$TEMPLATE_REF" \
  --hostname "$CT_HOSTNAME" \
  --cores "$CT_CORES" \
  --memory "$CT_RAM" \
  --swap "$CT_SWAP" \
  --rootfs "${ROOT_STORE}:${CT_DISK}" \
  --net0 "$NET0" \
  --ostype debian \
  --unprivileged 1 \
  --features nesting=1,keyctl=1 \
  --onboot 1 \
  --description "vnc-gateway - browser VNC gateway (guacd + node)" \
  "${PCT_AUTH[@]}"

# --- AppArmor ---------------------------------------------------------------
# Proxmox's ARM builds commonly run a kernel without AppArmor compiled in. LXC
# then fails applying a profile that cannot exist, and `pct start` dies with the
# useless "sync_wait: 34 ... Failed to spawn container". Handle it up front
# instead of leaving a created-but-unstartable container behind.
#
# On a kernel WITH AppArmor this setting would remove real protection. On one
# without it there is nothing to remove -- we are only telling LXC to stop
# trying. Hence the check rather than setting it unconditionally.
APPARMOR_ENABLED_FILE="${APPARMOR_ENABLED_FILE:-/sys/module/apparmor/parameters/enabled}"
PVE_CONF_DIR="${PVE_CONF_DIR:-/etc/pve/lxc}"
CT_CONF="${PVE_CONF_DIR}/${CTID}.conf"

set_unconfined() {
  if grep -q '^lxc.apparmor.profile:' "$CT_CONF" 2>/dev/null; then
    return 0
  fi
  # Never fatal: a container that starts fine without this should not be
  # sunk by an unwritable config path.
  if ! echo "lxc.apparmor.profile: unconfined" >> "$CT_CONF" 2>/dev/null; then
    warn "could not write $CT_CONF -- if the start fails, add this line by hand:"
    warn "    lxc.apparmor.profile: unconfined"
  fi
  return 0
}

APPARMOR_OK=0
if [ -r "$APPARMOR_ENABLED_FILE" ] && grep -qi '^y' "$APPARMOR_ENABLED_FILE" 2>/dev/null; then
  APPARMOR_OK=1
fi

if [ "$APPARMOR_OK" = "0" ]; then
  warn "No usable AppArmor on this kernel (normal on Proxmox ARM builds)."
  warn "Setting 'lxc.apparmor.profile: unconfined' so the container can start."
  set_unconfined
fi

say "Starting..."
if ! pct start "$CTID" >/dev/null 2>&1; then
  # Fallback for the case where AppArmor reports as enabled but the profile
  # still cannot be applied.
  warn "First start failed; retrying without an AppArmor profile..."
  set_unconfined
  if ! pct start "$CTID"; then
    warn "Still failing. Get the real error with:"
    warn "    lxc-start -n $CTID -F -l DEBUG -o /tmp/lxc-$CTID.log"
    warn "Remove the container with: pct destroy $CTID"
    die "container $CTID could not be started"
  fi
fi

# --- Wait for the network ---------------------------------------------------
say "Waiting for network inside the container..."
ready=0
for _ in $(seq 1 30); do
  if pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done
[ "$ready" = "1" ] || warn "Container has no DNS yet; the installer step may fail."

CT_ADDR="$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}' || true)"

# --- Install vnc-gateway ----------------------------------------------------
if [ "$RUN_INSTALLER" = "1" ] && [ "$ready" = "1" ]; then
  say "Installing vnc-gateway inside the container (this pulls Docker, give it a few minutes)..."
  pct exec "$CTID" -- bash -c "apt-get update -qq && apt-get install -y -qq curl ca-certificates"
  pct exec "$CTID" -- bash -c "curl -fsSL ${INSTALLER_URL} | bash"

  # Point the free-form target allowlist at the network the container actually
  # landed on. Guessing this in .env.example is how you end up with an allowlist
  # that silently blocks every real target.
  CT_CIDR="$(pct exec "$CTID" -- ip -o -4 addr show dev eth0 2>/dev/null | awk '{print $4; exit}' || true)"
  if [ -n "$CT_CIDR" ] && [ "${CT_CIDR}" != "${CT_CIDR%/*}" ]; then
    SUBNET="$(cidr_network "${CT_CIDR%%/*}" "${CT_CIDR##*/}")"
    say "Setting ALLOWED_CIDRS to $SUBNET (the container's own subnet)."
    pct exec "$CTID" -- sed -i "s|^ALLOWED_CIDRS=.*|ALLOWED_CIDRS=${SUBNET}|" /opt/vnc-gateway/.env
    pct exec "$CTID" -- docker compose -f /opt/vnc-gateway/docker-compose.yml up -d >/dev/null 2>&1
  else
    warn "Could not determine the container's subnet; set ALLOWED_CIDRS in /opt/vnc-gateway/.env by hand."
  fi
else
  say "Skipping the vnc-gateway installer (RUN_INSTALLER=$RUN_INSTALLER)."
fi

cat <<EOF

  Container    $CTID  ($CT_HOSTNAME)
  Address      ${CT_ADDR:-<check: pct exec $CTID -- hostname -I>}
  Specs        ${CT_CORES} vCPU / ${CT_RAM} MB RAM / ${CT_SWAP} MB swap / ${CT_DISK} GB disk
  Shell        pct enter $CTID

  Next:
    1. pct exec $CTID -- nano /opt/vnc-gateway/connections.json
       Set "hostname" to your Windows box's LAN IP.
    2. pct exec $CTID -- docker compose -f /opt/vnc-gateway/docker-compose.yml restart app
    3. Open http://${CT_ADDR:-<container-ip>}:8088
    4. On Windows, narrow the firewall rule for TCP 5900 to ${CT_ADDR:-<container-ip>} only.

  Update later:  pct exec $CTID -- bash /opt/vnc-gateway/install.sh

  NOTE: Stage 1 runs with AUTH_MODE=local -- there is NO LOGIN. Keep this on a
  trusted LAN until Cloudflare Access is configured (Stage 3 in the README).

EOF
