package buffer_test

import (
	"bytes"
	"os"
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
