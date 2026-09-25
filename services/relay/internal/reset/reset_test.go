package reset

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// TestValidateBufferDir is the regression test for the path footgun: BUFFER_DIR
// comes from the environment and feeds os.RemoveAll, so a value like "/" or
// "$HOME" would delete that tree with no further confirmation. Every refused case
// here is a path that has no legitimate use as a shard buffer.
func TestValidateBufferDir(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skipf("no home directory: %v", err)
	}
	cwd, err := os.Getwd()
	require.NoError(t, err)

	refused := []struct {
		name string
		path string
	}{
		{"empty", ""},
		{"filesystem root", "/"},
		{"root with trailing slash", "//"},
		{"tmp itself", "/tmp"},
		{"var itself", "/var"},
		{"etc", "/etc"},
		{"usr", "/usr"},
		{"home itself", "/home"},
		{"home directory", home},
		{"parent of home", filepath.Dir(home)},
		{"working directory", cwd},
		{"parent of working directory", filepath.Dir(cwd)},
		{"root of working directory", "/"},
		{"relative", "nodus/buffer"},
		{"dot relative", "./buffer"},
		{"too shallow", "/data"},
	}
	for _, tc := range refused {
		t.Run(tc.name, func(t *testing.T) {
			err := validateBufferDir(tc.path)
			require.Error(t, err, "%q must be refused before os.RemoveAll is pointed at it", tc.path)
			require.Contains(t, err.Error(), "refusing to reset")
		})
	}

	// The documented default and the shapes a real deployment uses must pass, or
	// the guardrail has made the reset unusable.
	allowed := []string{
		filepath.Join(os.TempDir(), "nodus-relay", "buffer"),
		"/var/lib/nodus/buffer",
		"/data/nodus/buffer",
		"/srv/nodus-relay/shard-buffer",
	}
	for _, path := range allowed {
		t.Run("allowed "+path, func(t *testing.T) {
			require.NoError(t, validateBufferDir(path), "%q is a legitimate buffer path", path)
		})
	}
}

// TestValidateBufferDirRejectsSymlinkedParent covers the indirection that a plain
// string check misses. os.RemoveAll does not follow a symlinked leaf, but it does
// walk through a symlinked parent, so BUFFER_DIR=/data/nodus/buffer with
// nodus -> /etc would delete /etc/buffer while every string check looks clean.
func TestValidateBufferDirRejectsSymlinkedParent(t *testing.T) {
	base := t.TempDir()
	link := filepath.Join(base, "nodus")
	require.NoError(t, os.Symlink("/etc", link))

	throughLink := filepath.Join(link, "buffer")
	err := validateBufferDir(throughLink)
	require.Error(t, err, "a symlinked parent pointing into a system directory must be refused")
	require.Contains(t, err.Error(), "symlink")

	// The same shape pointing at an ordinary directory stays allowed, so the
	// guardrail does not break deployments that symlink their data volume.
	safeTarget := filepath.Join(base, "real")
	require.NoError(t, os.MkdirAll(safeTarget, 0o755))
	safeLink := filepath.Join(base, "safe")
	require.NoError(t, os.Symlink(safeTarget, safeLink))
	require.NoError(t, validateBufferDir(filepath.Join(safeLink, "buffer")))
}

// TestValidateBufferDirAcceptsExistingLegitimateDir makes sure the guardrail does
// not reject the path merely because it already exists, which is the normal case
// on a second reset.
func TestValidateBufferDirAcceptsExistingLegitimateDir(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nodus-relay", "buffer")
	require.NoError(t, os.MkdirAll(dir, 0o755))
	require.NoError(t, validateBufferDir(dir))
}

// TestIsWithin covers the ancestor check used to keep the reset from removing
// the running process's own working directory.
func TestIsWithin(t *testing.T) {
	require.True(t, isWithin("/a", "/a"), "a directory is within itself")
	require.True(t, isWithin("/a/b", "/a"))
	require.True(t, isWithin("/a/b/c", "/a"))
	require.False(t, isWithin("/a", "/a/b"))
	require.False(t, isWithin("/ab", "/a"), "a name prefix is not containment")
	require.False(t, isWithin("/a", "/b"))
}

// TestResolveExistingPrefix checks the symlink walk: it resolves the longest
// existing part of the path and re-appends what does not exist yet.
func TestResolveExistingPrefix(t *testing.T) {
	base := t.TempDir()
	real := filepath.Join(base, "real")
	require.NoError(t, os.MkdirAll(filepath.Join(real, "buffer"), 0o755))
	link := filepath.Join(base, "link")
	require.NoError(t, os.Symlink(real, link))

	resolved, err := resolveExistingPrefix(filepath.Join(link, "buffer"))
	require.NoError(t, err)
	require.Equal(t, filepath.Join(real, "buffer"), resolved,
		"the symlinked parent must be resolved while the real leaf is preserved")
}

// TestDescribeTargetRedactsCredentials is the guardrail on the guardrails: the
// confirmation prompt shows the operator exactly which server they are about to
// destroy, and that output must be safe to paste into a bug report.
func TestDescribeTargetRedactsCredentials(t *testing.T) {
	cfg := testConfig()

	out := DescribeTarget(cfg)
	require.Contains(t, out, "127.0.0.1:5432/nodus_relay", "the database name must be shown")
	require.Contains(t, out, "127.0.0.1:6379 db 3", "the Redis index must be shown")
	require.Contains(t, out, cfg.BufferDir, "the buffer path must be shown")

	require.NotContains(t, out, "supersecret", "the database password must never be printed")
	require.NotContains(t, out, "redispass", "the Redis password must never be printed")
	require.NotContains(t, out, "relayadmin", "the database user must not be printed")
	require.NotContains(t, out, cfg.DatabaseURL, "the raw URL must not be echoed")
	require.NotContains(t, out, cfg.RedisURL, "the raw URL must not be echoed")
}

// TestSafePostgresTarget covers the default-database case, where omitting the
// database name in the URL means the server's own default rather than "".
func TestSafePostgresTarget(t *testing.T) {
	require.Equal(t, "db.example:5432/nodus", safePostgresTarget("postgres://u:p@db.example:5432/nodus?sslmode=require"))
	require.Equal(t, "db.example:5432/(default)", safePostgresTarget("postgres://u:p@db.example:5432"))
	require.Contains(t, safePostgresTarget("::not a url::"), "unparseable")
}

// TestSafeRedisTargetDefaultsToIndexZero documents that a URL with no explicit
// index flushes db 0, which is the number the operator most needs to see because
// db 0 is the one shared with everything else on a shared Redis.
func TestSafeRedisTargetDefaultsToIndexZero(t *testing.T) {
	require.Equal(t, "127.0.0.1:6379 db 0", safeRedisTarget("redis://127.0.0.1:6379"))
	require.Equal(t, "127.0.0.1:6379 db 0", safeRedisTarget("redis://127.0.0.1:6379/0"))
	require.Equal(t, "127.0.0.1:6379 db 5", safeRedisTarget("redis://:pass@127.0.0.1:6379/5"))
	require.Contains(t, safeRedisTarget("not a url"), "unparseable")
}

// TestConfirmPhraseUnchanged guards the one thing that already worked: a reflex
// "yes", an empty line, or a near-miss must not authorize the reset. Surrounding
// whitespace *is* accepted on purpose, so `echo "purge everything" | relay` works.
func TestConfirmPhraseUnchanged(t *testing.T) {
	for _, refused := range []string{"", "y", "yes", "purge", "delete", "Purge Everything", "purge everything!"} {
		require.NotEqual(t, ConfirmPhrase, strings.TrimSpace(refused),
			"%q must not authorize a factory reset", refused)
	}
	require.Equal(t, "purge everything", ConfirmPhrase)
	require.Equal(t, ConfirmPhrase, strings.TrimSpace(ConfirmPhrase+"\n"),
		"a trailing newline from a piped phrase must still confirm")
}
