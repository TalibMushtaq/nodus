#!/usr/bin/env bash
# Bring up the Relay's disposable integration-test fixtures, run the suite
# against them, then tear them down.
#
# Why this exists: the integration tests need a real Postgres and Redis, and they
# write schema- and data-level state. The dev stack (docker-compose.yml) holds
# the developer's working data on named volumes, so it is never a valid test
# target. This script uses docker-compose.test.yml, which uses tmpfs and
# per-invocation generated credentials.
#
# Usage:
#   scripts/test-integration.sh              # unit + integration tests
#   scripts/test-integration.sh -run TestFoo # pass extra args through to `go test`
#
# Leave fixtures up for iterative work with:
#   scripts/test-integration.sh --keep
#   RELAY_TEST_PG_PASSWORD=... RELAY_TEST_REDIS_PASSWORD=... \
#     go test ./... -run 'Integration|Account'
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

if [[ -z "${RELAY_TEST_PG_PASSWORD:-}" ]]; then
  # Generated per invocation: a throwaway fixture does not need a memorable
  # password, and never shipping a fixed one avoids the "committed default that
  # quietly becomes production" failure mode.
  RELAY_TEST_PG_PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -d '/+=')"
fi
if [[ -z "${RELAY_TEST_REDIS_PASSWORD:-}" ]]; then
  RELAY_TEST_REDIS_PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -d '/+=')"
fi
export RELAY_TEST_PG_PASSWORD RELAY_TEST_REDIS_PASSWORD

COMPOSE=(docker compose -f docker-compose.test.yml)

cleanup() {
  if [[ "$KEEP" -eq 0 ]]; then
    "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  else
    echo "==> --keep: fixtures left running."
    echo "    TEST_DATABASE_URL=postgres://nodus_test:${RELAY_TEST_PG_PASSWORD}@127.0.0.1:5433/nodus_relay_test?sslmode=disable"
    echo "    TEST_REDIS_URL=redis://:${RELAY_TEST_REDIS_PASSWORD}@127.0.0.1:6380/0"
  fi
}
trap cleanup EXIT

echo "==> Starting disposable test fixtures"
"${COMPOSE[@]}" up -d --wait

export TEST_DATABASE_URL="postgres://nodus_test:${RELAY_TEST_PG_PASSWORD}@127.0.0.1:5433/nodus_relay_test?sslmode=disable"
export TEST_REDIS_URL="redis://:${RELAY_TEST_REDIS_PASSWORD}@127.0.0.1:6380/0"

echo "==> Running tests (TEST_DATABASE_URL set, integration tests will execute)"
if [[ ${#GO_TEST_ARGS[@]} -gt 0 ]]; then
  go test "${GO_TEST_ARGS[@]}" ./...
else
  go test ./...
fi
