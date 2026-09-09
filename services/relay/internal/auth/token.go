package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
)

// Session ID and digest helpers. Raw session tokens are opaque, randomly
// generated values handed to the client exactly once (as a cookie) and are
// never stored server-side — PostgreSQL only ever sees their SHA-256 hash
// (Todo.md Phase 7a §1, plan §13/§29). 256 bits of entropy defeats forgery
// and the hash keeps a DB leak from exposing usable credentials.

// GenerateSessionID returns a URL-safe base64-encoded 32-byte random session
// token. The collision space is ~2^256, so raw strings double as IDs.
func GenerateSessionID() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// HashSession computes the SHA-256 hex digest used as sessions.session_hash.
func HashSession(raw string) string {
	h := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(h[:])
}
