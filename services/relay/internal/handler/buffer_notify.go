package handler

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/rdb"
	"github.com/google/uuid"
)

// fetchTokenTTL bounds how long a single-use fetch token stays valid. Long
// enough that an offline node can plausibly reconnect, short enough that a
// leaked token isn't useful forever.
const fetchTokenTTL = 10 * time.Minute

// issueFetchToken stores a single-use, time-limited fetch token in Redis and
// returns it. It is bound to nodeID, the node the shard is destined for, so
// redemption proves the request came from that node and not merely from whoever
// ended up holding the token. Returns "" if Redis is unavailable or the write
// fails.
func issueFetchToken(ctx context.Context, rClient *rdb.Client, nodeID, bufferID string) string {
	if rClient == nil {
		return ""
	}
	if nodeID == "" {
		// Refuse to mint an unbound token. A token with no node attached is the
		// pre-binding behaviour, and it is the thing being removed here.
		log.Printf("[buffer-notify] refusing to issue unbound fetch token for buffer=%s", bufferID)
		return ""
	}
	token := uuid.NewString()
	if err := rClient.SetFetchToken(ctx, token, nodeID, bufferID, fetchTokenTTL); err != nil {
		log.Printf("[buffer-notify] warning: failed to issue fetch token for buffer=%s: %v", bufferID, err)
		return ""
	}
	return token
}

// buildPendingNotifyEnvelope issues a fetch token bound to targetNode and wraps
// the shard metadata in a pending_notify envelope ready for the wire. Returns
// (nil, false) when the token can't be issued (Redis down) since a notify
// without a redeemable token would dead-end the node.
func buildPendingNotifyEnvelope(ctx context.Context, rClient *rdb.Client, targetNode string, p PendingNotifyPayload) ([]byte, bool) {
	p.FetchToken = issueFetchToken(ctx, rClient, targetNode, p.BufferID)
	if p.FetchToken == "" {
		log.Printf("[buffer-notify] skipping pending_notify for buffer=%s (no fetch token)", p.BufferID)
		return nil, false
	}

	payloadBytes, err := json.Marshal(p)
	if err != nil {
		log.Printf("[buffer-notify] marshal error: %v", err)
		return nil, false
	}

	env := ProtocolEnvelope{
		Type:          "pending_notify",
		SchemaVersion: "1.0.0",
		MessageID:     uuid.NewString(),
		Timestamp:     time.Now().UTC().Format(time.RFC3339),
		Payload:       payloadBytes,
	}

	envBytes, err := json.Marshal(env)
	if err != nil {
		log.Printf("[buffer-notify] envelope marshal error: %v", err)
		return nil, false
	}
	return envBytes, true
}
