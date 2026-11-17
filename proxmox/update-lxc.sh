#!/usr/bin/env bash
# Updates the vnc-gateway LXC from the Proxmox host: optional snapshot, then
# runs install.sh inside the container, which pulls, rebuilds and self-checks.
#
# RUN THIS ON THE PROXMOX HOST, on the node that hosts the container.
#
#   curl -fsSLO https://raw.githubusercontent.com/eiyanproject/vnc-gateway/main/proxmox/update-lxc.sh
#   bash update-lxc.sh --ctid 103                     # plan only
#   bash update-lxc.sh --ctid 103 --snapshot --yes    # rollback point, then update
#
# To serve a public hostname through Cloudflare Access, pass all three. They are
# written into the container's .env and never stored on the host. See
# docs/REMOTE-ACCESS.md for where each value comes from.
#
#   bash update-lxc.sh --ctid 103 --snapshot --yes \
#     --access-host <your-hostname> \
#     --access-team <team>.cloudflareaccess.com \
#     --access-aud  <64-hex audience tag>
#
# Nothing is changed until you pass --yes. Without it you get the plan only.
set -euo pipefail

CTID=""; DIR="/opt/vnc-gateway"; SNAPSHOT="no"; CONFIRM="no"
REPO="https://github.com/eiyanproject/vnc-gateway.git"; BRANCH="main"
ACCESS_HOST=""; ACCESS_TEAM=""; ACCESS_AUD=""

die() { echo "error: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ctid)        CTID="${2:-}"; shift 2 ;;
    --dir)         DIR="${2:-}"; shift 2 ;;
    --repo)        REPO="${2:-}"; shift 2 ;;
    --branch)      BRANCH="${2:-}"; shift 2 ;;
    --snapshot)    SNAPSHOT="yes"; shift ;;
    --access-host) ACCESS_HOST="${2:-}"; shift 2 ;;
    --access-team) ACCESS_TEAM="${2:-}"; shift 2 ;;
    --access-aud)  ACCESS_AUD="${2:-}"; shift 2 ;;
    --yes)         CONFIRM="yes"; shift ;;
    -h|--help)     sed -n '2,21p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

command -v pct >/dev/null || die "pct not found - run this on the Proxmox host"
[[ -n "$CTID" ]] || die "--ctid is required"
[[ "$CTID" =~ ^[0-9]+$ ]] || die "--ctid must be a number"

# All three Access values or none: one or two of three would make the hostname
# fail closed, and that is better caught here than in a browser.
if [[ -n "$ACCESS_HOST$ACCESS_TEAM$ACCESS_AUD" ]]; then
  [[ -n "$ACCESS_HOST" && -n "$ACCESS_TEAM" && -n "$ACCESS_AUD" ]] ||
    die "--access-host, --access-team and --access-aud go together (see docs/REMOTE-ACCESS.md)"
  ACCESS_HOST="${ACCESS_HOST,,}"
  ACCESS_TEAM="${ACCESS_TEAM,,}"; ACCESS_TEAM="${ACCESS_TEAM#https://}"; ACCESS_TEAM="${ACCESS_TEAM%/}"
  [[ "$ACCESS_HOST" =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]] || die "--access-host does not look like a hostname: $ACCESS_HOST"
  [[ "$ACCESS_TEAM" =~ ^[a-z0-9-]+\.cloudflareaccess\.com$ ]] || die "--access-team should be <team>.cloudflareaccess.com, got: $ACCESS_TEAM"
  [[ "$ACCESS_AUD" =~ ^[0-9a-f]{64}$ ]] || die "--access-aud should be the 64-character hex Application Audience tag"
fi

pct status "$CTID" &>/dev/null || die "CTID $CTID does not exist on this node (run on the node that hosts it)"
[[ "$(pct status "$CTID")" == "status: running" ]] || die "CTID $CTID is not running"

in_ct() { pct exec "$CTID" -- bash -c "$1"; }

if pct exec "$CTID" -- test -d "$DIR/.git"; then
  MODE="update"
  in_ct "git -C '$DIR' fetch -q origin" 2>/dev/null || true
  CURRENT=$(in_ct "git -C '$DIR' rev-parse --short HEAD" 2>/dev/null || echo "?")
  LATEST=$(in_ct "git -C '$DIR' rev-parse --short 'origin/$BRANCH'" 2>/dev/null || echo "?")
  VERSION_LINE="$CURRENT -> $LATEST"
else
  MODE="install"
  VERSION_LINE="no checkout at $DIR -> $BRANCH of $REPO"
fi

FEATURES_WARN=""
if ! pct config "$CTID" | grep -qE '^features:.*nesting=1'; then
  FEATURES_WARN="  WARNING       nesting=1 is not set; Docker will not run:
                pct set $CTID --features nesting=1,keyctl=1 && pct reboot $CTID"
fi

SNAPNAME="pre_update_$(date +%Y%m%d_%H%M)"
IP=$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}' || true)

cat <<PLAN

  Plan
  ----
  container     $CTID  ($(pct config "$CTID" | awk '/^hostname:/ {print $2}'), ${IP:-no ip})
  mode          $MODE
  version       $VERSION_LINE
  snapshot      $( [[ "$SNAPSHOT" == "yes" ]] && echo "$SNAPNAME" || echo "none (pass --snapshot for a rollback point)" )
  access        $( [[ -n "$ACCESS_HOST" ]] && echo "$ACCESS_HOST via $ACCESS_TEAM (aud ${ACCESS_AUD:0:6}...)" || echo "left as configured in the container" )
$FEATURES_WARN

PLAN

if [[ "$CONFIRM" != "yes" ]]; then
  echo "  Dry run. Nothing was changed. Re-run with --yes to apply."
  exit 0
fi

if [[ "$SNAPSHOT" == "yes" ]]; then
  echo "==> snapshot $SNAPNAME"
  pct snapshot "$CTID" "$SNAPNAME" --description "before vnc-gateway update ($VERSION_LINE)"
fi

# Passed for this one exec; install.sh validates them again and writes them
# into the container's .env. Never written to a file on the host.
RUN_ENV=(env "VNCGW_DIR=$DIR" "VNCGW_REPO=$REPO" "VNCGW_REF=$BRANCH")
if [[ -n "$ACCESS_HOST" ]]; then
  RUN_ENV+=("ACCESS_HOSTS=$ACCESS_HOST" "ACCESS_TEAM_DOMAIN=$ACCESS_TEAM" "ACCESS_AUD=$ACCESS_AUD")
fi

if [[ "$MODE" == "install" ]]; then
  echo "==> installing"
  in_ct "command -v curl >/dev/null || { apt-get update -qq && apt-get install -y -qq curl ca-certificates >/dev/null; }"
  in_ct "curl -fsSL 'https://raw.githubusercontent.com/eiyanproject/vnc-gateway/$BRANCH/install.sh' -o /root/vncgw-install.sh"
  pct exec "$CTID" -- "${RUN_ENV[@]}" bash /root/vncgw-install.sh
else
  echo "==> updating"
  # Run the CURRENT installer, not the one already on disk: install.sh is what
  # learns about new settings, so it has to be the new version.
  in_ct "git -C '$DIR' fetch -q origin '$BRANCH' && git -C '$DIR' show 'origin/$BRANCH:install.sh' > /root/vncgw-install.sh"
  pct exec "$CTID" -- "${RUN_ENV[@]}" bash /root/vncgw-install.sh
fi

echo
echo "  Done. vnc-gateway is at http://${IP:-<ct ip>}:8088"
if [[ "$SNAPSHOT" == "yes" ]]; then
  cat <<SNAP
  Roll back:         pct rollback $CTID $SNAPNAME
  Delete when happy: pct delsnapshot $CTID $SNAPNAME
  (snapshots older than 14 days raise a monitoring alert)
SNAP
fi
