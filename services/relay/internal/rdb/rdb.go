package rdb

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
	"github.com/redis/go-redis/v9"
)

// Client wraps redis.Client with helper methods.
type Client struct {
	*redis.Client
}

// Open creates a new Redis client connection.
func Open(ctx context.Context, cfg *config.Config) (*Client, error) {
	opts, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		return nil, fmt.Errorf("parsing redis url: %w", err)
	}

	client := redis.NewClient(opts)

	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	if err := client.Ping(pingCtx).Err(); err != nil {
		_ = client.Close()
		return nil, fmt.Errorf("pinging redis: %w", err)
	}

	return &Client{Client: client}, nil
}

// SetPresence marks a node or device as active with a given TTL.
func (c *Client) SetPresence(ctx context.Context, peerID string, ttl time.Duration) error {
	return c.Set(ctx, fmt.Sprintf("presence:%s", peerID), "1", ttl).Err()
}

// ClearPresence removes the presence key for a node or device.
func (c *Client) ClearPresence(ctx context.Context, peerID string) error {
	return c.Del(ctx, fmt.Sprintf("presence:%s", peerID)).Err()
}

// IsPresent checks if a peer is currently marked online.
func (c *Client) IsPresent(ctx context.Context, peerID string) (bool, error) {
	exists, err := c.Exists(ctx, fmt.Sprintf("presence:%s", peerID)).Result()
	if err != nil {
		return false, err
	}
	return exists > 0, nil
}

// AddPendingBuffer associates a buffer_id with a target node waiting to receive it.
func (c *Client) AddPendingBuffer(ctx context.Context, nodeID, bufferID string) error {
	return c.SAdd(ctx, fmt.Sprintf("pending:%s", nodeID), bufferID).Err()
}

// RemovePendingBuffer removes a buffer_id after delivery or cleanup.
func (c *Client) RemovePendingBuffer(ctx context.Context, nodeID, bufferID string) error {
	return c.SRem(ctx, fmt.Sprintf("pending:%s", nodeID), bufferID).Err()
}

// GetPendingBuffers lists all pending buffer_ids for a storage node.
func (c *Client) GetPendingBuffers(ctx context.Context, nodeID string) ([]string, error) {
	return c.SMembers(ctx, fmt.Sprintf("pending:%s", nodeID)).Result()
}

// SetAuthNonce stores a single-use challenge nonce bound to a session/conn ID with a given TTL.
func (c *Client) SetAuthNonce(ctx context.Context, sessionID, nonce string, ttl time.Duration) error {
	return c.Set(ctx, fmt.Sprintf("auth:nonce:%s", sessionID), nonce, ttl).Err()
}

// ConsumeAuthNonce retrieves and immediately deletes the nonce for sessionID, checking if it matches.
func (c *Client) ConsumeAuthNonce(ctx context.Context, sessionID, expectedNonce string) (bool, error) {
	key := fmt.Sprintf("auth:nonce:%s", sessionID)
	stored, err := c.GetDel(ctx, key).Result()
	if err == redis.Nil {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return stored == expectedNonce && expectedNonce != "", nil
}

// fetchTokenValue is what a fetch token resolves to. The node it was issued
// for is stored alongside the buffer_id so redemption can be checked against
// the node that proves its identity, instead of trusting whoever holds the
// token. It is JSON rather than a delimited string because a mis-split here
// would bind the token to the wrong node, which is the failure this whole
// structure exists to prevent.
type fetchTokenValue struct {
	NodeID   string `json:"node_id"`
	BufferID string `json:"buffer_id"`
}

// SetFetchToken stores a single-use, time-limited fetch token bound to the node
// the shard is destined for. The node redeems it against GET /buffer/fetch with
// `Authorization: Bearer <token>` plus its own request signature; 10-minute TTL
// is the v1 default.
func (c *Client) SetFetchToken(ctx context.Context, token, nodeID, bufferID string, ttl time.Duration) error {
	value, err := json.Marshal(fetchTokenValue{NodeID: nodeID, BufferID: bufferID})
	if err != nil {
		return fmt.Errorf("encoding fetch token: %w", err)
	}
	return c.Set(ctx, fmt.Sprintf("fetch_token:%s", token), value, ttl).Err()
}

// ConsumeFetchToken atomically retrieves and deletes the fetch token, returning
// the node it was issued for and the associated buffer_id. found is false when
// the token is missing or expired, which is the replay case.
//
// The token is consumed even when the caller turns out not to be the bound
// node: a single-use token that a wrong node can burn is a denial of service
// against the shard's real destination, and letting a rejected request keep its
// token would leave it redeemable by whoever raced it.
func (c *Client) ConsumeFetchToken(ctx context.Context, token string) (nodeID, bufferID string, found bool, err error) {
	key := fmt.Sprintf("fetch_token:%s", token)
	raw, err := c.GetDel(ctx, key).Result()
	if err == redis.Nil {
		return "", "", false, nil
	}
	if err != nil {
		return "", "", false, err
	}
	var value fetchTokenValue
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		// A value we cannot read the node binding from is a token we cannot
		// verify, so it is treated as absent rather than as a server fault. This
		// is also what a token minted by a Relay from before the binding existed
		// looks like — a bare buffer_id — and during a rolling deploy that is a
		// 401 the node recovers from with a fresh pending_notify, not a 500
		// that reads like the Relay is broken. It is logged because a silent
		// 401 is otherwise indistinguishable from an expiry.
		log.Printf("[rdb] fetch token value is not a node-bound token: %v", err)
		return "", "", false, nil
	}
	return value.NodeID, value.BufferID, true, nil
}
