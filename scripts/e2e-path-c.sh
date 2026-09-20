#!/usr/bin/env bash
# Wire-level Path C E2E: a real TS uploader (the same two-pass shard/emit/upload
# code the browser runs) pushes an encrypted file through the Next proxy into the
# Relay buffer, a real Rust node fetches/verifies/stores it, and a second paired
# device downloads, decrypts, and reassembles it. A kill/resume cycle proves
# partial-upload progress survives a process restart.
#
# Prerequisites:
#   - the Storage Node is built: cargo build --manifest-path services/storage-node/Cargo.toml
#   - the deploy unit is up: docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d
#   - harness deps installed: pnpm install
#     (the harness imports built workspace packages; this script builds them if
#      their dist output is missing)
#
# Usage: bash scripts/e2e-path-c.sh
# Prints a PASS/FAIL line per check and exits non-zero if any fail. Runs under
# `set -e` so a failed setup/API call stops the run instead of surfacing later
# as a confusing missing-envelope or decrypt error.
set -euo pipefail

# The harness imports @repo/relay-client, @repo/protocol and @repo/sdk from
# dist (the uploader drives apps/web/lib/uploader, which imports @repo/sdk), so
# all three must be built before the first `tsx` run.
if [ ! -f packages/relay-client/dist/index.js ] || [ ! -f packages/protocol/dist/index.js ] || [ ! -f packages/sdk/dist/index.js ]; then
  echo "building TypeScript workspace packages for the harness..."
  pnpm exec turbo build --filter=@repo/relay-client... --filter=@repo/sdk... >/dev/null
fi
BASE=${BASE:-http://localhost}
BIN=${BIN:-./services/storage-node/target/debug/storage-node}
COMPOSE=${COMPOSE:-"docker compose -f deploy/docker-compose.yml --env-file deploy/.env"}
NODE_LOCAL=${NODE_LOCAL:-http://127.0.0.1:9378}
PASS=0; FAIL=0
ok()   { echo "PASS: $1"; PASS=$((PASS+1)); }
bad()  { echo "FAIL: $1"; FAIL=$((FAIL+1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1 (got '$2' want '$3')"; fi; }

reg() { curl -fsS -c "$1" -X POST "$BASE/api/auth/register" -H 'content-type: application/json' \
  -d "{\"email\":\"$2\",\"password\":\"password123\",\"device_id\":\"$3\",\"device_public_key\":\"$4\"}" >/dev/null; }
acct() { curl -fsS -b "$1" "$BASE/api/auth/session" | python3 -c 'import sys,json;print(json.load(sys.stdin)["account_id"])'; }
mint() { curl -fsS -b "$1" -X POST "$BASE/api/pairing/codes" -H 'content-type: application/json' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["code"])'; }
# Extract the raw cookie value from a Netscape cookie jar.
cookie_val() { awk '$6 == "nodus_session" { print $7 }' "$1"; }
psqlq() { $COMPOSE exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "$1"' sh "$1"; }
# Derive {device_id, public_key} for a seed via the harness.
identity_field() { pnpm --filter e2e-path-c run print-identity -- --seed "$1" 2>/dev/null | tail -1 \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['$2'])"; }

STAMP=$(date +%s)
JAR=/tmp/pathc.jar; rm -f "$JAR"
SEED_A=$(openssl rand -hex 32)
DEV_A=$(identity_field "$SEED_A" device_id)
PUB_A=$(identity_field "$SEED_A" public_key)
reg "$JAR" "pathc-$STAMP@example.com" "$DEV_A" "$PUB_A"
ACCT=$(acct "$JAR")
COOKIE="nodus_session=$(cookie_val "$JAR")"
echo "account=$ACCT deviceA=$DEV_A"

# Device B is a second device on the same account; the uploader seals a FEK
# envelope for it and it downloads the file at the end. It is enrolled through
# the Relay's ownership-safe /devices/register (proxied by the BFF): the device
# row must exist *and be ACTIVE*, or publishEnvelopes() will not list B as a
# recipient and its download fails with MissingEnvelopeError.
SEED_B=$(openssl rand -hex 32)
DEV_B=$(identity_field "$SEED_B" device_id)
PUB_B=$(identity_field "$SEED_B" public_key)
if ! curl --fail-with-body -sS -b "$JAR" -X POST "$BASE/api/devices/register" \
  -H 'content-type: application/json' \
  -d "{\"device_id\":\"$DEV_B\",\"public_key\":\"$PUB_B\"}" >/tmp/pathc-registerB.json; then
  echo "FAIL: device B registration request failed:"
  cat /tmp/pathc-registerB.json
  exit 1
fi
# Verify the row is actually visible and ACTIVE before relying on it.
if ! curl --fail-with-body -sS -b "$JAR" "$BASE/api/devices" \
  | python3 - "$DEV_B" <<'PY'
import json
import sys

device_id = sys.argv[1]
devices = json.load(sys.stdin)
matches = [
    d for d in devices
    if d.get("device_id") == device_id and d.get("status") == "ACTIVE"
]
if len(matches) != 1:
    raise SystemExit(f"device {device_id} was not registered and active")
PY
then
  echo "FAIL: device B is not ACTIVE after registration"
  exit 1
fi
echo "deviceB=$DEV_B"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "===== Pair a fresh Storage Node ====="
CODE=$(mint "$JAR")
# `timeout` returns 124 on expiry and the node can exit non-zero on a pairing
# error; neither should abort the run before the PASS/FAIL summary, so treat it
# as an unchecked step and let the "node paired" check below report it.
if ! env -u NODUS_RELAY_URL HOME="$TMP" timeout 14 "$BIN" node pair --data-dir "$TMP/data" --relay "$BASE" --code "$CODE" >/tmp/pathc-pair.log 2>&1; then
  echo "note: node pair exited non-zero (see /tmp/pathc-pair.log)"
fi
NODE_ID=$(cat "$TMP/.nodus/identity/node_id" 2>/dev/null || echo none)
check "node paired" "$(curl -fsS -b "$JAR" "$BASE/api/nodes" | grep -c "$NODE_ID")" "1"

# 8 MiB + 4 KiB forces exactly two shards at the 8 MiB shard size.
FILE="$TMP/upload.bin"
head -c $((8 * 1024 * 1024 + 4096)) /dev/urandom > "$FILE"
FILE_ID="e2e-pathc-$STAMP"
STATE="$TMP/state"
UPLOADER=(pnpm --filter e2e-path-c run uploader -- --base "$BASE" --cookie "$COOKIE" \
  --device-id "$DEV_A" --seed "$SEED_A" --target-node "$NODE_ID" --file "$FILE" --file-id "$FILE_ID" --state-dir "$STATE")

echo "===== Pass 1: kill after the first shard ====="
"${UPLOADER[@]}" --stop-after 1 >/tmp/pathc-run1.log 2>&1
check "shard 0 buffered" "$(grep -c 'shard 0 -> RELAY_BUFFERED' /tmp/pathc-run1.log)" "1"
check "shard 1 not buffered before kill" "$(grep -c 'shard 1 -> RELAY_BUFFERED' /tmp/pathc-run1.log)" "0"

echo "===== Pass 2: resume + publish envelopes ====="
"${UPLOADER[@]}" >/tmp/pathc-run2.log 2>&1
check "resume does not re-buffer shard 0" "$(grep -c 'shard 0 -> RELAY_BUFFERED' /tmp/pathc-run2.log)" "0"
check "resume buffers shard 1" "$(grep -c 'shard 1 -> RELAY_BUFFERED' /tmp/pathc-run2.log)" "1"
check "resume does not re-announce events" "$(grep -c 'announcing' /tmp/pathc-run2.log)" "0"
check "key envelopes published" "$([ "$(grep -c 'published' /tmp/pathc-run2.log)" -ge 1 ] && echo yes || echo no)" "yes"

echo "===== Storage Node fetches, verifies, stores ====="
env -u NODUS_RELAY_URL HOME="$TMP" timeout 60 "$BIN" node start >/tmp/pathc-node.log 2>&1 &
NODE_PID=$!
# Wait for the node's local HTTP server before pairing device B to it.
for _ in $(seq 1 20); do curl -fsS "$NODE_LOCAL/nodus/discovery" >/dev/null 2>&1 && break; sleep 1; done
stored="0"
for _ in $(seq 1 30); do
  # `|| true` keeps a transient psql error from aborting under `set -e`; the
  # check below reports the final state either way.
  stored=$(psqlq "SELECT count(*) FROM file_locations WHERE file_id='$FILE_ID' AND status='NODE_STORED'" || true)
  [ "$stored" = "2" ] && break
  sleep 1
done
check "both shards NODE_STORED" "$stored" "2"
check "no RELAY_BUFFERED rows remain" "$(psqlq "SELECT count(*) FROM file_locations WHERE file_id='$FILE_ID' AND status='RELAY_BUFFERED'")" "0"

echo "===== Device B pairs locally, downloads, decrypts ====="
TOKEN=$(curl -fsS -b "$JAR" -X POST "$BASE/api/pairing/sessions" -H 'content-type: application/json' \
  -d "{\"node_id\":\"$NODE_ID\",\"device_id\":\"$DEV_B\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
curl -fsS -X POST "$NODE_LOCAL/nodus/pair" -H 'content-type: application/json' \
  -d "{\"node_id\":\"$NODE_ID\",\"token\":\"$TOKEN\",\"device_id\":\"$DEV_B\",\"device_public_key\":\"$PUB_B\"}" >/tmp/pathc-pairB.log 2>&1
check "device B paired to node" "$(grep -c "$DEV_B" /tmp/pathc-pairB.log)" "1"

OUT="$TMP/downloaded.bin"
pnpm --filter e2e-path-c run downloader -- --base "$BASE" --cookie "$COOKIE" --seed "$SEED_B" \
  --file-id "$FILE_ID" --version 1 --node-host 127.0.0.1 --node-port 9378 --output "$OUT" >/tmp/pathc-download.log 2>&1
check "second device round-trip bytes match" "$(cmp -s "$FILE" "$OUT" && echo yes || echo no)" "yes"
check "filename decrypted" "$(grep -q 'name=upload.bin' /tmp/pathc-download.log && echo yes || echo no)" "yes"

kill "$NODE_PID" >/dev/null 2>&1 || true

echo "===== SUMMARY: $PASS passed, $FAIL failed ====="
[ "$FAIL" -eq 0 ]
