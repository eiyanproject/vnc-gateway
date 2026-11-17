#!/bin/bash
# oci/setup-oci.sh against a fake OCI host: a Caddyfile and cloudflared config
# that already serve the portfolio and learnbox, with caddy/systemctl/
# cloudflared/curl stubbed. Proves the edits are surgical, idempotent and
# rolled back on failure -- this script rewrites live config.
set -u
mkdir -p /stub /etc/caddy /etc/cloudflared
export PATH=/stub:$PATH

cat > /stub/caddy <<'EOF'
#!/bin/bash
[ "$1" = "validate" ] && exit "${STUB_CADDY_FAIL:-0}"
exit 0
EOF
cat > /stub/systemctl <<'EOF'
#!/bin/bash
if [ "$1" = "cat" ] && [ "$2" = "cloudflared" ]; then
  [ "${STUB_CF:-file}" = "none" ] && exit 1
  if [ "${STUB_CF:-file}" = "token" ]; then echo "ExecStart=/usr/bin/cloudflared tunnel run --token eyJ..."; else echo "ExecStart=/usr/bin/cloudflared --config /etc/cloudflared/config.yml tunnel run"; fi
  exit 0
fi
exit 0
EOF
cat > /stub/cloudflared <<'EOF'
#!/bin/bash
exit 0
EOF
# /healthz answers; with a Host header it answers whatever the gateway would.
cat > /stub/curl <<'EOF'
#!/bin/bash
case "$*" in
  *"-H Host:"*) printf '%s' "${STUB_GATE:-421}" ;;
  *healthz*)    [ "${STUB_DOWN:-0}" = "1" ] && exit 7; printf '{"status":"ok","version":"0.2.0"}' ;;
esac
EOF
chmod +x /stub/*

fixtures() {
  cat > /etc/caddy/Caddyfile <<'EOF'
{
	admin off
}

http://eiyanproject.com {
	root * /var/www/portfolio
	file_server
}

# managed by learnbox setup-oci.sh - do not edit by hand, re-run the script
http://learnbox.eiyanproject.com {
	reverse_proxy 100.1.2.3:8080
}
EOF
  cat > /etc/cloudflared/config.yml <<'EOF'
tunnel: abc
credentials-file: /etc/cloudflared/abc.json
ingress:
  - hostname: eiyanproject.com
    service: http://localhost:80
  # managed by learnbox setup-oci.sh
  - hostname: learnbox.eiyanproject.com
    service: http://localhost:80
  - service: http_status:404
EOF
  rm -f /etc/caddy/Caddyfile.bak.* /etc/cloudflared/config.yml.bak.*
}

pass=0; fail=0
ok() { echo "PASS  $1"; pass=$((pass+1)); }
no() { echo "FAIL  $1"; fail=$((fail+1)); }
saw() { case "$2" in *"$3"*) ok "$1";; *) no "$1 -- wanted '$3'";; esac; }

S=/src/oci/setup-oci.sh
H=quiet-otter-7.example.com

echo "############ syntax ############"
bash -n $S && ok "bash -n clean"
if shellcheck -S warning $S; then ok "shellcheck clean (warning+)"; else no "shellcheck findings"; fi

echo; echo "############ arguments ############"
fixtures
saw "--host is required, no default" "$(bash $S --gateway-ip 192.168.0.30 2>&1)" "--host is required"
saw "bad hostname" "$(bash $S --host 'x y' --gateway-ip 192.168.0.30 2>&1)" "does not look like a hostname"
saw "--gateway-ip required" "$(bash $S --host $H 2>&1)" "--gateway-ip is required"
saw "non-IP gateway" "$(bash $S --host $H --gateway-ip gw.lan 2>&1)" "must be an IPv4 address"
saw "dead origin refused" "$(STUB_DOWN=1 bash $S --host $H --gateway-ip 192.168.0.30 2>&1)" "no answer from 192.168.0.30:8088"
saw "an origin that serves the hostname without a token is refused" "$(STUB_GATE=200 bash $S --host $H --gateway-ip 192.168.0.30 --yes 2>&1)" "Refusing to publish an unprotected desktop"

echo; echo "############ dry run ############"
fixtures; before=$(md5sum /etc/caddy/Caddyfile /etc/cloudflared/config.yml)
out=$(bash $S --host $H --gateway-ip 192.168.0.30 2>&1)
saw "plan shows the gate state" "$out" "not armed yet (421)"
saw "dry run says so" "$out" "Dry run. Nothing was changed"
[ "$before" = "$(md5sum /etc/caddy/Caddyfile /etc/cloudflared/config.yml)" ] && ok "dry run changed no file" || no "dry run modified config"

echo; echo "############ apply ############"
fixtures
out=$(bash $S --host $H --gateway-ip 192.168.0.30 --yes 2>&1)
C=$(cat /etc/caddy/Caddyfile); Y=$(cat /etc/cloudflared/config.yml)
saw "caddy block added" "$C" "http://$H {"
saw "proxies to the gateway" "$C" "reverse_proxy 192.168.0.30:8088"
saw "portfolio block untouched" "$C" "root * /var/www/portfolio"
saw "learnbox block untouched" "$C" "reverse_proxy 100.1.2.3:8080"
ls /etc/caddy/Caddyfile.bak.* >/dev/null 2>&1 && ok "caddyfile backed up" || no "no caddyfile backup"
saw "ingress rule added" "$Y" "- hostname: $H"
saw "learnbox rule untouched" "$Y" "- hostname: learnbox.eiyanproject.com"
last=$(grep -E '^\s*- ' /etc/cloudflared/config.yml | tail -1)
case "$last" in *http_status:404*) ok "catch-all is still last";; *) no "catch-all moved: $last";; esac
pos_new=$(grep -n "hostname: $H" /etc/cloudflared/config.yml | cut -d: -f1)
pos_404=$(grep -n "http_status:404" /etc/cloudflared/config.yml | cut -d: -f1)
[ "$pos_new" -lt "$pos_404" ] && ok "new rule sits above the catch-all" || no "new rule below the catch-all"
saw "Access application step printed first" "$out" "1. ACCESS APPLICATION FIRST"
saw "arming command printed" "$out" "--access-host $H"

echo; echo "############ re-run is idempotent ############"
sleep 1
bash $S --host $H --gateway-ip 192.168.0.31 --yes >/dev/null 2>&1
n_c=$(grep -c "managed by vnc-gateway" /etc/caddy/Caddyfile); n_y=$(grep -c "hostname: $H" /etc/cloudflared/config.yml)
[ "$n_c" = 1 ] && ok "still exactly one caddy block" || no "caddy blocks: $n_c"
[ "$n_y" = 1 ] && ok "still exactly one ingress rule" || no "ingress rules: $n_y"
grep -q "reverse_proxy 192.168.0.31:8088" /etc/caddy/Caddyfile && ok "block updated to the new address" || no "address not updated"
grep -q "reverse_proxy 192.168.0.30:8088" /etc/caddy/Caddyfile && no "old block left behind" || ok "old block removed"
grep -q "reverse_proxy 100.1.2.3:8080" /etc/caddy/Caddyfile && ok "learnbox still untouched after re-run" || no "learnbox block lost"

echo; echo "############ failed validation rolls back ############"
fixtures; before=$(md5sum < /etc/caddy/Caddyfile)
out=$(STUB_CADDY_FAIL=1 bash $S --host $H --gateway-ip 192.168.0.30 --yes 2>&1); rc=$?
[ "$rc" -ne 0 ] && ok "exits non-zero" || no "exited 0 after a failed validation"
saw "says it restored" "$out" "restored"
[ "$before" = "$(md5sum < /etc/caddy/Caddyfile)" ] && ok "Caddyfile is byte-identical to before" || no "Caddyfile left modified"

echo; echo "############ token-managed tunnel ############"
fixtures; before=$(md5sum < /etc/cloudflared/config.yml)
out=$(STUB_CF=token bash $S --host $H --gateway-ip 192.168.0.30 --yes 2>&1)
saw "points at the dashboard instead" "$out" "dashboard-managed"
[ "$before" = "$(md5sum < /etc/cloudflared/config.yml)" ] && ok "config.yml not edited for a token tunnel" || no "edited an ignored file"

echo; echo "======== setup-oci: $pass passed, $fail failed ========"
[ "$fail" -eq 0 ]
