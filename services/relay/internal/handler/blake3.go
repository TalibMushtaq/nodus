package handler

import "github.com/zeebo/blake3"

// blake3Hasher returns a fresh BLAKE3 hasher (zeebo/blake3). The Rust node and
// the Relay must agree on the same hash for snapshot verification; both use
// BLAKE3 over the same serialized chunk bytes.
func blake3Hasher() *blake3.Hasher {
	return blake3.New()
}