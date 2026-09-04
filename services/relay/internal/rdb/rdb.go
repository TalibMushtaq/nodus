package rdb

import (
	"context"
	"fmt"
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
