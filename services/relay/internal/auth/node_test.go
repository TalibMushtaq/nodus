package auth

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// TestVerifyNodeRequest covers the stateless node-signature contract: a valid
// signature over the exact method/path/timestamp verifies, and a signature
// bound to one path cannot be replayed against another or after the skew window.
func TestVerifyNodeRequest(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	pubHex := hex.EncodeToString(pub)

	now := time.Now().UTC()
	ts := now.UnixMilli()
	tsStr := strconv.FormatInt(ts, 10)
	sign := func(method, path string) string {
		return hex.EncodeToString(ed25519.Sign(priv, NodeRequestMessage("node-1", method, path, ts)))
	}

	require.NoError(t, VerifyNodeRequest(
		pubHex, "node-1", "GET", "/node/shards/abc", tsStr, sign("GET", "/node/shards/abc"), now, 5*time.Minute,
	))

	// The signature binds the path: a capture for one object cannot fetch another.
	require.Error(t, VerifyNodeRequest(
		pubHex, "node-1", "GET", "/node/shards/other", tsStr, sign("GET", "/node/shards/abc"), now, 5*time.Minute,
	))
	// The signature binds the method too.
	require.Error(t, VerifyNodeRequest(
		pubHex, "node-1", "POST", "/node/shards/abc", tsStr, sign("GET", "/node/shards/abc"), now, 5*time.Minute,
	))
	// Outside the skew window is rejected.
	require.Error(t, VerifyNodeRequest(
		pubHex, "node-1", "GET", "/node/shards/abc", tsStr, sign("GET", "/node/shards/abc"), now.Add(10*time.Minute), 5*time.Minute,
	))
	// Malformed inputs fail closed.
	require.Error(t, VerifyNodeRequest(
		"not-hex", "node-1", "GET", "/node/shards/abc", tsStr, sign("GET", "/node/shards/abc"), now, 5*time.Minute,
	))
	require.Error(t, VerifyNodeRequest(
		pubHex, "node-1", "GET", "/node/shards/abc", "not-an-int", sign("GET", "/node/shards/abc"), now, 5*time.Minute,
	))
	require.Error(t, VerifyNodeRequest(
		pubHex, "node-1", "GET", "/node/shards/abc", tsStr, "zz", now, 5*time.Minute,
	))
}

type fakeNodeStore struct {
	accountID string
	publicKey string
	err       error
}

func (f fakeNodeStore) NodeIdentity(_ context.Context, _ string) (string, string, error) {
	return f.accountID, f.publicKey, f.err
}

// TestRequireNodeAuth covers the middleware without a database: a valid signed
// request reaches the handler with the node's account in context, while
// missing/unknown/invalid credentials are rejected with 401.
func TestRequireNodeAuth(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)

	handler := RequireNodeAuth(
		fakeNodeStore{accountID: "acct-1", publicKey: hex.EncodeToString(pub)},
		5*time.Minute,
	)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		accountID, ok := GetAccountID(r.Context())
		require.True(t, ok)
		_, _ = w.Write([]byte(accountID))
	}))

	signRequest := func(nodeID, method, path string) *http.Request {
		ts := time.Now().UTC().UnixMilli()
		sig := hex.EncodeToString(ed25519.Sign(priv, NodeRequestMessage(nodeID, method, path, ts)))
		req := httptest.NewRequest(method, path, nil)
		req.Header.Set(NodeIDHeader, nodeID)
		req.Header.Set(NodeTimestampHeader, strconv.FormatInt(ts, 10))
		req.Header.Set(NodeSignatureHeader, sig)
		return req
	}

	valid := httptest.NewRecorder()
	handler.ServeHTTP(valid, signRequest("node-1", "GET", "/node/shards/abc"))
	require.Equal(t, http.StatusOK, valid.Code)
	require.Equal(t, "acct-1", valid.Body.String())

	// Missing headers.
	missing := httptest.NewRecorder()
	handler.ServeHTTP(missing, httptest.NewRequest("GET", "/node/shards/abc", nil))
	require.Equal(t, http.StatusUnauthorized, missing.Code)

	// Correct signature for a different path than the one requested.
	wrongPath := httptest.NewRecorder()
	req := signRequest("node-1", "GET", "/node/shards/other")
	req.URL.Path = "/node/shards/abc"
	handler.ServeHTTP(wrongPath, req)
	require.Equal(t, http.StatusUnauthorized, wrongPath.Code)

	// Unknown/inactive node.
	unknown := RequireNodeAuth(
		fakeNodeStore{err: ErrNodeUnauthorized},
		5*time.Minute,
	)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }))
	unknownRec := httptest.NewRecorder()
	unknown.ServeHTTP(unknownRec, signRequest("node-x", "GET", "/node/shards/abc"))
	require.Equal(t, http.StatusUnauthorized, unknownRec.Code)
}
