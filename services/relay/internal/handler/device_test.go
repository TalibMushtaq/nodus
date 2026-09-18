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

// The device-info fields are request-controlled text echoed back to every
// client, so they must be trimmed, dropped when empty, and length-capped.
func TestDeviceInfoSanitization(t *testing.T) {
	platform, osVersion, browser, appVersion, userAgent := deviceInfoColumns(&DeviceInfo{
		Platform:   "  web  ",
		OSVersion:  "Linux",
		Browser:    "Chrome 126",
		AppVersion: "",
		UserAgent:  string(make([]rune, 300)), // 300 NUL runes → capped at 256
	})
	if platform == nil || *platform != "web" {
		t.Fatalf("platform = %v, want web", platform)
	}
	if appVersion != nil {
		t.Fatalf("empty app_version should be absent, got %v", *appVersion)
	}
	if userAgent == nil || len([]rune(*userAgent)) != 256 {
		t.Fatalf("user_agent should be capped at 256 runes, got %v", userAgent)
	}

	// An omitted block stores nothing...
	if p, o, b, a, u := deviceInfoColumns(nil); p != nil || o != nil || b != nil || a != nil || u != nil {
		t.Fatal("nil DeviceInfo should produce no columns")
	}
	// ...and rebuilding from all-nil columns yields no response object.
	if info := deviceInfoFromColumns(nil, nil, nil, nil, nil); info != nil {
		t.Fatalf("expected nil DeviceInfo, got %+v", info)
	}
	// Round-trip: a populated set rebuilds.
	if info := deviceInfoFromColumns(platform, osVersion, browser, nil, userAgent); info == nil || info.Browser != "Chrome 126" {
		t.Fatalf("expected rebuilt DeviceInfo, got %+v", info)
	}
}
