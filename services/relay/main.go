package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/lib/pq"

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
	"github.com/TalibMushtaq/nodus/services/relay/internal/buffer"
	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
	"github.com/TalibMushtaq/nodus/services/relay/internal/handler"
	"github.com/TalibMushtaq/nodus/services/relay/internal/hub"
	"github.com/TalibMushtaq/nodus/services/relay/internal/rdb"
	"github.com/TalibMushtaq/nodus/services/relay/internal/tombstone"
)

// permanentDBError reports database errors that retrying cannot fix:
// authentication/authorization failures (SQLSTATE class 28) and a missing
// database (3D000). Anything unclassified is treated as transient — the
// fresh-deploy race (connection refused, or "starting up" 57P03) must keep its
// retry budget, so only positively-identified permanent errors skip it.
func permanentDBError(err error) bool {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && permanentSQLState(pgErr.Code) {
		return true
	}
	// Migrations run through golang-migrate's lib/pq driver, whose errors are
	// not pgx types; check both so a bad password fails fast regardless of
	// which stage reported it.
	var pqErr *pq.Error
	if errors.As(err, &pqErr) && permanentSQLState(string(pqErr.Code)) {
		return true
	}
	return false
}

func permanentSQLState(code string) bool {
	return strings.HasPrefix(code, "28") || code == "3D000"
}

// openDatabaseWithRetry opens PostgreSQL and runs migrations, retrying on a
// bounded backoff. It returns nil only after the budget is exhausted (or on a
// permanent misconfiguration), which preserves the Relay's optional-DB mode for
// local/dev runs. The retry exists so a fresh deployment cannot come up in
// degraded mode just because Postgres was still initializing when the Relay
// started.
func openDatabaseWithRetry(ctx context.Context, cfg *config.Config) *db.Pool {
	const attempts = 12
	const delay = 5 * time.Second
	for i := 1; i <= attempts; i++ {
		pool, err := db.Open(ctx, cfg)
		if err == nil {
			return pool
		}
		if permanentDBError(err) {
			log.Printf(
				"[relay] postgresql misconfigured (%v); not retrying. Starting with limited functionality.",
				err,
			)
			return nil
		}
		if i == attempts {
			log.Printf(
				"[relay] warning: postgresql unavailable after %d attempts (%v). Starting with limited functionality.",
				i, err,
			)
			return nil
		}
		log.Printf("[relay] postgresql not ready (attempt %d/%d): %v; retrying in %s", i, attempts, err, delay)
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(delay):
		}
	}
	return nil
}

func main() {
	log.Println("[relay] starting Nodus Relay control-plane server...")

	// 1. Load configuration
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("[relay] configuration error: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// 2. PostgreSQL initialization & migrations. A fresh deploy can race
	// PostgreSQL's entrypoint: during initdb it briefly serves a temporary,
	// socket-only server before the real one listens, so a one-shot connect can
	// fail and leave the Relay degraded (auth/pairing routes unregistered).
	// Retry within a bounded window before falling back to the optional-DB mode.
	var pool *db.Pool
	if p := openDatabaseWithRetry(ctx, cfg); p != nil {
		pool = p
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

	// Auth Endpoints (Phase 7a: opaque server-side sessions — no JWT/refresh;
	// §2 completes the surface with device auto-registration and session body)
	var sessionStore auth.SessionStore
	if pool != nil {
		sessionStore = auth.NewPGSessionStore(pool, cfg)

		mux.HandleFunc("POST /auth/register", handler.Register(pool, sessionStore, cfg))
		mux.HandleFunc("POST /auth/login", handler.Login(pool, sessionStore, cfg))
		mux.HandleFunc("GET /auth/session", handler.Session(sessionStore, cfg))
		mux.HandleFunc("POST /auth/logout", handler.Logout(sessionStore, cfg))

		// Device & Node Management (Authenticated)
		mux.Handle("POST /devices/register", auth.RequireAuth(sessionStore, cfg)(handler.RegisterDevice(pool)))
		mux.Handle("GET /devices", auth.RequireAuth(sessionStore, cfg)(handler.ListDevices(pool)))
		mux.Handle("DELETE /devices/{id}", auth.RequireAuth(sessionStore, cfg)(handler.RevokeDevice(pool, sessionStore)))

		mux.Handle("POST /nodes/register", auth.RequireAuth(sessionStore, cfg)(handler.RegisterNode(pool)))
		mux.Handle("GET /nodes", auth.RequireAuth(sessionStore, cfg)(handler.ListNodes(pool)))

		// Phase 11: pairing session issuance (device-bound tokens pushed to the
		// node over WS) plus the node's + client's open verification endpoints.
		mux.Handle("POST /pairing/sessions", auth.RequireAuth(sessionStore, cfg)(handler.CreatePairingSession(pool, wsHub)))
		mux.HandleFunc("POST /pairing/sessions/verify", handler.VerifyPairingSession(pool))
		mux.HandleFunc("GET /nodes/verify", handler.VerifyNodeURL(pool))

		// Phase 7b: self-hosted node bootstrap pairing codes
		mux.Handle("POST /pairing/codes", auth.RequireAuth(sessionStore, cfg)(handler.CreatePairingCode(pool)))
		mux.HandleFunc("POST /pairing/codes/redeem", handler.RedeemPairingCode(pool, cfg))

		// Phase 9: trigger a full snapshot / Relay rebuild from the primary node
		mux.Handle("POST /rebuild", auth.RequireAuth(sessionStore, cfg)(handler.RequestRebuild(pool, wsHub)))

		// Phase 10: Path C relay buffer — client pushes shards here when the
		// target Storage Node is offline; the node pulls them with a single-use
		// token via /buffer/fetch (deliberately unauthenticated).
		mux.Handle("POST /buffer/upload", auth.RequireAuth(sessionStore, cfg)(handler.BufferUpload(pool, redisClient, buf, wsHub)))
		mux.HandleFunc("GET /buffer/fetch", handler.BufferFetch(pool, redisClient, buf))
	}

	// WebSocket Gateway (browser auth via session cookie; node auth via Ed25519
	// challenge-response)
	mux.HandleFunc("GET /ws", handler.WebSocket(wsHub, pool, redisClient, buf, sessionStore, cfg))

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
