package testutil

import (
	"context"
	"os"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
)

// OpenTestDB returns a migrated database for integration tests and skips the
// test when TEST_DATABASE_URL is unset.
//
// This is the single seam the storage backend is swapped behind. During the
// PostgreSQL phase it opens the TEST_DATABASE_URL fixture shared by the suite;
// the SQLite phase changes only this function to create a fresh file-backed
// database per test, so the individual tests do not need to know which backend
// they run against.
func OpenTestDB(t testing.TB) (*db.Pool, context.Context) {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping integration test")
	}
	ctx := context.Background()
	require.NoError(t, db.RunMigrations(url))
	pool, err := db.Open(ctx, &config.Config{DatabaseURL: url})
	require.NoError(t, err)
	t.Cleanup(pool.Close)
	return pool, ctx
}
