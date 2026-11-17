#!/bin/bash
# proxmox/create-lxc.sh against stubbed pct/pvesm/pveam/pvesh/dpkg/ip/ping.
# Run through test/run-scripts.sh (Debian container, repo mounted at /src).
set -u
mkdir -p /stub /out /out/conf
export PATH=/stub:$PATH
export PVE_CONF_DIR=/out/conf   # never /etc/pve/lxc

cat > /stub/pvesm <<'EOF'
#!/bin/bash
H="Name             Type     Status           Total            Used       Available        %"
if [ "$2" = "--content" ]; then
  echo "$H"; echo "local            dir      active        10000000         500000         9500000    5.00%"
elif [ "$2" = "--storage" ]; then
  echo "$H"; echo "$3            ${STUB_STORE_TYPE:-dir}      active        10000000         500000         9500000    5.00%"
fi
EOF
cat > /stub/pvesh <<'EOF'
#!/bin/bash
echo 100
EOF
# A real mirror lists every architecture. That is what made the old
# `sort -V | tail -1` pick arm64 on an amd64 host.
cat > /stub/pveam <<'EOF'
#!/bin/bash
case "$1" in
  update) exit 0 ;;
  available)
    echo "system           debian-12-standard_12.7-1_amd64.tar.zst"
    echo "system           debian-12-standard_12.2-1_amd64.tar.zst"
    echo "system           debian-12-standard_12.7-1_arm64.tar.zst"
    echo "system           debian-13-standard_13.6-1_arm64.tar.zst"
    [ "${STUB_NO_AMD_13:-0}" = "1" ] || echo "system           debian-13-standard_13.6-1_amd64.tar.zst" ;;
  list) exit 0 ;;
  download) exit 0 ;;
esac
EOF
cat > /stub/pct <<'EOF'
#!/bin/bash
case "$1" in
  status) exit 1 ;;
  create) printf '%s\n' "$@" > /out/create.args; exit 0 ;;
  start)  [ "${STUB_START_FAILS:-0}" = "1" ] && exit 1; exit 0 ;;
  exec)   shift 2
          case "$*" in
            *getent*)   exit 0 ;;
            *"ip -o"*)  echo "2: eth0    inet ${STUB_CT_CIDR:-192.168.0.30/24} brd 192.168.0.255 scope global eth0" ;;
            *hostname*) echo "${STUB_CT_CIDR:-192.168.0.30/24}" | cut -d/ -f1 ;;
            *sed*)      printf '%s\n' "$@" >> /out/sed.calls; exit 0 ;;
            *)          exit 0 ;;
          esac ;;
esac
EOF
cat > /stub/ip <<'EOF'
#!/bin/bash
[ "$1" = "route" ] && echo "default via 192.168.0.1 dev vmbr0 proto kernel"
exit 0
EOF
cat > /stub/ping <<'EOF'
#!/bin/bash
[ "${STUB_PING_ALIVE:-0}" = "1" ] && exit 0
exit 1
EOF
cat > /stub/dpkg <<'EOF'
#!/bin/bash
[ "$1" = "--print-architecture" ] && echo "${STUB_DEB_ARCH:-amd64}"
exit 0
EOF
chmod +x /stub/*
: > /out/key.pub

pass=0; fail=0
ok()   { echo "PASS  $1"; pass=$((pass+1)); }
no()   { echo "FAIL  $1"; fail=$((fail+1)); }
has()  { if grep -qx -- "$2" /out/create.args 2>/dev/null; then ok "$1"; else no "$1 -- '$2' not in create args"; fi; }
saw()  { case "$2" in *"$3"*) ok "$1";; *) no "$1";; esac; }

S=/src/proxmox/create-lxc.sh
K=/out/key.pub
run() { rm -f /out/create.args; bash $S "$@" </dev/null 2>&1; }   # non-interactive

echo "############ syntax ############"
bash -n $S && ok "bash -n clean"
if shellcheck -S warning $S; then ok "shellcheck clean (warning+)"; else no "shellcheck findings"; fi

echo; echo "############ plan until --yes ############"
out=$(CT_IP=dhcp CT_SSHKEY=$K RUN_INSTALLER=0 run)
saw "no terminal and no --yes prints the plan" "$out" "Dry run. Nothing was changed"
[ -f /out/create.args ] && no "dry run must not call pct create" || ok "dry run did not create anything"

rm -f /out/create.args
printf '2\nn\n' | script -qec "CT_SSHKEY=$K RUN_INSTALLER=0 bash $S" /dev/null > /out/i0 2>&1
[ -f /out/create.args ] && no "answering N at the prompt must not create" || ok "answering N at the prompt creates nothing"

echo; echo "############ interactive ############"
rm -f /out/create.args
printf '1\n192.168.0.30\n24\n\ny\n' | script -qec "CT_SSHKEY=$K RUN_INSTALLER=0 bash $S" /dev/null > /out/i1 2>&1
has "static IP from prompts" "name=eth0,bridge=vmbr0,ip=192.168.0.30/24,gw=192.168.0.1"
saw "gateway defaulted from the host route" "$(cat /out/i1)" "Gateway [192.168.0.1]"

rm -f /out/create.args
printf '1\n192.168.0.44/25\n\ny\n' | script -qec "CT_SSHKEY=$K RUN_INSTALLER=0 bash $S" /dev/null > /out/i2 2>&1
has "prefix typed inline is honoured" "name=eth0,bridge=vmbr0,ip=192.168.0.44/25,gw=192.168.0.1"

rm -f /out/create.args
printf '2\ny\n' | script -qec "CT_SSHKEY=$K RUN_INSTALLER=0 bash $S" /dev/null > /out/i3 2>&1
has "DHCP from prompts" "name=eth0,bridge=vmbr0,ip=dhcp"
saw "DHCP warns about the firewall rule" "$(cat /out/i3)" "Set a reservation"

rm -f /out/create.args
printf '1\n999.1.2.3\nnot-an-ip\n192.168.0.31\n24\n\ny\n' | script -qec "CT_SSHKEY=$K RUN_INSTALLER=0 bash $S" /dev/null > /out/i4 2>&1
has "bad input re-asks, then succeeds" "name=eth0,bridge=vmbr0,ip=192.168.0.31/24,gw=192.168.0.1"

rm -f /out/create.args
out=$(printf '1\n192.168.0.20\n24\nn\n' | script -qec "STUB_PING_ALIVE=1 CT_SSHKEY=$K RUN_INSTALLER=0 bash $S" /dev/null 2>&1)
saw "detects an address already in use" "$out" "already answers ping"
saw "aborts when that is declined" "$out" "pick a free address"

echo; echo "############ non-interactive with --yes ############"
out=$(CT_IP=192.168.0.30/24 CT_GW=192.168.0.1 CT_SSHKEY=$K RUN_INSTALLER=0 run --yes)
has "2 cores" "2"; has "2048 MB" "2048"; has "512 MB swap" "512"; has "8 GB rootfs" "local:8"
has "unprivileged" "--unprivileged"; has "nesting+keyctl" "nesting=1,keyctl=1"; has "onboot" "--onboot"
has "static net0" "name=eth0,bridge=vmbr0,ip=192.168.0.30/24,gw=192.168.0.1"
has "newest template for the host arch" "local:vztmpl/debian-13-standard_13.6-1_amd64.tar.zst"
saw "plan is shown before creating" "$out" "Plan"

echo; echo "############ validation ############"
saw "IP without prefix" "$(CT_IP=192.168.0.30 CT_GW=192.168.0.1 run --yes)" "must include a prefix length"
saw "static IP needs a gateway" "$(CT_IP=192.168.0.30/24 run --yes)" "CT_GW is required"
saw "octet > 255" "$(CT_IP=300.1.1.1/24 CT_GW=192.168.0.1 run --yes)" "not a valid IPv4"
saw "missing ssh key" "$(CT_SSHKEY=/nope CT_IP=dhcp run --yes)" "CT_SSHKEY does not exist"
saw "unknown argument" "$(run --frobnicate)" "unknown argument"

echo; echo "############ template architecture ############"
STUB_DEB_ARCH=amd64 CT_IP=dhcp CT_SSHKEY=$K RUN_INSTALLER=0 run --yes >/dev/null
has "amd64 host gets amd64" "local:vztmpl/debian-13-standard_13.6-1_amd64.tar.zst"
grep -q arm64 /out/create.args && no "arm64 leaked into create args" || ok "no arm64 in create args"
STUB_DEB_ARCH=arm64 CT_IP=dhcp CT_SSHKEY=$K RUN_INSTALLER=0 run --yes >/dev/null
has "arm64 host gets arm64" "local:vztmpl/debian-13-standard_13.6-1_arm64.tar.zst"
STUB_NO_AMD_13=1 CT_IP=dhcp CT_SSHKEY=$K RUN_INSTALLER=0 run --yes >/dev/null
has "falls back to Debian 12 of the right arch" "local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst"
out=$(STUB_DEB_ARCH=riscv64 CT_IP=dhcp CT_SSHKEY=$K RUN_INSTALLER=0 run --yes)
saw "unknown arch falls back to amd64" "$out" "falling back to amd64"

echo; echo "############ ALLOWED_CIDRS from the real subnet ############"
for c in "192.168.0.30/24:192.168.0.0/24" "10.20.37.99/20:10.20.32.0/20" "172.16.200.5/16:172.16.0.0/16"; do
  rm -f /out/sed.calls
  STUB_CT_CIDR="${c%%:*}" CT_IP=dhcp CT_SSHKEY=$K RUN_INSTALLER=1 run --yes >/dev/null
  saw "${c%%:*} -> ${c##*:}" "$(cat /out/sed.calls 2>/dev/null)" "ALLOWED_CIDRS=${c##*:}"
done

echo; echo "############ AppArmor ############"
: > /out/conf/100.conf
out=$(APPARMOR_ENABLED_FILE=/nonexistent CT_IP=dhcp CT_SSHKEY=$K RUN_INSTALLER=0 run --yes)
saw "kernel without AppArmor is detected" "$out" "No usable AppArmor"
grep -q "^lxc.apparmor.profile: unconfined" /out/conf/100.conf && ok "unconfined written only there" || no "conf not written"

echo Y > /out/aa_on; : > /out/conf/100.conf
CT_IP=dhcp CT_SSHKEY=$K RUN_INSTALLER=0 APPARMOR_ENABLED_FILE=/out/aa_on run --yes >/dev/null
grep -q unconfined /out/conf/100.conf && no "capable kernel must keep its AppArmor profile" || ok "capable kernel keeps its profile"

: > /out/conf/100.conf
out=$(STUB_START_FAILS=1 APPARMOR_ENABLED_FILE=/out/aa_on CT_IP=dhcp CT_SSHKEY=$K RUN_INSTALLER=0 run --yes)
saw "a failed start stops with the debug command" "$out" "lxc-start -n 100 -F -l DEBUG"
grep -q unconfined /out/conf/100.conf && no "a failed start must NOT disable AppArmor" || ok "a failed start does not weaken the container"

echo; echo "############ ZFS guard ############"
echo "2.1.11-pve1" > /out/zold; echo "2.2.6-pve1" > /out/znew
out=$(STUB_STORE_TYPE=zfspool ZFS_VERSION_FILE=/out/zold CT_IP=dhcp CT_SSHKEY=$K RUN_INSTALLER=0 run --yes)
saw "warns on ZFS 2.1" "$out" "predates overlayfs support"; saw "aborts with no TTY" "$out" "no terminal to confirm"
saw "ALLOW_OLD_ZFS=1 overrides" "$(ALLOW_OLD_ZFS=1 STUB_STORE_TYPE=zfspool ZFS_VERSION_FILE=/out/zold CT_IP=dhcp CT_SSHKEY=$K RUN_INSTALLER=0 run --yes)" "continuing anyway"
saw "accepts ZFS 2.2" "$(STUB_STORE_TYPE=zfspool ZFS_VERSION_FILE=/out/znew CT_IP=dhcp CT_SSHKEY=$K RUN_INSTALLER=0 run --yes)" "new enough for overlayfs"

echo; echo "############ host guard ############"
saw "refuses to run off-host" "$(PATH=/usr/bin:/bin bash $S --yes </dev/null 2>&1)" "run this on the Proxmox HOST"

echo; echo "======== create-lxc: $pass passed, $fail failed ========"
[ "$fail" -eq 0 ]
