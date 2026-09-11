package handler

import (
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
)

func TestClientIPStripsPort(t *testing.T) {
	r := httptest.NewRequest("POST", "/pairing/codes/redeem", nil)
	r.RemoteAddr = "203.0.113.7:443"
	require.Equal(t, "203.0.113.7", clientIP(r, &config.Config{}))
}

func TestClientIPIPv6(t *testing.T) {
	r := httptest.NewRequest("POST", "/pairing/codes/redeem", nil)
	r.RemoteAddr = "[2001:db8::1]:9999"
	require.Equal(t, "2001:db8::1", clientIP(r, &config.Config{}))
}

func TestClientIPBareHost(t *testing.T) {
	r := httptest.NewRequest("POST", "/pairing/codes/redeem", nil)
	r.RemoteAddr = "203.0.113.7"
	require.Equal(t, "203.0.113.7", clientIP(r, &config.Config{}))
}

func TestClientIPIgnoresXFFByDefault(t *testing.T) {
	r := httptest.NewRequest("POST", "/pairing/codes/redeem", nil)
	r.RemoteAddr = "203.0.113.7:443"
	r.Header.Set("X-Forwarded-For", "198.51.100.9, 10.0.0.1")
	require.Equal(t, "203.0.113.7", clientIP(r, &config.Config{TrustProxy: false}))
}

func TestClientIPTakesXFFWhenTrusted(t *testing.T) {
	r := httptest.NewRequest("POST", "/pairing/codes/redeem", nil)
	r.RemoteAddr = "10.0.0.1:443"
	r.Header.Set("X-Forwarded-For", "198.51.100.9, 10.0.0.1")
	require.Equal(t, "198.51.100.9", clientIP(r, &config.Config{TrustProxy: true}))
}

func TestClientIPFallsBackOnBadXFF(t *testing.T) {
	r := httptest.NewRequest("POST", "/pairing/codes/redeem", nil)
	r.RemoteAddr = "10.0.0.1:443"
	r.Header.Set("X-Forwarded-For", "not-an-ip, 10.0.0.1")
	require.Equal(t, "10.0.0.1", clientIP(r, &config.Config{TrustProxy: true}))
}

func TestClientIPNilConfig(t *testing.T) {
	r := httptest.NewRequest("POST", "/pairing/codes/redeem", nil)
	r.RemoteAddr = "203.0.113.7:443"
	r.Header.Set("X-Forwarded-For", "198.51.100.9")
	require.Equal(t, "203.0.113.7", clientIP(r, nil))
}
