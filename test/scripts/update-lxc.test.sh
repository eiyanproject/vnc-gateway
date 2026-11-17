#!/bin/bash
# proxmox/update-lxc.sh against a stubbed pct.
set -u
mkdir -p /stub /out
export PATH=/stub:$PATH

cat > /stub/pct <<'EOF'
#!/bin/bash
echo "$*" >> /out/pct.log
case "$1" in
  status)
    [ "$2" = "103" ] || exit 2
    echo "status: ${STUB_STATE:-running}" ;;
  config)
    echo "hostname: vnc-gateway"
    [ "${STUB_NO_NESTING:-0}" = "1" ] || echo "features: keyctl=1,nesting=1" ;;
  snapshot) echo "$*" >> /out/snapshot.log ;;
  exec)
    shift 2  # CTID --
    case "$*" in
      "-- test -d /opt/vnc-gateway/.git") [ "${STUB_CHECKOUT:-1}" = "1" ] ;;
      *"rev-parse --short HEAD"*) echo "aaa1111" ;;
      *"rev-parse --short"*)      echo "bbb2222" ;;
      *"hostname -I"*)            echo "192.168.0.30" ;;
      *"vncgw-install.sh"*" "*bash*|*env*bash*) echo "$*" >> /out/install.log ;;
      *) exit 0 ;;
    esac ;;
esac
EOF
chmod +x /stub/pct

pass=0; fail=0
ok() { echo "PASS  $1"; pass=$((pass+1)); }
no() { echo "FAIL  $1"; fail=$((fail+1)); }
saw() { case "$2" in *"$3"*) ok "$1";; *) no "$1 -- wanted '$3'";; esac; }
reset() { rm -f /out/*.log; }

S=/src/proxmox/update-lxc.sh
AUD=$(printf 'a%.0s' $(seq 1 64))
TEAM=myteam.cloudflareaccess.com

echo "############ syntax ############"
bash -n $S && ok "bash -n clean"
if shellcheck -S warning $S; then ok "shellcheck clean (warning+)"; else no "shellcheck findings"; fi

echo; echo "############ arguments ############"
saw "--ctid required" "$(bash $S 2>&1)" "--ctid is required"
saw "non-numeric ctid" "$(bash $S --ctid abc 2>&1)" "must be a number"
saw "unknown ctid" "$(bash $S --ctid 999 2>&1)" "does not exist"
saw "stopped container" "$(STUB_STATE=stopped bash $S --ctid 103 2>&1)" "is not running"
saw "access all-or-none" "$(bash $S --ctid 103 --access-host vnc-x.example.com 2>&1)" "go together"
saw "bad aud" "$(bash $S --ctid 103 --access-host vnc-x.example.com --access-team $TEAM --access-aud xyz 2>&1)" "64-character hex"
saw "bad team" "$(bash $S --ctid 103 --access-host vnc-x.example.com --access-team evil.example.com --access-aud $AUD 2>&1)" "cloudflareaccess.com"
saw "bad host" "$(bash $S --ctid 103 --access-host 'a b' --access-team $TEAM --access-aud $AUD 2>&1)" "does not look like a hostname"

echo; echo "############ plan only ############"
reset
out=$(bash $S --ctid 103 --snapshot 2>&1)
saw "plan shows the version change" "$out" "aaa1111 -> bbb2222"
saw "plan ends as a dry run" "$out" "Dry run. Nothing was changed"
[ -f /out/snapshot.log ] && no "dry run took a snapshot" || ok "dry run took no snapshot"
[ -f /out/install.log ] && no "dry run ran the installer" || ok "dry run ran nothing"
saw "missing nesting is warned about" "$(STUB_NO_NESTING=1 bash $S --ctid 103 2>&1)" "nesting=1 is not set"

echo; echo "############ apply ############"
reset
out=$(bash $S --ctid 103 --snapshot --yes 2>&1)
saw "snapshot taken before updating" "$(cat /out/snapshot.log 2>/dev/null)" "snapshot 103 pre_update_"
saw "installer ran in the container" "$(cat /out/install.log 2>/dev/null)" "bash /root/vncgw-install.sh"
saw "rollback command printed" "$out" "pct rollback 103 pre_update_"
case "$(cat /out/install.log)" in *ACCESS_*) no "no Access values were given, none must be passed";; *) ok "no Access values passed when none given";; esac

reset
bash $S --ctid 103 --yes --access-host VNC-X.Example.com --access-team "https://MyTeam.cloudflareaccess.com/" --access-aud $AUD >/dev/null 2>&1
log="$(cat /out/install.log 2>/dev/null)"
saw "Access host passed, lowercased" "$log" "ACCESS_HOSTS=vnc-x.example.com"
saw "team domain normalised" "$log" "ACCESS_TEAM_DOMAIN=myteam.cloudflareaccess.com"
saw "audience passed" "$log" "ACCESS_AUD=$AUD"
if grep -rqs "$AUD" /root /tmp /etc 2>/dev/null; then no "Access values written to a host file"; else ok "Access values never written to the host"; fi

reset
STUB_CHECKOUT=0 bash $S --ctid 103 --yes >/dev/null 2>&1
saw "no checkout -> fetches the installer from GitHub" "$(cat /out/pct.log)" "raw.githubusercontent.com/eiyanproject/vnc-gateway/main/install.sh"

echo; echo "======== update-lxc: $pass passed, $fail failed ========"
[ "$fail" -eq 0 ]
