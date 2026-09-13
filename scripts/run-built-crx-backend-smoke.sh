#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT/scripts/built-crx-backend-smoke.compose.yml"
EXTENSION_DIR="$ROOT/packages/yoroi-extension"
BACKEND_ORIGIN="http://wallet-backend:3010"

usage() {
  cat <<'EOF'
Usage: ./scripts/run-built-crx-backend-smoke.sh NETWORK NAMESPACE SERVICE [SERVICE_PORT]

NETWORK is mainnet or preprod. SERVICE_PORT is the Kubernetes Service port name
or port number and defaults to http. The Service must expose that port as a
NodePort reachable through the Docker host gateway.
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi
if [[ $# -lt 3 || $# -gt 4 ]]; then
  usage >&2
  exit 2
fi

EXPECTED_NETWORK="$1"
BACKEND_NAMESPACE="$2"
BACKEND_SERVICE="$3"
BACKEND_SERVICE_PORT="${4:-http}"
if [[ "$EXPECTED_NETWORK" != "mainnet" && "$EXPECTED_NETWORK" != "preprod" ]]; then
  printf 'NETWORK must be mainnet or preprod, got %s\n' "$EXPECTED_NETWORK" >&2
  exit 2
fi

for tool in docker kubectl jq node npm; do
  command -v "$tool" >/dev/null || { printf 'required tool is missing: %s\n' "$tool" >&2; exit 1; }
done
docker compose version >/dev/null

service_json="$(kubectl --namespace "$BACKEND_NAMESPACE" get service "$BACKEND_SERVICE" -o json)"
BACKEND_NODE_PORT="$(jq -r --arg selected "$BACKEND_SERVICE_PORT" '
  [.spec.ports[] | select((.name // "") == $selected or (.port | tostring) == $selected) | .nodePort]
  | map(select(. != null)) | first // empty
' <<<"$service_json")"
if [[ -z "$BACKEND_NODE_PORT" ]]; then
  printf 'service %s/%s port %s is not exposed as a NodePort\n' \
    "$BACKEND_NAMESPACE" "$BACKEND_SERVICE" "$BACKEND_SERVICE_PORT" >&2
  exit 1
fi

export BACKEND_NODE_PORT
export SELENIUM_PORT="${SELENIUM_PORT:-4444}"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-yoroi-built-crx-smoke}"

cleanup() {
  status=$?
  trap - EXIT
  docker compose --file "$COMPOSE_FILE" down --volumes --remove-orphans || true
  exit "$status"
}
trap cleanup EXIT

(
  cd "$EXTENSION_DIR"
  npm run prod:build -- --env test --configEnv backend-smoke --isE2E
  npm run prod:compress -- \
    --env test \
    --app-id yoroi \
    --codebase https://yoroi-downloads.blinklabs.cloud/dw/yoroi-test-extension.crx \
    --key ./e2etest-key.pem
)

docker compose --file "$COMPOSE_FILE" up --detach --wait
node "$ROOT/scripts/built-crx-backend-smoke.mjs" \
  "$EXTENSION_DIR/Yoroi-test.crx" \
  "$EXPECTED_NETWORK" \
  "http://127.0.0.1:$SELENIUM_PORT" \
  "$BACKEND_ORIGIN"
