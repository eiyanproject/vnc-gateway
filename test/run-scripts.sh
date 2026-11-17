#!/usr/bin/env bash
# Shell-script tests: create-lxc.sh, update-lxc.sh, setup-oci.sh, install.sh.
# Each runs in its own throwaway Debian container with the Proxmox / OCI tools
# stubbed, so nothing here can touch a real host.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC="$(pwd -W 2>/dev/null || pwd)"   # Git Bash on Windows needs the C:/ form

rc=0
for t in create-lxc update-lxc setup-oci install; do
  echo "################################ $t"
  MSYS_NO_PATHCONV=1 docker run --rm -v "$SRC:/src:ro" debian:12 bash -c "
    apt-get update -qq >/dev/null 2>&1
    apt-get install -y -qq shellcheck git bsdutils iputils-ping >/dev/null 2>&1
    bash /src/test/scripts/$t.test.sh
  " || rc=1
done
exit $rc
