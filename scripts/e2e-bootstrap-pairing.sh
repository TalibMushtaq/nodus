#!/usr/bin/env bash
# S10 live E2E matrix for the bootstrap-pairing lifecycle, run against the
# single-origin deploy unit over the Caddy proxy.
#
# Prerequisites:
#   - the Storage Node is built: cargo build --manifest-path services/storage-node/Cargo.toml
#   - the deploy unit is up: docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d
#
# Usage: bash scripts/e2e-bootstrap-pairing.sh
# Prints a PASS/FAIL line per check and exits non-zero if any fail.
#
# Covers: happy path (mint -> node pair -> listed -> WS auth -> reconnect),
# consumed/expired/owned-elsewhere negatives, concurrent single-winner,
# Relay-restart resilience, same-key re-pairing, and changed-key rejection
# (node_key_mismatch).
#
# Minting uses the same `/api/pairing/codes` proxy the browser dialog calls, but
# this script does not drive the browser itself; the dialog UI (render, countdown,
# polling) is covered by the web unit tests.
set -u
BASE=${BASE:-http://localhost}
BIN=${BIN:-./services/storage-node/target/debug/storage-node}
COMPOSE=${COMPOSE:-"docker compose -f deploy/docker-compose.yml --env-file deploy/.env"}
PASS=0; FAIL=0
ok()   { echo "PASS: $1"; PASS=$((PASS+1)); }
bad()  { echo "FAIL: $1"; FAIL=$((FAIL+1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1 (got '$2' want '$3')"; fi; }

reg() { curl -fsS -c "$1" -X POST "$BASE/api/auth/register" -H 'content-type: application/json' \
  -d "{\"email\":\"$2\",\"password\":\"password123\",\"device_id\":\"$3\",\"device_public_key\":\"$(printf 'cd%.0s' {1..32})\"}" >/dev/null; }
acct() { curl -fsS -b "$1" "$BASE/api/auth/session" | python3 -c 'import sys,json;print(json.load(sys.stdin)["account_id"])'; }
mint() { curl -fsS -b "$1" -X POST "$BASE/api/pairing/codes" -H 'content-type: application/json' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["code"])'; }
redeem() { # code nodeid -> HTTP status on stdout
  redeem_key "$1" "$2" "$(printf 'ab%.0s' {1..32})"
}
redeem_key() { # code nodeid publickey_hex -> HTTP status on stdout
  curl -s -o /tmp/s10-rb -w '%{http_code}' -X POST "$BASE/pairing/codes/redeem" -H 'content-type: application/json' \
    -d "{\"code\":\"$1\",\"node_id\":\"$2\",\"public_key\":\"$3\"}"
}
has_node() { curl -fsS -b "$1" "$BASE/api/nodes" | python3 -c 'import sys,json
nid=sys.argv[1]; ns=json.load(sys.stdin)
print("yes" if any(n["node_id"]==nid for n in ns) else "no")' "$2"; }
hash_code() { python3 -c 'import hashlib,sys;print(hashlib.sha256(sys.argv[1].replace("-","").upper().encode()).hexdigest())' "$1"; }
# Run SQL through the container so POSTGRES_USER/POSTGRES_DB come from the
# compose env rather than hardcoded values that a custom deploy/.env would break.
psqlq() { $COMPOSE exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "$1"' sh "$1"; }
auth_count() { $COMPOSE logs relay 2>&1 | grep -c "node $1 successfully authenticated" || true; }

STAMP=$(date +%s)
JA=/tmp/s10-A.jar; JB=/tmp/s10-B.jar; rm -f "$JA" "$JB"
reg "$JA" "s10-a-$STAMP@example.com" "s10-dev-a-$STAMP"
reg "$JB" "s10-b-$STAMP@example.com" "s10-dev-b-$STAMP"
ACCT_A=$(acct "$JA"); ACCT_B=$(acct "$JB")
echo "account A=$ACCT_A"; echo "account B=$ACCT_B"

echo "===== Scenario 1: happy path ====="
CODE_A=$(mint "$JA")
TMP=$(mktemp -d)
env -u NODUS_RELAY_URL HOME="$TMP" timeout 14 "$BIN" node pair --data-dir "$TMP/data" --relay http://localhost --code "$CODE_A" >/tmp/s10-pair.log 2>&1
NODE_ID=$(cat "$TMP/.nodus/identity/node_id" 2>/dev/null || echo none)
check "pair reports account A" "$(grep -c "account id: $ACCT_A" /tmp/s10-pair.log)" "1"
check "pair reports primary" "$(grep -c 'role:       primary node' /tmp/s10-pair.log)" "1"
check "node listed under A" "$(has_node "$JA" "$NODE_ID")" "yes"
check "node NOT listed under B" "$(has_node "$JB" "$NODE_ID")" "no"
check "relay WS-authenticated node" "$([ "$(auth_count "$NODE_ID")" -ge 1 ] && echo yes || echo no)" "yes"
check "relay_url persisted" "$(grep -c 'relay_url = "http://localhost"' "$TMP/.nodus/config.toml")" "1"
env -u NODUS_RELAY_URL HOME="$TMP" timeout 8 "$BIN" node start >/tmp/s10-start.log 2>&1
check "node start reconnects (WS auth)" "$([ "$(auth_count "$NODE_ID")" -ge 2 ] && echo yes || echo no)" "yes"

echo "===== Scenario 2: consumed code ====="
st=$(redeem "$CODE_A" "node-dup-$STAMP"); check "re-redeem returns 409" "$st" "409"
check "consumed reason" "$(python3 -c 'import json;print(json.load(open("/tmp/s10-rb")).get("error"))')" "code_consumed"

echo "===== Scenario 3: expired code ====="
CODE_EXP=$(mint "$JA")
psqlq "UPDATE pairing_codes SET expires_at = NOW() - interval '1 minute' WHERE code_hash = '$(hash_code "$CODE_EXP")'" >/dev/null
st=$(redeem "$CODE_EXP" "node-exp-$STAMP"); check "expired redeem returns 410" "$st" "410"
check "expired reason" "$(python3 -c 'import json;print(json.load(open("/tmp/s10-rb")).get("error"))')" "code_expired"

echo "===== Scenario 4: node_owned_elsewhere (no account move) ====="
CODE_B=$(mint "$JB")
env -u NODUS_RELAY_URL HOME="$TMP" timeout 10 "$BIN" node pair --data-dir "$TMP/data" --relay http://localhost --code "$CODE_B" >/tmp/s10-owned.log 2>&1
check "owned-elsewhere surfaced" "$(grep -c 'already registered to another account' /tmp/s10-owned.log)" "1"
check "still owned by A" "$(has_node "$JA" "$NODE_ID")" "yes"
check "never owned by B" "$(has_node "$JB" "$NODE_ID")" "no"

echo "===== Scenario 5: concurrent redeem single winner ====="
CODE_C=$(mint "$JA")
rm -f /tmp/s10-conc-*
# All racers share one client IP (Caddy overwrites XFF), so some may be rejected
# by the per-IP limiter (429) rather than code_consumed (409). The invariant is
# a single winner and no double-claim, so both are valid rejections.
for i in $(seq 1 8); do
  ( curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE/pairing/codes/redeem" \
      -H 'content-type: application/json' \
      -d "{\"code\":\"$CODE_C\",\"node_id\":\"node-conc-$STAMP-$i\",\"public_key\":\"$(printf 'ab%.0s' {1..32})\"}" >"/tmp/s10-conc-$i" ) &
done; wait
wins=$(grep -oh 200 /tmp/s10-conc-* | wc -l)
rejected=$(grep -ohE '409|429' /tmp/s10-conc-* | wc -l)
any5xx=$(grep -ohE '5[0-9][0-9]' /tmp/s10-conc-* | wc -l)
check "exactly one winner" "$wins" "1"
check "seven rejected (409/429)" "$rejected" "7"
check "no server errors" "$any5xx" "0"
check "exactly one node row registered" "$(psqlq "SELECT count(*) FROM storage_nodes WHERE node_id LIKE 'node-conc-$STAMP-%'")" "1"
check "code consumed once" "$(psqlq "SELECT status FROM pairing_codes WHERE code_hash='$(hash_code "$CODE_C")'")" "CONSUMED"

echo "===== Scenario 6: restart resilience ====="
CODE_D=$(mint "$JA")
$COMPOSE stop relay >/dev/null 2>&1
st_down=$(redeem "$CODE_D" "node-rr-$STAMP")
check "redeem while relay down fails" "$([ "$st_down" != "200" ] && echo yes || echo no)" "yes"
$COMPOSE start relay >/dev/null 2>&1
for _ in $(seq 1 30); do curl -s "$BASE/health" | grep -q '"postgres":"healthy"' && break; sleep 2; done
check "relay healthy after restart" "$(curl -s "$BASE/health" | grep -c '"postgres":"healthy"')" "1"
st_retry=$(redeem "$CODE_D" "node-rr2-$STAMP"); check "retry after restart succeeds" "$st_retry" "200"
st_again=$(redeem "$CODE_D" "node-rr2-$STAMP"); check "consumed still fails after restart" "$st_again" "409"
env -u NODUS_RELAY_URL HOME="$TMP" timeout 8 "$BIN" node start >/tmp/s10-reconnect.log 2>&1
check "paired node reconnects via WS only" "$([ "$(auth_count "$NODE_ID")" -ge 3 ] && echo yes || echo no)" "yes"

echo "===== Scenario 7: re-pairing behavior ====="
CODE_E=$(mint "$JA")
env -u NODUS_RELAY_URL HOME="$TMP" timeout 12 "$BIN" node pair --data-dir "$TMP/data" --relay http://127.0.0.1 --code "$CODE_E" >/tmp/s10-repair.log 2>&1
check "same-account re-pair is idempotent" "$(grep -c "account id: $ACCT_A" /tmp/s10-repair.log)" "1"
check "relay_url updated to new origin" "$(grep -c 'relay_url = "http://127.0.0.1"' "$TMP/.nodus/config.toml")" "1"
check "same-key re-pair preserves primary" "$(psqlq "SELECT is_primary FROM storage_nodes WHERE node_id='$NODE_ID'")" "t"

echo "===== Scenario 8: changed-key re-pair rejected (node_key_mismatch) ====="
# Register a synthetic node with a known key, then attempt to re-register the
# same node_id with a different key. Key rotation is a v1 non-goal.
KEY_NODE="node-key-$STAMP"
CODE_K1=$(mint "$JA")
st=$(redeem_key "$CODE_K1" "$KEY_NODE" "$(printf 'ab%.0s' {1..32})")
check "initial key registration succeeds" "$st" "200"
CODE_K2=$(mint "$JA")
st=$(redeem_key "$CODE_K2" "$KEY_NODE" "$(printf 'cd%.0s' {1..32})")
check "changed-key redeem returns 409" "$st" "409"
check "node_key_mismatch reason" "$(python3 -c 'import json;print(json.load(open("/tmp/s10-rb")).get("error"))')" "node_key_mismatch"
check "registered key unchanged" "$(psqlq "SELECT public_key FROM storage_nodes WHERE node_id='$KEY_NODE'")" "$(printf 'ab%.0s' {1..32})"
check "rejected key code not burned" "$(psqlq "SELECT status FROM pairing_codes WHERE code_hash='$(hash_code "$CODE_K2")'")" "PENDING"

echo "===== Scenario 9: concurrent first-node single primary ====="
# Two simultaneous first-node redeems for a brand-new account must leave
# exactly one primary (DB-enforced by idx_storage_nodes_one_primary).
# Wait for the per-IP limiter to refill so both racers are admitted.
sleep 6
JC=/tmp/s10-C.jar; reg "$JC" "s10-c-$STAMP@example.com" "s10-dev-c-$STAMP"
CODE_P1=$(mint "$JC"); CODE_P2=$(mint "$JC")
for spec in "$CODE_P1 node-p1-$STAMP" "$CODE_P2 node-p2-$STAMP"; do
  set -- $spec
  ( curl -s -o /dev/null -X POST "$BASE/pairing/codes/redeem" -H 'content-type: application/json' \
      -d "{\"code\":\"$1\",\"node_id\":\"$2\",\"public_key\":\"$(printf 'ab%.0s' {1..32})\"}" ) &
done; wait
ACCT_C=$(acct "$JC")
check "exactly one primary for account C" "$(psqlq "SELECT count(*) FROM storage_nodes WHERE account_id='$ACCT_C' AND is_primary")" "1"

echo "===== SUMMARY: $PASS passed, $FAIL failed ====="
rm -rf "$TMP"
[ "$FAIL" -eq 0 ]
