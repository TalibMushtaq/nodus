package buffer_test

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/TalibMushtaq/nodus/services/relay/internal/buffer"
)

func TestBufferLifecycle(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "nodus-buffer-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	buf, err := buffer.New(tempDir)
	if err != nil {
		t.Fatalf("failed to initialize buffer: %v", err)
	}

	bufferID := "test-buffer-id-12345"
	data := []byte("encrypted shard payload content")

	// 1. Should not exist initially
	if buf.Exists(bufferID) {
		t.Fatalf("expected buffer file not to exist yet")
	}

	// 2. Store
	if err := buf.Store(bufferID, data); err != nil {
		t.Fatalf("failed to store buffer data: %v", err)
	}

	if !buf.Exists(bufferID) {
		t.Fatalf("expected buffer file to exist after Store")
	}

	// 3. Fetch
	retrieved, err := buf.Fetch(bufferID)
	if err != nil {
		t.Fatalf("failed to fetch buffer data: %v", err)
	}

	if !bytes.Equal(retrieved, data) {
		t.Fatalf("fetched data does not match stored data")
	}

	// 4. Delete
	if err := buf.Delete(bufferID); err != nil {
		t.Fatalf("failed to delete buffer data: %v", err)
	}

	if buf.Exists(bufferID) {
		t.Fatalf("expected buffer file to not exist after Delete")
	}

	// 5. Delete idempotent on non-existent file
	if err := buf.Delete("non-existent-id"); err != nil {
		t.Fatalf("expected delete to succeed on non-existent file: %v", err)
	}
}

// The buffer root is under os.TempDir() by default and can be cleaned up while
// the Relay runs; Store must re-create it rather than fail every upload.
func TestStoreRecreatesMissingDir(t *testing.T) {
	root, err := os.MkdirTemp("", "nodus-buffer-recreate-*")
	if err != nil {
		t.Fatalf("failed to create temp root: %v", err)
	}
	defer os.RemoveAll(root)

	dir := root + "/buffer"
	buf, err := buffer.New(dir)
	if err != nil {
		t.Fatalf("failed to initialize buffer: %v", err)
	}
	if err := os.RemoveAll(dir); err != nil {
		t.Fatalf("failed to remove buffer dir: %v", err)
	}

	data := []byte("shard bytes after dir removal")
	if err := buf.Store("id-after-rm", data); err != nil {
		t.Fatalf("Store should recreate the directory: %v", err)
	}
	got, err := buf.Fetch("id-after-rm")
	if err != nil {
		t.Fatalf("Fetch after recreated dir: %v", err)
	}
	if !bytes.Equal(got, data) {
		t.Fatalf("round-trip mismatch after dir recreation")
	}
}

// TestBufferedShardsAreNotWorldReadable pins the file modes. The buffer holds
// end-to-end encrypted shard bytes, so this is not ciphertext-versus-plaintext —
// it is that a shard is still one account's data, and 0644 in an 0755 directory
// hands it to every local user and every other process on the volume.
func TestBufferedShardsAreNotWorldReadable(t *testing.T) {
	dir := t.TempDir()
	buf, err := buffer.New(dir)
	if err != nil {
		t.Fatalf("initializing buffer: %v", err)
	}
	if err := buf.Store("shard-modes", []byte("ciphertext")); err != nil {
		t.Fatalf("Store: %v", err)
	}

	dirInfo, err := os.Stat(dir)
	if err != nil {
		t.Fatalf("stat buffer dir: %v", err)
	}
	if mode := dirInfo.Mode().Perm(); mode&0o077 != 0 {
		t.Errorf("buffer directory mode = %04o, want no group/other access", mode)
	}

	shardInfo, err := os.Stat(filepath.Join(dir, "shard-modes"))
	if err != nil {
		t.Fatalf("stat buffered shard: %v", err)
	}
	if mode := shardInfo.Mode().Perm(); mode&0o077 != 0 {
		t.Errorf("buffered shard mode = %04o, want no group/other access", mode)
	}
}

// TestNewTightensAnExistingLooseBufferDir covers the upgrade path: MkdirAll only
// applies the mode to directories it creates, so a deployment that predates the
// restriction would otherwise keep a world-readable buffer directory forever.
func TestNewTightensAnExistingLooseBufferDir(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "buffer")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("creating pre-existing loose dir: %v", err)
	}
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatalf("chmod pre-existing dir: %v", err)
	}

	if _, err := buffer.New(dir); err != nil {
		t.Fatalf("New on a pre-existing dir: %v", err)
	}
	info, err := os.Stat(dir)
	if err != nil {
		t.Fatalf("stat buffer dir: %v", err)
	}
	if mode := info.Mode().Perm(); mode&0o077 != 0 {
		t.Errorf("pre-existing buffer dir mode = %04o, want it tightened by New", mode)
	}
}
