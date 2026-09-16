package handler

import (
	"encoding/base64"
	"testing"
)

// normalizeEncryptionPublicKey is the single gate for the ADR-0008 X25519 key on
// every device write path. Enforcing its contract here keeps a malformed key
// from ever reaching the devices table, where it would break sealing for the
// whole account.
func TestNormalizeEncryptionPublicKey(t *testing.T) {
	valid := base64.StdEncoding.EncodeToString(make([]byte, 32))

	tests := []struct {
		name  string
		input string
		want  string
		ok    bool
	}{
		{name: "omitted is allowed", input: "", want: "", ok: true},
		{name: "whitespace only is omitted", input: "   ", want: "", ok: true},
		{name: "valid 32-byte key", input: valid, want: valid, ok: true},
		{name: "valid key is trimmed", input: "  " + valid + "\n", want: valid, ok: true},
		{name: "too short is rejected", input: base64.StdEncoding.EncodeToString(make([]byte, 16)), ok: false},
		{name: "too long is rejected", input: base64.StdEncoding.EncodeToString(make([]byte, 33)), ok: false},
		{name: "not base64 is rejected", input: "not-a-valid-key!!!", ok: false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := normalizeEncryptionPublicKey(tc.input)
			if ok != tc.ok {
				t.Fatalf("ok = %v, want %v", ok, tc.ok)
			}
			if got != tc.want {
				t.Fatalf("value = %q, want %q", got, tc.want)
			}
		})
	}
}
