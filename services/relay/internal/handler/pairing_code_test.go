package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
)

// ---------- Unit tests (no DB) ----------

var codePattern = regexp.MustCompile(`^NODUS-[A-Z2-9]{4}-[A-Z2-9]{4}$`)

func TestGeneratePairingCodeShape(t *testing.T) {
	for i := 0; i < 100; i++ {
		code, err := generatePairingCode()
		require.NoError(t, err)
		require.Regexp(t, codePattern, code, "code %q does not match NODUS-XXXX-XXXX", code)
	}
}

func TestGeneratePairingCodeAlphabet(t *testing.T) {
	// The alphabet must be exactly A-Z minus I and O, plus digits 2-9 (32 chars).
	require.Len(t, pairingCodeAlphabet, 32, "alphabet must be 32 chars")
	require.Equal(t, "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", pairingCodeAlphabet)
	for _, ch := range pairingCodeAlphabet {
		require.Regexp(t, `[A-Z2-9]`, string(ch), "unexpected alphabet char %q", ch)
	}
	require.NotContains(t, pairingCodeAlphabet, "I")
	require.NotContains(t, pairingCodeAlphabet, "O")

	// Every generated symbol must come from the complete alphabet, and a large
	// sample must cover every character (nothing silently dropped).
	seen := make(map[byte]struct{})
	for i := 0; i < 2000; i++ {
		code, err := generatePairingCode()
		require.NoError(t, err)
		symbols := strings.TrimPrefix(code, "NODUS-")
		symbols = strings.ReplaceAll(symbols, "-", "")
		for _, ch := range symbols {
			require.Contains(t, pairingCodeAlphabet, string(ch), "char %q outside allowed alphabet in %q", ch, code)
			seen[byte(ch)] = struct{}{}
		}
	}
	require.Len(t, seen, 32, "sample must cover every alphabet char")
}

func TestGeneratePairingCodeUniqueness(t *testing.T) {
	seen := make(map[string]struct{}, 1000)
	for i := 0; i < 1000; i++ {
		code, err := generatePairingCode()
		require.NoError(t, err)
		seen[code] = struct{}{}
	}
	require.GreaterOrEqual(t, len(seen), 999, "expected ≥999 distinct codes out of 1000")
}

func TestNormalizeCode(t *testing.T) {
	require.Equal(t, "NODUS7K4P92XM", normalizeCode("NODUS-7K4P-92XM"))
	require.Equal(t, "NODUS7K4P92XM", normalizeCode("nodus-7k4p-92xm"))
	require.Equal(t, "NODUS7K4P92XM", normalizeCode("NODUS7K4P92XM"))
}

func TestHashCodeDeterminism(t *testing.T) {
	a := hashCode(normalizeCode("NODUS-7K4P-92XM"))
	b := hashCode(normalizeCode("NODUS-7K4P-92XM"))
	require.Equal(t, a, b)
	require.Len(t, a, 64, "SHA-256 hex digest must be 64 chars")
}

func TestHashCodeDiffersForDifferentInputs(t *testing.T) {
	a := hashCode(normalizeCode("NODUS-7K4P-92XM"))
	b := hashCode(normalizeCode("NODUS-AAAA-BBBB"))
	require.NotEqual(t, a, b)
}

// ---------- Integration tests (live Postgres) ----------

func createPairingCodeHarness(t *testing.T) *db.Pool {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping integration test")
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	require.NoError(t, db.RunMigrations(url), "run migrations")
	pool, err := db.Open(ctx, &config.Config{DatabaseURL: url})
	require.NoError(t, err, "open pool")
	t.Cleanup(pool.Close)

	_, err = pool.Exec(ctx,
		`INSERT INTO accounts (account_id, email, password_hash)
		 VALUES ('acct-pcode', 'pcode@test.local', 'x')
		 ON CONFLICT DO NOTHING`)
	require.NoError(t, err)
	return pool
}

func TestCreatePairingCodeIntegration(t *testing.T) {
	pool := createPairingCodeHarness(t)

	body := bytes.NewReader([]byte(`{}`))
	req := httptest.NewRequest("POST", "/pairing/codes", body)
	req = req.WithContext(context.WithValue(req.Context(), auth.AccountIDKey, "acct-pcode"))
	rr := httptest.NewRecorder()

	CreatePairingCode(pool)(rr, req)
	require.Equal(t, http.StatusCreated, rr.Code)

	var resp struct {
		Code      string    `json:"code"`
		ExpiresAt time.Time `json:"expires_at"`
	}
	require.NoError(t, json.NewDecoder(rr.Body).Decode(&resp))
	require.Regexp(t, codePattern, resp.Code)
	require.InDelta(t, 15*time.Minute.Seconds(), time.Until(resp.ExpiresAt).Seconds(), 60)

	// DB row: hash-only storage, never plaintext.
	hash := hashCode(normalizeCode(resp.Code))
	var (
		storedHash string
		status     string
		expires    time.Time
	)
	err := pool.QueryRow(context.Background(),
		`SELECT code_hash, status, expires_at FROM pairing_codes WHERE code_hash = $1`, hash,
	).Scan(&storedHash, &status, &expires)
	require.NoError(t, err)
	require.Equal(t, hash, storedHash)
	require.Equal(t, "PENDING", status)
	require.False(t, expires.IsZero())

	// Second call returns a different code.
	body2 := bytes.NewReader([]byte(`{}`))
	req2 := httptest.NewRequest("POST", "/pairing/codes", body2)
	req2 = req2.WithContext(context.WithValue(req2.Context(), auth.AccountIDKey, "acct-pcode"))
	rr2 := httptest.NewRecorder()
	CreatePairingCode(pool)(rr2, req2)
	require.Equal(t, http.StatusCreated, rr2.Code)

	var resp2 struct {
		Code string `json:"code"`
	}
	require.NoError(t, json.NewDecoder(rr2.Body).Decode(&resp2))
	require.NotEqual(t, resp.Code, resp2.Code)
}

func TestCreatePairingCodeUnauthorized(t *testing.T) {
	pool := createPairingCodeHarness(t)

	req := httptest.NewRequest("POST", "/pairing/codes", bytes.NewReader([]byte(`{}`)))
	rr := httptest.NewRecorder()
	CreatePairingCode(pool)(rr, req)
	require.Equal(t, http.StatusUnauthorized, rr.Code)
}
