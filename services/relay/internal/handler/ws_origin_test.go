package handler

import (
	"net/http"
	"testing"

	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
	"github.com/stretchr/testify/require"
)

func TestOriginAllowed(t *testing.T) {
	cfg := &config.Config{AllowedOrigins: []string{"http://localhost:3000"}}

	cases := []struct {
		name   string
		origin string
		host   string
		want   bool
	}{
		{"no Origin (native storage node)", "", "relay:8080", true},
		{"same-origin (React Native app)", "http://10.0.2.2:8080", "10.0.2.2:8080", true},
		{"allowlisted browser origin", "http://localhost:3000", "relay:8080", true},
		{"cross-origin browser", "http://evil.example", "relay:8080", false},
		{"malformed origin", "not-a-url", "relay:8080", false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := &http.Request{Header: http.Header{}, Host: tc.host}
			if tc.origin != "" {
				r.Header.Set("Origin", tc.origin)
			}
			require.Equal(t, tc.want, originAllowed(r, cfg))
		})
	}
}
