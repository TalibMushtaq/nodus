package testutil

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
)

// OpenTestDB returns a freshly migrated, file-backed SQLite database for one
// test and removes it on cleanup.
//
// A file, not :memory:, because each database/sql connection to :memory: gets
// its own separate database, so the writer/reader pool split would silently
// diverge. t.TempDir() gives every test isolation without a shared fixture.
func OpenTestDB(t testing.TB) (*db.Pool, context.Context) {
	t.Helper()
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "relay.db")
	pool, err := db.Open(ctx, &config.Config{DBPath: path})
	require.NoError(t, err)
	t.Cleanup(pool.Close)
	return pool, ctx
}
