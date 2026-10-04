#!/usr/bin/env bash
# Bring up the Relay's disposable integration-test fixture (Redis), run the
# suite against it, then tear it down.
#
# Why this exists: the relay's database is a per-test SQLite file created under
# t.TempDir(), so it needs no fixture. A few tests (buffer fetch tokens, the
# rate limiter) do need a real Redis, and they write key-level state. The dev
# stack (docker-compose.yml) holds the developer's working Redis data, so it is
# never a valid test target. This script uses docker-compose.test.yml, which
# uses tmpfs and a per-invocation generated password.
#
# Usage:
#   scripts/test-integration.sh              # unit + integration tests
#   scripts/test-integration.sh -run TestFoo # pass extra args through to `go test`
#
# Leave the fixture up for iterative work with:
#   scripts/test-integration.sh --keep
#   RELAY_TEST_REDIS_PASSWORD=... TEST_REDIS_URL=... go test ./...
set -euo pipefail

cd "$(dirname "$0")/.."

KEEP=0
GO_TEST_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    *) GO_TEST_ARGS+=("$arg") ;;
  esac
done

if [[ -z "${RELAY_TEST_REDIS_PASSWORD:-}" ]]; then
  # Generated per invocation: a throwaway fixture does not need a memorable
  # password, and never shipping a fixed one avoids the "committed default that
  # quietly becomes production" failure mode.
  RELAY_TEST_REDIS_PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -d '/+=')"
fi
export RELAY_TEST_REDIS_PASSWORD

COMPOSE=(docker compose -f docker-compose.test.yml)

cleanup() {
  if [[ "$KEEP" -eq 0 ]]; then
    "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  else
    echo "==> --keep: fixture left running."
    echo "    TEST_REDIS_URL=redis://:${RELAY_TEST_REDIS_PASSWORD}@127.0.0.1:6380/0"
  fi
}
trap cleanup EXIT

echo "==> Starting disposable test fixture (redis)"
"${COMPOSE[@]}" up -d --wait

export TEST_REDIS_URL="redis://:${RELAY_TEST_REDIS_PASSWORD}@127.0.0.1:6380/0"

echo "==> Running tests (TEST_REDIS_URL set; SQLite test DBs are per-test)"
if [[ ${#GO_TEST_ARGS[@]} -gt 0 ]]; then
  go test "${GO_TEST_ARGS[@]}" ./...
else
  go test ./...
fi
