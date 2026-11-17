#!/usr/bin/env bash
# End-to-end test: real browser -> app -> guacd -> real VNC server, using the
# production docker-compose.yml with test/e2e/compose.e2e.yml layered on top.
# Everything it creates is torn down afterwards. Screenshots and the app log
# land in test/e2e/out/.
set -euo pipefail
cd "$(dirname "$0")/../.."

DC=(docker compose -p vncgw-e2e --env-file test/e2e/e2e.env -f docker-compose.yml -f test/e2e/compose.e2e.yml)
cleanup() { "${DC[@]}" --profile run down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT

mkdir -p test/e2e/out
cleanup
echo "==> building and starting guacd, app, vnc"
VNCGW_COMMIT=e2e "${DC[@]}" up -d --build guacd app vnc

echo "==> waiting for the app to report healthy"
status=""
for _ in $(seq 1 60); do
  status=$(docker inspect -f '{{.State.Health.Status}}' vncgw-e2e-app 2>/dev/null || true)
  [ "$status" = "healthy" ] && break
  sleep 2
done
echo "    app health: ${status:-unknown}"

rc=0
echo "==> running the browser"
"${DC[@]}" --profile run run --rm browser || rc=$?

"${DC[@]}" logs --no-color app > test/e2e/out/app.log 2>&1 || true
if grep -q 'e2e-pass' test/e2e/out/app.log; then
  echo "FAIL  VNC password found in the app log"; rc=1
else
  echo "PASS  VNC password absent from the app log"
fi
if [ "$status" = "healthy" ]; then
  echo "PASS  container healthcheck (non-root, read-only root filesystem)"
else
  echo "FAIL  app never became healthy"; rc=1
fi
exit $rc
