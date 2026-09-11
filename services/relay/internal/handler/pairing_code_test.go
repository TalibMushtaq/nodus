package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
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

func createPairingCodeHarness(t *testing.T) (*db.Pool, string) {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping integration test")
	}
	// The redeem rate limiter is a process-global (no Redis). Reset it so a
	// draining test (TestRedeemPairingCodeRateLimit) or an IP-seed collision
	// cannot leak a depleted bucket into an unrelated test.
	resetRedeemLimiter()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	require.NoError(t, db.RunMigrations(url), "run migrations")
	pool, err := db.Open(ctx, &config.Config{DatabaseURL: url})
	require.NoError(t, err, "open pool")
	t.Cleanup(pool.Close)

	// Fresh account per test so is_primary/first-node logic is deterministic
	// regardless of test order or leftover rows in a reused test database.
	accountID := "acct-" + uuid.NewString()
	_, err = pool.Exec(ctx,
		`INSERT INTO accounts (account_id, email, password_hash)
		 VALUES ($1, $2, 'x')
		 ON CONFLICT DO NOTHING`, accountID, accountID+"@test.local")
	require.NoError(t, err)
	return pool, accountID
}

func TestCreatePairingCodeIntegration(t *testing.T) {
	pool, accountID := createPairingCodeHarness(t)

	body := bytes.NewReader([]byte(`{}`))
	req := httptest.NewRequest("POST", "/pairing/codes", body)
	req = req.WithContext(context.WithValue(req.Context(), auth.AccountIDKey, accountID))
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
	req2 = req2.WithContext(context.WithValue(req2.Context(), auth.AccountIDKey, accountID))
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
	pool, _ := createPairingCodeHarness(t)

	req := httptest.NewRequest("POST", "/pairing/codes", bytes.NewReader([]byte(`{}`)))
	rr := httptest.NewRecorder()
	CreatePairingCode(pool)(rr, req)
	require.Equal(t, http.StatusUnauthorized, rr.Code)
}

// ---------- S2: RedeemPairingCode integration tests ----------

// mintCodeHelper creates a pairing code via the handler and returns the plaintext.
func mintCodeHelper(t *testing.T, pool *db.Pool, accountID string) string {
	t.Helper()
	req := httptest.NewRequest("POST", "/pairing/codes", bytes.NewReader([]byte(`{}`)))
	req = req.WithContext(context.WithValue(req.Context(), auth.AccountIDKey, accountID))
	rr := httptest.NewRecorder()
	CreatePairingCode(pool)(rr, req)
	require.Equal(t, http.StatusCreated, rr.Code)
	var resp struct {
		Code string `json:"code"`
	}
	require.NoError(t, json.NewDecoder(rr.Body).Decode(&resp))
	return resp.Code
}

func redeemBody(code, nodeID, publicKey string) *bytes.Reader {
	b, _ := json.Marshal(RedeemRequest{Code: code, NodeID: nodeID, PublicKey: publicKey})
	return bytes.NewReader(b)
}

// testRemoteAddr derives a stable fake client IP from a seed. Each test seeds
// with its unique accountID (FNV-1a fills the 32-bit IP space), so repeated
// runs (-count=N) or tests in the same package never collide in the shared
// global rate limiter's buckets.
func testRemoteAddr(seed string) string {
	h := fnv.New32a()
	_, _ = h.Write([]byte(seed))
	return fmt.Sprintf("192.0.2.%d:12345", h.Sum32()%250+2)
}

// resetRedeemLimiter clears the process-global redeem rate limiter's buckets so
// each integration test starts with a full burst. Belt-and-braces with
// testRemoteAddr's per-account seeding, since that helper only spans 250 IPs.
func resetRedeemLimiter() {
	redeemLimiter.mu.Lock()
	redeemLimiter.buckets = make(map[string]*ipBucket)
	redeemLimiter.mu.Unlock()
}

func TestRedeemPairingCodeSuccess(t *testing.T) {
	pool, accountID := createPairingCodeHarness(t)
	code := mintCodeHelper(t, pool, accountID)
	nodeID := "n-" + accountID

	pubKey := "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899"
	req := httptest.NewRequest("POST", "/pairing/codes/redeem", redeemBody(code, nodeID, pubKey))
	req.RemoteAddr = testRemoteAddr(accountID)
	rr := httptest.NewRecorder()
	RedeemPairingCode(pool, &config.Config{})(rr, req)

	require.Equal(t, http.StatusOK, rr.Code)
	var resp struct {
		Status    string `json:"status"`
		AccountID string `json:"account_id"`
	}
	require.NoError(t, json.NewDecoder(rr.Body).Decode(&resp))
	require.Equal(t, "ok", resp.Status)
	require.Equal(t, accountID, resp.AccountID)

	// DB: code is CONSUMED.
	var status string
	err := pool.QueryRow(context.Background(),
		`SELECT status FROM pairing_codes WHERE code_hash = $1`, hashCode(normalizeCode(code)),
	).Scan(&status)
	require.NoError(t, err)
	require.Equal(t, "CONSUMED", status)

	// DB: node exists under the account.
	var nodeAccount string
	err = pool.QueryRow(context.Background(),
		`SELECT account_id FROM storage_nodes WHERE node_id = $1`, nodeID,
	).Scan(&nodeAccount)
	require.NoError(t, err)
	require.Equal(t, accountID, nodeAccount)
}

func TestRedeemPairingCodeFirstNodeIsPrimary(t *testing.T) {
	pool, accountID := createPairingCodeHarness(t)
	code := mintCodeHelper(t, pool, accountID)
	nodeID := "n-" + accountID

	pubKey := "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899"
	req := httptest.NewRequest("POST", "/pairing/codes/redeem", redeemBody(code, nodeID, pubKey))
	req.RemoteAddr = testRemoteAddr(accountID)
	rr := httptest.NewRecorder()
	RedeemPairingCode(pool, &config.Config{})(rr, req)
	require.Equal(t, http.StatusOK, rr.Code)

	var isPrimary bool
	err := pool.QueryRow(context.Background(),
		`SELECT is_primary FROM storage_nodes WHERE node_id = $1`, nodeID,
	).Scan(&isPrimary)
	require.NoError(t, err)
	require.True(t, isPrimary, "first node must be is_primary")
}

func TestRedeemPairingCodeSecondNodeNotPrimary(t *testing.T) {
	pool, accountID := createPairingCodeHarness(t)
	node1 := "n1-" + accountID
	node2 := "n2-" + accountID

	// First node.
	code1 := mintCodeHelper(t, pool, accountID)
	pubKey := "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899"
	req1 := httptest.NewRequest("POST", "/pairing/codes/redeem", redeemBody(code1, node1, pubKey))
	req1.RemoteAddr = testRemoteAddr(accountID)
	rr1 := httptest.NewRecorder()
	RedeemPairingCode(pool, &config.Config{})(rr1, req1)
	require.Equal(t, http.StatusOK, rr1.Code)

	// Second node.
	code2 := mintCodeHelper(t, pool, accountID)
	req2 := httptest.NewRequest("POST", "/pairing/codes/redeem", redeemBody(code2, node2, pubKey))
	req2.RemoteAddr = testRemoteAddr(accountID)
	rr2 := httptest.NewRecorder()
	RedeemPairingCode(pool, &config.Config{})(rr2, req2)
	require.Equal(t, http.StatusOK, rr2.Code)

	var isPrimary bool
	err := pool.QueryRow(context.Background(),
		`SELECT is_primary FROM storage_nodes WHERE node_id = $1`, node2,
	).Scan(&isPrimary)
	require.NoError(t, err)
	require.False(t, isPrimary, "second node must not be is_primary")
}

func TestRedeemPairingCodeExpired(t *testing.T) {
	pool, accountID := createPairingCodeHarness(t)

	// Seed an expired PENDING code directly. The code is a fresh UUID so the
	// row never collides with a leftover from a previous test run.
	code := uuid.NewString()
	hash := hashCode(normalizeCode(code))
	_, err := pool.Exec(context.Background(),
		`INSERT INTO pairing_codes (code_hash, account_id, status, expires_at)
		 VALUES ($1, $2, 'PENDING', NOW() - interval '1 minute')`, hash, accountID)
	require.NoError(t, err)

	pubKey := "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899"
	req := httptest.NewRequest("POST", "/pairing/codes/redeem", redeemBody(code, "node-exp", pubKey))
	req.RemoteAddr = testRemoteAddr(accountID)
	rr := httptest.NewRecorder()
	RedeemPairingCode(pool, &config.Config{})(rr, req)
	require.Equal(t, http.StatusGone, rr.Code)

	var errResp struct {
		Error string `json:"error"`
	}
	require.NoError(t, json.NewDecoder(rr.Body).Decode(&errResp))
	require.Equal(t, "code_expired", errResp.Error)
}

func TestRedeemPairingCodeConsumed(t *testing.T) {
	pool, accountID := createPairingCodeHarness(t)
	code := mintCodeHelper(t, pool, accountID)
	nodeID := "n-" + accountID

	pubKey := "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899"

	// First redeem — succeeds.
	req1 := httptest.NewRequest("POST", "/pairing/codes/redeem", redeemBody(code, nodeID, pubKey))
	req1.RemoteAddr = testRemoteAddr(accountID)
	rr1 := httptest.NewRecorder()
	RedeemPairingCode(pool, &config.Config{})(rr1, req1)
	require.Equal(t, http.StatusOK, rr1.Code)

	// Second redeem — consumed.
	req2 := httptest.NewRequest("POST", "/pairing/codes/redeem", redeemBody(code, nodeID, pubKey))
	req2.RemoteAddr = testRemoteAddr(accountID)
	rr2 := httptest.NewRecorder()
	RedeemPairingCode(pool, &config.Config{})(rr2, req2)
	require.Equal(t, http.StatusConflict, rr2.Code)

	var errResp struct {
		Error string `json:"error"`
	}
	require.NoError(t, json.NewDecoder(rr2.Body).Decode(&errResp))
	require.Equal(t, "code_consumed", errResp.Error)
}

func TestRedeemPairingCodeUnknown(t *testing.T) {
	pool, accountID := createPairingCodeHarness(t)

	pubKey := "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899"
	req := httptest.NewRequest("POST", "/pairing/codes/redeem",
		redeemBody("NODUS-XXXX-XXXX", "node-unk", pubKey))
	req.RemoteAddr = testRemoteAddr(accountID)
	rr := httptest.NewRecorder()
	RedeemPairingCode(pool, &config.Config{})(rr, req)
	require.Equal(t, http.StatusNotFound, rr.Code)

	var errResp struct {
		Error string `json:"error"`
	}
	require.NoError(t, json.NewDecoder(rr.Body).Decode(&errResp))
	require.Equal(t, "code_unknown", errResp.Error)
}

func TestRedeemPairingCodeNodeOwnedElsewhere(t *testing.T) {
	pool, accountID := createPairingCodeHarness(t)

	// Register node under a different account.
	_, err := pool.Exec(context.Background(),
		`INSERT INTO accounts (account_id, email, password_hash)
		 VALUES ('acct-other', 'other@test.local', 'x')
		 ON CONFLICT DO NOTHING`)
	require.NoError(t, err)
	_, err = pool.Exec(context.Background(),
		`INSERT INTO storage_nodes (node_id, account_id, public_key)
		 VALUES ('node-owned', 'acct-other', 'deadbeef')
		 ON CONFLICT DO NOTHING`)
	require.NoError(t, err)

	code := mintCodeHelper(t, pool, accountID)
	pubKey := "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899"
	req := httptest.NewRequest("POST", "/pairing/codes/redeem",
		redeemBody(code, "node-owned", pubKey))
	req.RemoteAddr = testRemoteAddr(accountID)
	rr := httptest.NewRecorder()
	RedeemPairingCode(pool, &config.Config{})(rr, req)
	require.Equal(t, http.StatusConflict, rr.Code)

	var errResp struct {
		Error string `json:"error"`
	}
	require.NoError(t, json.NewDecoder(rr.Body).Decode(&errResp))
	require.Equal(t, "node_owned_elsewhere", errResp.Error)
}

func TestRedeemPairingCodeInvalidPublicKey(t *testing.T) {
	pool, accountID := createPairingCodeHarness(t)
	code := mintCodeHelper(t, pool, accountID)

	// Too short.
	req := httptest.NewRequest("POST", "/pairing/codes/redeem",
		redeemBody(code, "node-bad", "aabb"))
	req.RemoteAddr = testRemoteAddr(accountID)
	rr := httptest.NewRecorder()
	RedeemPairingCode(pool, &config.Config{})(rr, req)
	require.Equal(t, http.StatusBadRequest, rr.Code)

	var errResp struct {
		Error string `json:"error"`
	}
	require.NoError(t, json.NewDecoder(rr.Body).Decode(&errResp))
	require.Equal(t, "invalid public_key format", errResp.Error)
}

func TestRedeemPairingCodeRateLimit(t *testing.T) {
	pool, accountID := createPairingCodeHarness(t)

	// Drain the limiter by firing from the same IP with unknown codes.
	pubKey := "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899"
	for i := 0; i < 12; i++ {
		req := httptest.NewRequest("POST", "/pairing/codes/redeem",
			redeemBody("NODUS-XXXX-XXXX", "node-rl", pubKey))
		req.RemoteAddr = testRemoteAddr(accountID)
		rr := httptest.NewRecorder()
		RedeemPairingCode(pool, &config.Config{})(rr, req)
		// After burst (10) is exhausted, expect 429.
		if i >= 10 {
			require.Equal(t, http.StatusTooManyRequests, rr.Code)
		}
	}
}

func TestRedeemConcurrentDoubleRedeem(t *testing.T) {
	pool, accountID := createPairingCodeHarness(t)
	code := mintCodeHelper(t, pool, accountID)
	nodeID := "n-" + accountID

	pubKey := "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899"
	const goroutines = 5
	results := make(chan int, goroutines)

	for i := 0; i < goroutines; i++ {
		go func(idx int) {
			body := redeemBody(code, nodeID, pubKey)
			req := httptest.NewRequest("POST", "/pairing/codes/redeem", body)
			req.RemoteAddr = testRemoteAddr(accountID)
			rr := httptest.NewRecorder()
			RedeemPairingCode(pool, &config.Config{})(rr, req)
			results <- rr.Code
		}(i)
	}

	wins, losses := 0, 0
	codes := make([]int, 0, goroutines)
	for i := 0; i < goroutines; i++ {
		codes = append(codes, <-results)
	}
	for _, code := range codes {
		switch code {
		case http.StatusOK:
			wins++
		case http.StatusConflict:
			losses++
		default:
			t.Fatalf("unexpected status code %d from goroutine; codes=%v", code, codes)
		}
	}
	require.Equal(t, 1, wins, "exactly one goroutine must win the race")
	require.Equal(t, goroutines-1, losses, "all other goroutines must get code_consumed")
}

// codeStatus reads the persisted status for a plaintext code.
func codeStatus(t *testing.T, pool *db.Pool, code string) string {
	t.Helper()
	var status string
	err := pool.QueryRow(context.Background(),
		`SELECT status FROM pairing_codes WHERE code_hash = $1`, hashCode(normalizeCode(code)),
	).Scan(&status)
	require.NoError(t, err)
	return status
}

// A rejected node registration must roll back the consume, leaving the code
// PENDING so the account can retry with a different node_id.
func TestRedeemPairingCodeOwnedElsewhereDoesNotBurnCode(t *testing.T) {
	pool, accountID := createPairingCodeHarness(t)

	_, err := pool.Exec(context.Background(),
		`INSERT INTO accounts (account_id, email, password_hash)
		 VALUES ('acct-other-nb', 'other-nb@test.local', 'x')
		 ON CONFLICT DO NOTHING`)
	require.NoError(t, err)
	_, err = pool.Exec(context.Background(),
		`INSERT INTO storage_nodes (node_id, account_id, public_key)
		 VALUES ('node-owned-nb', 'acct-other-nb', 'deadbeef')
		 ON CONFLICT DO NOTHING`)
	require.NoError(t, err)

	code := mintCodeHelper(t, pool, accountID)
	pubKey := "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899"

	req := httptest.NewRequest("POST", "/pairing/codes/redeem",
		redeemBody(code, "node-owned-nb", pubKey))
	req.RemoteAddr = testRemoteAddr(accountID)
	rr := httptest.NewRecorder()
	RedeemPairingCode(pool, &config.Config{})(rr, req)
	require.Equal(t, http.StatusConflict, rr.Code)
	require.Equal(t, "PENDING", codeStatus(t, pool, code), "rejected registration must not burn the code")

	// Retry with a free node_id on the same code succeeds.
	free := "n-free-" + accountID
	req2 := httptest.NewRequest("POST", "/pairing/codes/redeem",
		redeemBody(code, free, pubKey))
	req2.RemoteAddr = testRemoteAddr(accountID)
	rr2 := httptest.NewRecorder()
	RedeemPairingCode(pool, &config.Config{})(rr2, req2)
	require.Equal(t, http.StatusOK, rr2.Code)
	require.Equal(t, "CONSUMED", codeStatus(t, pool, code))
}

func TestRedeemPairingCodeRevoked(t *testing.T) {
	pool, accountID := createPairingCodeHarness(t)

	code := uuid.NewString()
	_, err := pool.Exec(context.Background(),
		`INSERT INTO pairing_codes (code_hash, account_id, status, expires_at)
		 VALUES ($1, $2, 'REVOKED', NOW() + interval '5 minutes')`,
		hashCode(normalizeCode(code)), accountID)
	require.NoError(t, err)

	pubKey := "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899"
	req := httptest.NewRequest("POST", "/pairing/codes/redeem",
		redeemBody(code, "node-rev", pubKey))
	req.RemoteAddr = testRemoteAddr(accountID)
	rr := httptest.NewRecorder()
	RedeemPairingCode(pool, &config.Config{})(rr, req)
	require.Equal(t, http.StatusGone, rr.Code)

	var errResp struct {
		Error string `json:"error"`
	}
	require.NoError(t, json.NewDecoder(rr.Body).Decode(&errResp))
	require.Equal(t, "code_revoked", errResp.Error)
}

func TestRedeemPairingCodeInvalidNodeID(t *testing.T) {
	pool, accountID := createPairingCodeHarness(t)
	code := mintCodeHelper(t, pool, accountID)
	pubKey := "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899"

	for name, nodeID := range map[string]string{
		"empty":      "",
		"too_long":   strings.Repeat("a", 129),
		"whitespace": "node id",
	} {
		t.Run(name, func(t *testing.T) {
			req := httptest.NewRequest("POST", "/pairing/codes/redeem",
				redeemBody(code, nodeID, pubKey))
			req.RemoteAddr = testRemoteAddr(accountID)
			rr := httptest.NewRecorder()
			RedeemPairingCode(pool, &config.Config{})(rr, req)
			require.Equal(t, http.StatusBadRequest, rr.Code)
		})
	}

	// The code survives every rejected attempt.
	require.Equal(t, "PENDING", codeStatus(t, pool, code))
}
