package buffer

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
)

// TestSweepStuckInTransitRevertsToRelayBuffered verifies the recovery sweep
// (C1/C2): a shard left in NODE_RECEIVING / NODE_VERIFIED past the grace window
// (node crashed mid-fetch) must be reverted to RELAY_BUFFERED so reconnect-time
// delivery re-notifies the node. Without this the shard would be stranded in a
// state neither delivery nor the TTL sweep ever touches.
func TestSweepStuckInTransitRevertsToRelayBuffered(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping integration test")
	}
	ctx := context.Background()
	if err := db.RunMigrations(url); err != nil {
		t.Fatalf("run migrations: %v", err)
	}
	pool, err := db.Open(ctx, &config.Config{DatabaseURL: url})
	if err != nil {
		t.Fatalf("open pool: %v", err)
	}
	defer pool.Close()

	seed := []struct {
		q    string
		args []any
	}{
		{q: `INSERT INTO accounts (account_id, email, password_hash) VALUES ('acct-sweep', 'sweep@test.local', 'x') ON CONFLICT DO NOTHING`, args: []any{}},
		{q: `INSERT INTO storage_nodes (node_id, account_id, public_key) VALUES ('node-sweep', 'acct-sweep', 'deadbeef') ON CONFLICT DO NOTHING`, args: []any{}},
		{q: `INSERT INTO files (file_id, account_id) VALUES ('file-sweep', 'acct-sweep') ON CONFLICT DO NOTHING`, args: []any{}},
		{q: `INSERT INTO file_versions (file_id, version_number, conflict_status, version_hash, shard_count, created_at)
		     VALUES ('file-sweep', 1, 'none', 'vhash', 1, NOW()) ON CONFLICT DO NOTHING`, args: []any{}},
	}
	for _, s := range seed {
		if _, err := pool.Exec(ctx, s.q); err != nil {
			t.Fatalf("seed query failed: %v", err)
		}
	}

	// Clear any fixture rows a previous run left behind (the fixture keys are
	// fixed, so the test must be idempotent against the shared test database).
	if _, err := pool.Exec(ctx, `DELETE FROM file_locations WHERE node_id = 'node-sweep'`); err != nil {
		t.Fatalf("cleanup fixture locations: %v", err)
	}

	// Two stranded shards: one NODE_RECEIVING, one NODE_VERIFIED, both old
	// enough to trip the grace window. NODE_STORED is terminal and must NOT be
	// reverted — it also guards the intended control group.
	for shardIndex, status := range []string{"NODE_RECEIVING", "NODE_VERIFIED", "NODE_STORED"} {
		if _, err := pool.Exec(ctx, `
			INSERT INTO file_locations (file_id, version_number, shard_index, node_id, status, buffer_id, hash, size_bytes, updated_at)
			VALUES ('file-sweep', 1, $1, 'node-sweep', $2, $3, 'hash', 10, NOW() - INTERVAL '2 hours')
		`, shardIndex, status, fmt.Sprintf("buf-%d", shardIndex)); err != nil {
			t.Fatalf("seed location for %s: %v", status, err)
		}
	}

	if err := sweepStuckInTransit(ctx, pool, nil, time.Minute); err != nil {
		t.Fatalf("sweepStuckInTransit: %v", err)
	}

	for shardIndex := range []string{"NODE_RECEIVING", "NODE_VERIFIED"} {
		var got string
		if err := pool.QueryRow(ctx,
			`SELECT status FROM file_locations WHERE file_id='file-sweep' AND version_number=1 AND shard_index=$1 AND node_id='node-sweep'`,
			shardIndex).Scan(&got); err != nil {
			t.Fatalf("read reverted status: %v", err)
		}
		if got != "RELAY_BUFFERED" {
			t.Errorf("shard %d: expected RELAY_BUFFERED after sweep, got %s", shardIndex, got)
		}
	}

	// Terminal NODE_STORED must be untouched.
	var stored string
	if err := pool.QueryRow(ctx,
		`SELECT status FROM file_locations WHERE file_id='file-sweep' AND version_number=1 AND shard_index=2 AND node_id='node-sweep'`).Scan(&stored); err != nil {
		t.Fatalf("read NODE_STORED: %v", err)
	}
	if stored != "NODE_STORED" {
		t.Errorf("expected NODE_STORED to survive the sweep, got %s", stored)
	}
}
