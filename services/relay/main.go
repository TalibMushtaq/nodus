package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
	"github.com/TalibMushtaq/nodus/services/relay/internal/buffer"
	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
	"github.com/TalibMushtaq/nodus/services/relay/internal/handler"
	"github.com/TalibMushtaq/nodus/services/relay/internal/hub"
	"github.com/TalibMushtaq/nodus/services/relay/internal/rdb"
	"github.com/TalibMushtaq/nodus/services/relay/internal/tombstone"
)

func main() {
	log.Println("[relay] starting Nodus Relay control-plane server...")

	// 1. Load configuration
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("[relay] configuration error: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// 2. PostgreSQL initialization & migrations
	var pool *db.Pool
	pool, err = db.Open(ctx, cfg)
	if err != nil {
		log.Printf("[relay] warning: postgresql connection failed (%v). Starting with limited functionality.", err)
	} else {
		log.Println("[relay] postgresql: ready (migrations applied)")
		defer pool.Close()
	}

	// 3. Redis initialization
	var redisClient *rdb.Client
	redisClient, err = rdb.Open(ctx, cfg)
	if err != nil {
		log.Printf("[relay] warning: redis connection failed (%v). Ephemeral presence disabled.", err)
	} else {
		log.Println("[relay] redis: ready")
		defer redisClient.Close() // nolint:errcheck
	}

	// 4. Relay shard buffer initialization
	buf, err := buffer.New(cfg.BufferDir)
	if err != nil {
		log.Fatalf("[relay] failed to initialize buffer: %v", err)
	}
	log.Printf("[relay] buffer: ready (directory: %s)", buf.Dir())

	// 5. WebSocket Hub initialization
	wsHub := hub.New(redisClient)
	go wsHub.Run(ctx)
	log.Println("[relay] websocket hub: running")

	// 6. Start buffer TTL cleanup worker (sweeps every 30m)
	if pool != nil {
		go buffer.RunTTLSweep(ctx, pool, redisClient, buf, cfg.BufferTTL, 30*time.Minute)
		log.Println("[relay] buffer ttl sweeper: running")
	}

	// Phase 9: Start tombstone retention prune worker (90-day window,
	// per ADR-0005). Sweeps hourly.
	const tombstoneRetention = 90 * 24 * time.Hour
	if pool != nil {
		go tombstone.RunTombstonePrune(ctx, pool, tombstoneRetention, time.Hour)
		log.Println("[relay] tombstone retention pruner: running")
	}

	// Phase 9: Prune terminal rebuild_requests after their audit-window
	// (30 days) so the rebuild request table stays bounded. Sweeps hourly.
	const rebuildRequestRetention = 30 * 24 * time.Hour
	if pool != nil {
		go handler.RunRebuildRequestPrune(ctx, pool, rebuildRequestRetention, time.Hour)
		log.Println("[relay] rebuild request pruner: running")
	}

	// 7. Route registration
	mux := http.NewServeMux()

	// Health Check
	mux.HandleFunc("GET /health", handler.Health(pool, redisClient))

	// Auth Endpoints (Unauthenticated)
	if pool != nil {
		mux.HandleFunc("POST /auth/register", handler.Register(pool, cfg))
		mux.HandleFunc("POST /auth/login", handler.Login(pool, cfg))
		mux.HandleFunc("POST /auth/refresh", handler.RefreshToken(pool, cfg))
		mux.Handle("POST /auth/logout", auth.RequireAuth(cfg)(handler.Logout(pool)))

		// Device & Node Management (Authenticated)
		mux.Handle("POST /devices/register", auth.RequireAuth(cfg)(handler.RegisterDevice(pool)))
		mux.Handle("GET /devices", auth.RequireAuth(cfg)(handler.ListDevices(pool)))
		mux.Handle("DELETE /devices/{id}", auth.RequireAuth(cfg)(handler.RevokeDevice(pool)))

		mux.Handle("POST /nodes/register", auth.RequireAuth(cfg)(handler.RegisterNode(pool)))
		mux.Handle("GET /nodes", auth.RequireAuth(cfg)(handler.ListNodes(pool)))

		// Phase 11: pairing session issuance (device-bound tokens pushed to the
		// node over WS) plus the node's + client's open verification endpoints.
		mux.Handle("POST /pairing/sessions", auth.RequireAuth(cfg)(handler.CreatePairingSession(pool, wsHub)))
		mux.HandleFunc("POST /pairing/sessions/verify", handler.VerifyPairingSession(pool))
		mux.HandleFunc("GET /nodes/verify", handler.VerifyNodeURL(pool))

		// Phase 9: trigger a full snapshot / Relay rebuild from the primary node
		mux.Handle("POST /rebuild", auth.RequireAuth(cfg)(handler.RequestRebuild(pool, wsHub)))

		// Phase 10: Path C relay buffer — client pushes shards here when the
		// target Storage Node is offline; the node pulls them with a single-use
		// token via /buffer/fetch (no JWT required there).
		mux.Handle("POST /buffer/upload", auth.RequireAuth(cfg)(handler.BufferUpload(pool, redisClient, buf, wsHub)))
		mux.HandleFunc("GET /buffer/fetch", handler.BufferFetch(pool, redisClient, buf))
	}

	// WebSocket Gateway
	mux.HandleFunc("GET /ws", handler.WebSocket(wsHub, pool, redisClient, buf, cfg))

	// 8. HTTP Server Lifecycle
	server := &http.Server{
		Addr:         cfg.ListenAddr,
		Handler:      mux,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Graceful shutdown listener
	stopChan := make(chan os.Signal, 1)
	signal.Notify(stopChan, os.Interrupt, syscall.SIGTERM)

	go func() {
		log.Printf("[relay] listening on %s", cfg.ListenAddr)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("[relay] server error: %v", err)
		}
	}()

	<-stopChan
	log.Println("[relay] shutdown signal received, terminating gracefully...")

	cancel()

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()

	if err := server.Shutdown(shutdownCtx); err != nil {
		log.Printf("[relay] server shutdown error: %v", err)
	}

	log.Println("[relay] shutdown complete")
}
