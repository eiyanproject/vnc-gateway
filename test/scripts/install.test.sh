#!/bin/bash
# install.sh in a clean Debian container, cloning from a local copy of the repo,
# with docker/curl/systemctl/hostname stubbed. Runs it twice to prove it is an
# idempotent updater that never clobbers .env or connections.json.
set -u
git config --global --add safe.directory '*'
git config --global user.email t@t; git config --global user.name t
mkdir -p /stub
export PATH=/stub:$PATH

cat > /stub/docker <<'EOF'
#!/bin/sh
case "$1" in
  info) exit 0 ;;
  --version) echo "Docker version stub" ;;
  compose) echo "VNCGW_COMMIT=${VNCGW_COMMIT:-} $*" >> /tmp/compose.log ;;
esac
exit 0
EOF
cat > /stub/curl <<'EOF'
#!/bin/sh
case "$*" in
  *"Host: rebind-check.invalid"*) printf '%s' "${STUB_REBIND:-421}" ;;
  *"-H Host:"*)                   printf '%s' "${STUB_GATE:-403}" ;;
  *readyz*)                       printf '{"status":"ready"}' ;;
  *healthz*)                      printf '{"status":"ok","version":"0.2.0"}' ;;
esac
EOF
cat > /stub/systemctl <<'EOF'
#!/bin/sh
[ "$1" = "is-active" ] && [ "${STUB_JOURNALD:-1}" = "1" ] && exit 0
exit 3
EOF
cat > /stub/hostname <<'EOF'
#!/bin/sh
case "$1" in -s) echo "Vnc-Gateway" ;; -I) echo "192.168.0.30 " ;; esac
EOF
chmod +x /stub/*

# The repo as it would be on GitHub: a clean clone of the mounted tree.
cp -r /src /repo && cd /repo && rm -rf node_modules .env connections.json recordings
git add -A >/dev/null && git commit -qm "test snapshot" --allow-empty
cd /

pass=0; fail=0
ok() { echo "PASS  $1"; pass=$((pass+1)); }
no() { echo "FAIL  $1"; fail=$((fail+1)); }
saw() { case "$2" in *"$3"*) ok "$1";; *) no "$1 -- wanted '$3'";; esac; }
kv() { grep -E "^$1=" /opt/vnc-gateway/.env | tail -1 | cut -d= -f2-; }
inst() { VNCGW_REPO=/repo VNCGW_DIR=/opt/vnc-gateway bash /repo/install.sh 2>&1; }
D=/opt/vnc-gateway
AUD=$(printf 'b%.0s' $(seq 1 64))

echo "############ syntax ############"
bash -n /src/install.sh && ok "bash -n clean"
if shellcheck -S warning /src/install.sh; then ok "shellcheck clean (warning+)"; else no "shellcheck findings"; fi

echo; echo "############ fresh install ############"
out=$(inst); rc=$?
[ $rc -eq 0 ] && ok "exits 0" || { no "exit $rc"; echo "$out" | tail -15; }
K1=$(kv TOKEN_ENCRYPTION_KEY)
[ ${#K1} -eq 32 ] && ok "token key generated (32 chars)" || no "key length ${#K1}"
[ "$(kv ALLOWED_HOSTS)" = "vnc-gateway" ] && ok "ALLOWED_HOSTS = container name, lowercased" || no "ALLOWED_HOSTS=$(kv ALLOWED_HOSTS)"
[ "$(kv LOG_DRIVER)" = "journald" ] && ok "journald log driver when journald runs" || no "LOG_DRIVER=$(kv LOG_DRIVER)"
[ "$(stat -c %a $D/.env)" = 600 ] && ok ".env is 600" || no ".env mode $(stat -c %a $D/.env)"
[ "$(stat -c '%a %u' $D/connections.json)" = "600 1000" ] && ok "connections.json is 600, owned by the app's uid" || no "connections.json $(stat -c '%a %u' $D/connections.json)"
[ "$(stat -c '%a %u' $D/recordings)" = "700 1000" ] && ok "recordings/ is 700, owned by guacd's uid" || no "recordings $(stat -c '%a %u' $D/recordings)"
saw "build is told the commit" "$(cat /tmp/compose.log)" "VNCGW_COMMIT=$(git -C $D rev-parse --short HEAD)"
saw "host guard self-check runs" "$out" "unknown hostnames refused (421)"
saw "no public hostname: says LAN only" "$out" "LAN only"

echo; echo "############ update keeps what you set ############"
sed -i 's/"password": "[^"]*"/"password": "MY-REAL-PW"/' $D/connections.json
echo "CUSTOM=keepme" >> $D/.env
sed -i 's/^ALLOWED_HOSTS=.*/ALLOWED_HOSTS=my-own-name/' $D/.env
# a pre-0.2 .env, and a setting that appeared upstream since install
printf 'AUTH_MODE=local\nCF_ACCESS_AUD=old\n' >> $D/.env
sed -i '/^RECORDING=/d' $D/.env
echo "NEW_UPSTREAM=on" >> /repo/.env.example && git -C /repo commit -qam "new setting"
out=$(inst)
[ "$(kv TOKEN_ENCRYPTION_KEY)" = "$K1" ] && ok "key preserved" || no "key regenerated"
grep -q MY-REAL-PW $D/connections.json && ok "connections.json preserved" || no "connections.json clobbered"
[ "$(kv CUSTOM)" = keepme ] && ok "custom setting preserved" || no "custom setting lost"
[ "$(kv ALLOWED_HOSTS)" = my-own-name ] && ok "ALLOWED_HOSTS you set is kept" || no "ALLOWED_HOSTS overwritten"
[ "$(kv NEW_UPSTREAM)" = on ] && ok "new upstream setting merged in" || no "new setting not merged"
[ "$(kv RECORDING)" = 0 ] && ok "missing setting restored with its default" || no "RECORDING=$(kv RECORDING)"
grep -q '^AUTH_MODE=' $D/.env && no "obsolete AUTH_MODE still active" || ok "obsolete AUTH_MODE retired"
grep -q '^# obsolete since 0.2 (see ACCESS_\*): CF_ACCESS_AUD=old' $D/.env && ok "retired line kept as a comment" || no "retired line not kept"
[ "$(grep -c '^TOKEN_ENCRYPTION_KEY=' $D/.env)" = 1 ] && ok "no duplicated keys" || no "duplicate keys"

echo; echo "############ Cloudflare Access ############"
out=$(ACCESS_HOSTS=vnc-x.example.com inst); rc=$?
[ $rc -ne 0 ] && saw "one of three refused" "$out" "go together" || no "accepted a partial Access config"
before=$(md5sum < $D/.env)
out=$(ACCESS_HOSTS=vnc-x.example.com ACCESS_TEAM_DOMAIN=t.cloudflareaccess.com ACCESS_AUD=nothex inst)
saw "bad audience refused" "$out" "64-character hex"
[ "$before" = "$(md5sum < $D/.env)" ] && ok "refused input changes nothing" || no ".env changed despite refusal"

out=$(ACCESS_HOSTS=VNC-X.Example.com ACCESS_TEAM_DOMAIN=https://T.cloudflareaccess.com/ ACCESS_AUD=$AUD inst); rc=$?
[ $rc -eq 0 ] && ok "valid Access config accepted" || { no "exit $rc"; echo "$out" | tail -5; }
[ "$(kv ACCESS_HOSTS)" = vnc-x.example.com ] && ok "host lowercased into .env" || no "ACCESS_HOSTS=$(kv ACCESS_HOSTS)"
[ "$(kv ACCESS_TEAM_DOMAIN)" = t.cloudflareaccess.com ] && ok "team domain normalised" || no "TEAM=$(kv ACCESS_TEAM_DOMAIN)"
[ "$(kv ACCESS_AUD)" = "$AUD" ] && ok "audience stored" || no "AUD wrong"
saw "gate self-check confirms 403" "$out" "without a token is refused (403)"

out=$(inst)
[ "$(kv ACCESS_AUD)" = "$AUD" ] && ok "a plain update keeps the Access config" || no "update dropped Access config"

echo; echo "############ self-checks fail loudly ############"
out=$(STUB_GATE=200 inst); rc=$?
[ $rc -ne 0 ] && saw "an open public hostname fails the install" "$out" "ACCESS GATE NOT ENFORCED" || no "200 on the public hostname passed"
out=$(STUB_REBIND=200 inst); rc=$?
[ $rc -ne 0 ] && saw "a broken host guard fails the install" "$out" "Host guard NOT working" || no "broken host guard passed"

echo; echo "############ no journald ############"
sed -i 's/^LOG_DRIVER=.*/LOG_DRIVER=/' $D/.env
STUB_JOURNALD=0 inst >/dev/null
[ -z "$(kv LOG_DRIVER)" ] && ok "LOG_DRIVER left empty (local) without journald" || no "LOG_DRIVER=$(kv LOG_DRIVER)"

echo; echo "======== install: $pass passed, $fail failed ========"
[ "$fail" -eq 0 ]
