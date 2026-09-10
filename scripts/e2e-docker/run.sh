#!/usr/bin/env bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

IMAGE="${BILI_E2E_IMAGE:-billion-context-e2e:local}"
NETWORK="${E2E_DOCKER_NETWORK:-bridge}"
LOG_DIR="${BILI_E2E_LOG_DIR:-$REPO_ROOT/tmp/docker-e2e}"
MODE="${1:-full}"

case "$MODE" in
  full | preflight) ;;
  *) echo "usage: $0 [full|preflight]" >&2; exit 64 ;;
esac

if ! command -v docker >/dev/null 2>&1; then
  echo "error: docker not found on PATH" >&2
  exit 3
fi

echo ">> building image $IMAGE"
docker build -f scripts/e2e-docker/Dockerfile -t "$IMAGE" .

FORWARD=()
for v in E2E_UPSTREAM_URL E2E_UPSTREAM_KEY E2E_MODEL E2E_FORGE E2E_TMO E2E_CODEX_BIN; do
  if [ -n "${!v:-}" ]; then FORWARD+=(-e "$v=${!v}"); fi
done

mkdir -p "$LOG_DIR"

# Default upstream is host loopback; in a bridge container that's the container
# itself. Use E2E_DOCKER_NETWORK=host, or set E2E_UPSTREAM_URL reachable from the container.
if [ "$MODE" = "preflight" ]; then
  CMD="E2E_CHECK=1 node --import tsx --test tests/e2e/e2e-codex.test.ts"
else
  CMD="ACP_TEST_E2E=1 node --import tsx --test tests/e2e/e2e-codex.test.ts"
fi

echo ">> running e2e [$MODE] in container (network=$NETWORK, logs=$LOG_DIR)"
exec docker run --rm \
  --network "$NETWORK" \
  -v "$LOG_DIR:/app/tmp" \
  "${FORWARD[@]}" \
  "$IMAGE" bash -lc "$CMD"
