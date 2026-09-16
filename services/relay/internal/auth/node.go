package auth

import (
	"context"
	"crypto/ed25519"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Headers a storage node uses for stateless HTTP authentication (node→relay),
// mirroring the device signature scheme the edge nodes use locally.
const (
	NodeIDHeader        = "X-Nodus-Node-Id"
	NodeTimestampHeader = "X-Nodus-Timestamp"
	NodeSignatureHeader = "X-Nodus-Signature"
)

// ErrNodeUnauthorized is the single failure surface for node request auth.
var ErrNodeUnauthorized = errors.New("invalid node authentication")

// NodeIDKey carries the authenticated node id in the request context.
const NodeIDKey contextKey = "node_id"

// NodeStore resolves a storage node's account and Ed25519 public key.
// Implemented by PGSessionStore so auth does not depend on the db package.
type NodeStore interface {
	NodeIdentity(ctx context.Context, nodeID string) (accountID, publicKeyHex string, err error)
}

// NodeRequestMessage is the canonical byte string a node signs for an HTTP
// request. It binds node id, method, path and timestamp so a signature captured
// for one endpoint cannot be replayed against another within the skew window.
func NodeRequestMessage(nodeID, method, path string, timestampMillis int64) []byte {
	return []byte(fmt.Sprintf("nodus-node-request:%s:%s:%s:%d", nodeID, method, path, timestampMillis))
}

// VerifyNodeRequest validates a node's signed request. It is pure — the caller
// supplies the already-resolved public key — so it is unit-testable without a
// database. `now`/`maxSkew` bound replay of a captured request.
func VerifyNodeRequest(
	publicKeyHex, nodeID, method, path, timestamp, signatureHex string,
	now time.Time,
	maxSkew time.Duration,
) error {
	ts, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil {
		return fmt.Errorf("%w: timestamp must be an integer", ErrNodeUnauthorized)
	}
	skew := now.Sub(time.UnixMilli(ts))
	if skew < 0 {
		skew = -skew
	}
	if skew > maxSkew {
		return fmt.Errorf("%w: stale timestamp", ErrNodeUnauthorized)
	}

	pub, err := hex.DecodeString(publicKeyHex)
	if err != nil || len(pub) != ed25519.PublicKeySize {
		return fmt.Errorf("%w: malformed node public key", ErrNodeUnauthorized)
	}
	sig, err := hex.DecodeString(signatureHex)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return fmt.Errorf("%w: malformed signature", ErrNodeUnauthorized)
	}
	if !ed25519.Verify(ed25519.PublicKey(pub), NodeRequestMessage(nodeID, method, path, ts), sig) {
		return fmt.Errorf("%w: signature did not verify", ErrNodeUnauthorized)
	}
	return nil
}

// RequireNodeAuth guards node-only routes with a stateless Ed25519 signature.
// On success it sets the same AccountIDKey RequireAuth uses, so handlers that
// read auth.GetAccountID (e.g. FetchShard) work unchanged for session and node
// callers alike.
func RequireNodeAuth(store NodeStore, maxSkew time.Duration) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			nodeID := strings.TrimSpace(r.Header.Get(NodeIDHeader))
			timestamp := strings.TrimSpace(r.Header.Get(NodeTimestampHeader))
			signature := strings.TrimSpace(r.Header.Get(NodeSignatureHeader))
			if nodeID == "" || timestamp == "" || signature == "" {
				http.Error(w, `{"error":"missing node authentication"}`, http.StatusUnauthorized)
				return
			}

			accountID, publicKeyHex, err := store.NodeIdentity(r.Context(), nodeID)
			if err != nil {
				http.Error(w, `{"error":"unknown or inactive node"}`, http.StatusUnauthorized)
				return
			}
			if err := VerifyNodeRequest(publicKeyHex, nodeID, r.Method, r.URL.Path, timestamp, signature, time.Now().UTC(), maxSkew); err != nil {
				http.Error(w, `{"error":"invalid node authentication"}`, http.StatusUnauthorized)
				return
			}

			ctx := context.WithValue(r.Context(), AccountIDKey, accountID)
			ctx = context.WithValue(ctx, NodeIDKey, nodeID)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// GetNodeID extracts the authenticated node id from the request context.
func GetNodeID(ctx context.Context) (string, bool) {
	val := ctx.Value(NodeIDKey)
	if val == nil {
		return "", false
	}
	id, ok := val.(string)
	return id, ok
}
