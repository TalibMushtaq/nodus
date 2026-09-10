package hub

import (
	"context"
	"log"
	"sync"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/rdb"
	"github.com/gorilla/websocket"
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = (pongWait * 9) / 10
	maxMessageSize = 10 * 1024 * 1024 // 10MB (supports 8MB shard binary messages)
	// Per-connection read throttle (Phase 14a audit V4): a token bucket bounds
	// how fast a client's envelopes are processed. Without it an authenticated
	// client could amplify Redis SETs (heartbeat) or DB writes (event_batch)
	// across many connections.
	rateLimitBurst  = 250
	rateLimitRefill = 100 // tokens refilled per second
)

// Custom WebSocket close codes (RFC 6455 §7.4.1: 4000–4999 are
// application-defined).
const CloseCodeUnauthorized = 4001

// Client represents a connected WebSocket client.
type Client struct {
	Hub             *Hub
	ConnID          string
	AccountID       string
	NodeID          string // set if client is a storage node
	DeviceID        string // set if client is a user device
	IsAuthenticated bool
	AuthNonce       string
	AuthNonceExpiry time.Time

	Conn *websocket.Conn
	Send chan []byte

	// LastSeenAtSync throttles the node last_seen_at DB write to once a minute
	// (heartbeats arrive every 30s; a bespoke UPDATE per beat is wasteful).
	LastSeenAtSync time.Time

	// Phase 14a audit (V4): per-connection rate limiter state.
	rlMu      sync.Mutex
	rlBurst   float64
	rlRefill  float64
	rlTokens  float64
	rlLastRef time.Time
}

// Hub maintains the set of active clients and broadcasts messages.
type Hub struct {
	mu         sync.RWMutex
	clients    map[string]*Client            // ConnID -> Client
	byAccount  map[string]map[string]*Client // AccountID -> map[ConnID]*Client
	byNode     map[string]*Client            // NodeID -> Client
	byDevice   map[string]*Client            // DeviceID -> Client
	register   chan *Client
	unregister chan *Client
	rdb        *rdb.Client
}

// New creates a new Hub.
func New(redisClient *rdb.Client) *Hub {
	return &Hub{
		clients:    make(map[string]*Client),
		byAccount:  make(map[string]map[string]*Client),
		byNode:     make(map[string]*Client),
		byDevice:   make(map[string]*Client),
		register:   make(chan *Client),
		unregister: make(chan *Client),
		rdb:        redisClient,
	}
}

// Run executes the hub event loop.
func (h *Hub) Run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			h.mu.Lock()
			for _, client := range h.clients {
				close(client.Send)
				if client.Conn != nil {
					_ = client.Conn.Close()
				}
			}
			h.clients = make(map[string]*Client)
			h.byAccount = make(map[string]map[string]*Client)
			h.byNode = make(map[string]*Client)
			h.byDevice = make(map[string]*Client)
			h.mu.Unlock()
			return

		case client := <-h.register:
			h.mu.Lock()
			h.clients[client.ConnID] = client

			if client.AccountID != "" {
				if _, ok := h.byAccount[client.AccountID]; !ok {
					h.byAccount[client.AccountID] = make(map[string]*Client)
				}
				h.byAccount[client.AccountID][client.ConnID] = client
			}

			if client.NodeID != "" {
				h.byNode[client.NodeID] = client
				if h.rdb != nil {
					_ = h.rdb.SetPresence(ctx, client.NodeID, 2*pongWait)
				}
			}

			if client.DeviceID != "" {
				h.byDevice[client.DeviceID] = client
				if h.rdb != nil {
					_ = h.rdb.SetPresence(ctx, client.DeviceID, 2*pongWait)
				}
			}
			h.mu.Unlock()

			log.Printf("[hub] client registered: conn=%s account=%s node=%s device=%s",
				client.ConnID, client.AccountID, client.NodeID, client.DeviceID)

		case client := <-h.unregister:
			h.mu.Lock()
			if _, ok := h.clients[client.ConnID]; ok {
				delete(h.clients, client.ConnID)
				close(client.Send)

				if client.AccountID != "" {
					if accMap, ok := h.byAccount[client.AccountID]; ok {
						delete(accMap, client.ConnID)
						if len(accMap) == 0 {
							delete(h.byAccount, client.AccountID)
						}
					}
				}

				if client.NodeID != "" {
					delete(h.byNode, client.NodeID)
					if h.rdb != nil {
						_ = h.rdb.ClearPresence(ctx, client.NodeID)
					}
				}

				if client.DeviceID != "" {
					delete(h.byDevice, client.DeviceID)
					if h.rdb != nil {
						_ = h.rdb.ClearPresence(ctx, client.DeviceID)
					}
				}
			}
			h.mu.Unlock()

			log.Printf("[hub] client unregistered: conn=%s account=%s node=%s device=%s",
				client.ConnID, client.AccountID, client.NodeID, client.DeviceID)
		}
	}
}

// Register registers a new client to the hub.
func (h *Hub) Register(client *Client) {
	h.register <- client
}

// Unregister removes a client from the hub.
func (h *Hub) Unregister(client *Client) {
	h.unregister <- client
}

// SendToAccount sends a message to all connections belonging to the account.
func (h *Hub) SendToAccount(accountID string, msg []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	if clients, ok := h.byAccount[accountID]; ok {
		for _, c := range clients {
			select {
			case c.Send <- msg:
			default:
				log.Printf("[hub] warning: send buffer full for conn=%s", c.ConnID)
			}
		}
	}
}

// SendToNode sends a message to a specific storage node if connected.
func (h *Hub) SendToNode(nodeID string, msg []byte) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()

	if client, ok := h.byNode[nodeID]; ok {
		select {
		case client.Send <- msg:
			return true
		default:
			log.Printf("[hub] warning: send buffer full for node=%s", nodeID)
			return false
		}
	}
	return false
}

// SendToDevice sends a message to a specific device if connected.
func (h *Hub) SendToDevice(deviceID string, msg []byte) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()

	if client, ok := h.byDevice[deviceID]; ok {
		select {
		case client.Send <- msg:
			return true
		default:
			log.Printf("[hub] warning: send buffer full for device=%s", deviceID)
			return false
		}
	}
	return false
}

// SendToPeer sends a message to a specific peer (node or device) if connected.
func (h *Hub) SendToPeer(peerID string, msg []byte) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()

	if client, ok := h.byNode[peerID]; ok {
		select {
		case client.Send <- msg:
			return true
		default:
			log.Printf("[hub] warning: send buffer full for node=%s", peerID)
			return false
		}
	}

	if client, ok := h.byDevice[peerID]; ok {
		select {
		case client.Send <- msg:
			return true
		default:
			log.Printf("[hub] warning: send buffer full for device=%s", peerID)
			return false
		}
	}

	if client, ok := h.clients[peerID]; ok {
		select {
		case client.Send <- msg:
			return true
		default:
			log.Printf("[hub] warning: send buffer full for conn=%s", peerID)
			return false
		}
	}

	return false
}

// RefreshPresence resets the Redis TTL for this client.
func (h *Hub) RefreshPresence(ctx context.Context, peerID string) {
	if h.rdb != nil && peerID != "" {
		_ = h.rdb.SetPresence(ctx, peerID, 2*pongWait)
	}
}

// RateLimitAllowed reports whether this connection may process another message
// now (token bucket: burst fills, then refills at rateLimitRefill/s). Excess
// messages are silently dropped rather than disconnecting the socket, so a
// transient flood doesn't kill a legitimate client. See Phase 14a audit V4.
func (c *Client) RateLimitAllowed(now time.Time) bool {
	c.rlMu.Lock()
	defer c.rlMu.Unlock()

	// Lazy init: hand-built Client values (tests, older call sites) get defaults.
	if c.rlBurst == 0 {
		c.rlBurst = rateLimitBurst
		c.rlRefill = rateLimitRefill
		c.rlTokens = rateLimitBurst
		c.rlLastRef = now
	}

	if delta := now.Sub(c.rlLastRef); delta > 0 {
		c.rlTokens += delta.Seconds() * c.rlRefill
		if c.rlTokens > c.rlBurst {
			c.rlTokens = c.rlBurst
		}
		c.rlLastRef = now
	}

	if c.rlTokens >= 1 {
		c.rlTokens--
		return true
	}
	return false
}

// ReadPump pumps messages from the websocket connection to the hub/application.
func (c *Client) ReadPump(handleMessage func(client *Client, msgType int, payload []byte)) {
	defer func() {
		c.Hub.Unregister(c)
		_ = c.Conn.Close()
	}()

	c.Conn.SetReadLimit(maxMessageSize)
	_ = c.Conn.SetReadDeadline(time.Now().Add(pongWait))
	c.Conn.SetPongHandler(func(string) error {
		_ = c.Conn.SetReadDeadline(time.Now().Add(pongWait))
		if c.NodeID != "" {
			c.Hub.RefreshPresence(context.Background(), c.NodeID)
		} else if c.DeviceID != "" {
			c.Hub.RefreshPresence(context.Background(), c.DeviceID)
		}
		return nil
	})

	for {
		msgType, message, err := c.Conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure, CloseCodeUnauthorized) {
				log.Printf("[ws] unexpected close error: %v", err)
			}
			break
		}

		if handleMessage != nil {
			handleMessage(c, msgType, message)
		}
	}
}

// WritePump pumps messages from the hub to the websocket connection.
func (c *Client) WritePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		_ = c.Conn.Close()
	}()

	for {
		select {
		case message, ok := <-c.Send:
			_ = c.Conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				_ = c.Conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			w, err := c.Conn.NextWriter(websocket.TextMessage)
			if err != nil {
				return
			}
			if _, err := w.Write(message); err != nil {
				return
			}

			// Add queued chat messages to the current websocket frame
			n := len(c.Send)
			for i := 0; i < n; i++ {
				_, _ = w.Write([]byte{'\n'})
				_, _ = w.Write(<-c.Send)
			}

			if err := w.Close(); err != nil {
				return
			}

		case <-ticker.C:
			_ = c.Conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.Conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
