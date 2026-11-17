#!/usr/bin/env bash
# Unit + integration tests, in a throwaway container: no Node needed on the
# host, and node_modules never lands on a Windows bind mount.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC="$(pwd -W 2>/dev/null || pwd)"   # Git Bash on Windows needs the C:/ form
MSYS_NO_PATHCONV=1 docker run --rm -v "$SRC:/src:ro" node:22-alpine sh -c '
  set -e
  mkdir /w && cd /src && tar --exclude=node_modules --exclude=.git -cf - . | tar -xf - -C /w
  cd /w && npm ci --ignore-scripts --no-audit --no-fund >/dev/null
  npm test
'
