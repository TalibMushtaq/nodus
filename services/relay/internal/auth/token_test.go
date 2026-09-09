package auth_test

import (
	"strings"
	"testing"

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
)

func TestGenerateSessionID(t *testing.T) {
	a, err := auth.GenerateSessionID()
	if err != nil {
		t.Fatalf("failed to generate session id: %v", err)
	}
	b, err := auth.GenerateSessionID()
	if err != nil {
		t.Fatalf("failed to generate second session id: %v", err)
	}

	// 32 random bytes -> base64url, unpadded: 43 characters.
	if len(a) != 43 {
		t.Fatalf("expected 43-char base64url id, got %q (%d chars)", a, len(a))
	}

	// base64url alphabet only (no '+' '/', no padding '=').
	for _, ch := range a {
		if !strings.ContainsRune("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_", ch) {
			t.Fatalf("session id contains out-of-alphabet char %q", ch)
		}
	}

	if a == b {
		t.Fatalf("expected two session ids to differ")
	}
}

func TestHashSession(t *testing.T) {
	const raw = "some-raw-session-token"
	d1 := auth.HashSession(raw)
	d2 := auth.HashSession(raw)

	if len(d1) != 64 { // SHA-256 hex digest
		t.Fatalf("expected 64-hex-char digest, got %q (%d chars)", d1, len(d1))
	}
	if d1 != d2 {
		t.Fatalf("expected deterministic hash, got %q then %q", d1, d2)
	}
	if auth.HashSession("other-token") == d1 {
		t.Fatalf("expected different tokens to hash differently")
	}
}
