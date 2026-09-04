package db

import (
	"context"
	"embed"
	"errors"
	"fmt"
	"time"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/postgres"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// Pool wraps pgxpool.Pool.
type Pool struct {
	*pgxpool.Pool
}

// Open creates a new PostgreSQL connection pool and runs database migrations.
func Open(ctx context.Context, cfg *config.Config) (*Pool, error) {
	// 1. Run migrations
	if err := RunMigrations(cfg.DatabaseURL); err != nil {
		return nil, fmt.Errorf("running migrations: %w", err)
	}

	// 2. Open pgx pool
	poolConfig, err := pgxpool.ParseConfig(cfg.DatabaseURL)
	if err != nil {
		return nil, fmt.Errorf("parsing db config: %w", err)
	}

	poolConfig.MaxConns = 25
	poolConfig.MinConns = 2
	poolConfig.MaxConnLifetime = 1 * time.Hour
	poolConfig.MaxConnIdleTime = 30 * time.Minute

	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return nil, fmt.Errorf("connecting to postgres: %w", err)
	}

	// Ping database to ensure connectivity
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("pinging postgres: %w", err)
	}

	return &Pool{Pool: pool}, nil
}

// RunMigrations executes embedded SQL migrations against the target database.
func RunMigrations(databaseURL string) error {
	driver, err := iofs.New(migrationsFS, "migrations")
	if err != nil {
		return fmt.Errorf("creating iofs driver: %w", err)
	}

	m, err := migrate.NewWithSourceInstance("iofs", driver, databaseURL)
	if err != nil {
		return fmt.Errorf("creating migrate instance: %w", err)
	}
	defer m.Close()

	if err := m.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		return err
	}

	return nil
}
