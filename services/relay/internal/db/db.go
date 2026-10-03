package db

import (
	"context"
	"embed"
	"errors"
	"fmt"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/postgres"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// The abstraction below is intentionally a thin wrapper rather than a
// repository layer. The service keeps writing SQL inline; what changes is that
// the types in the signatures are ours, not the driver's, so the storage
// backend can move from PostgreSQL to SQLite without touching every call site a
// second time. Ecosystem types (pgx today, database/sql tomorrow) satisfy these
// interfaces directly, which is what keeps the wrappers small.

// CommandTag is the result of an Exec: at least the affected-row count.
type CommandTag interface {
	RowsAffected() int64
}

// Row is a single-row result.
type Row interface {
	Scan(dest ...any) error
}

// Rows is a multi-row result. Only the iteration surface the Relay actually
// uses is part of the contract.
type Rows interface {
	Next() bool
	Scan(dest ...any) error
	Err() error
	Close()
}

// Tx is one transaction. Begin returns a nested transaction (a savepoint in
// both PostgreSQL and SQLite) so a failing statement can be rolled back without
// poisoning the enclosing transaction.
type Tx interface {
	Exec(ctx context.Context, query string, args ...any) (CommandTag, error)
	Query(ctx context.Context, query string, args ...any) (Rows, error)
	QueryRow(ctx context.Context, query string, args ...any) Row
	Begin(ctx context.Context) (Tx, error)
	Commit(ctx context.Context) error
	Rollback(ctx context.Context) error
}

// DB is the connection surface the service depends on.
type DB interface {
	Exec(ctx context.Context, query string, args ...any) (CommandTag, error)
	Query(ctx context.Context, query string, args ...any) (Rows, error)
	QueryRow(ctx context.Context, query string, args ...any) Row
	Begin(ctx context.Context) (Tx, error)
	Ping(ctx context.Context) error
	Close()
}

// Driver-neutral error sentinels. The service layer must never see
// pgconn.PgError or a SQLite result code; it matches on these instead.
var (
	ErrNotFound        = errors.New("db: not found")
	ErrUniqueViolation = errors.New("db: unique violation")
	ErrForeignKey      = errors.New("db: foreign key violation")
	ErrBusy            = errors.New("db: busy")
)

// translate maps a driver error to a sentinel where one applies, wrapping the
// original message so diagnostics are not lost.
func translate(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505":
			return fmt.Errorf("%w: %s", ErrUniqueViolation, pgErr.Message)
		case "23503":
			return fmt.Errorf("%w: %s", ErrForeignKey, pgErr.Message)
		}
	}
	return err
}

// Pool owns the backing connection pool and is the concrete DB handed to the
// service. Callers keep taking *Pool; the method set is what makes the backend
// swappable.
type Pool struct {
	pool *pgxpool.Pool
}

// Compile-time confirmation that *Pool satisfies the service-facing DB.
var _ DB = (*Pool)(nil)

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

	return &Pool{pool: pool}, nil
}

func (p *Pool) Exec(ctx context.Context, query string, args ...any) (CommandTag, error) {
	return p.pool.Exec(ctx, query, args...)
}

func (p *Pool) Query(ctx context.Context, query string, args ...any) (Rows, error) {
	rows, err := p.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, translate(err)
	}
	return rowsWrapper{rows}, nil
}

func (p *Pool) QueryRow(ctx context.Context, query string, args ...any) Row {
	return rowWrapper{p.pool.QueryRow(ctx, query, args...)}
}

func (p *Pool) Begin(ctx context.Context) (Tx, error) {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return nil, translate(err)
	}
	return txWrapper{tx}, nil
}

func (p *Pool) Ping(ctx context.Context) error {
	return p.pool.Ping(ctx)
}

func (p *Pool) Close() {
	p.pool.Close()
}

// WithTx runs fn inside a transaction, rolling back on error or panic and
// committing otherwise. It is the preferred entry point for new code that does
// not need savepoints.
func WithTx(ctx context.Context, pool *Pool, fn func(Tx) error) (err error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() {
		if p := recover(); p != nil {
			_ = tx.Rollback(ctx)
			panic(p)
		}
	}()
	if err := fn(tx); err != nil {
		_ = tx.Rollback(ctx)
		return err
	}
	return tx.Commit(ctx)
}

// rowWrapper translates the driver's no-rows sentinel on Scan.
type rowWrapper struct {
	row pgx.Row
}

func (w rowWrapper) Scan(dest ...any) error {
	return translate(w.row.Scan(dest...))
}

// rowsWrapper passes iteration through and translates Scan/Err.
type rowsWrapper struct {
	rows pgx.Rows
}

func (w rowsWrapper) Next() bool             { return w.rows.Next() }
func (w rowsWrapper) Scan(dest ...any) error { return translate(w.rows.Scan(dest...)) }
func (w rowsWrapper) Err() error             { return translate(w.rows.Err()) }
func (w rowsWrapper) Close()                 { w.rows.Close() }

// txWrapper adapts pgx.Tx to Tx and translates driver errors.
type txWrapper struct {
	tx pgx.Tx
}

func (w txWrapper) Exec(ctx context.Context, query string, args ...any) (CommandTag, error) {
	return w.tx.Exec(ctx, query, args...)
}

func (w txWrapper) Query(ctx context.Context, query string, args ...any) (Rows, error) {
	rows, err := w.tx.Query(ctx, query, args...)
	if err != nil {
		return nil, translate(err)
	}
	return rowsWrapper{rows}, nil
}

func (w txWrapper) QueryRow(ctx context.Context, query string, args ...any) Row {
	return rowWrapper{w.tx.QueryRow(ctx, query, args...)}
}

// Begin opens a savepoint via pgx's nested transaction.
func (w txWrapper) Begin(ctx context.Context) (Tx, error) {
	tx, err := w.tx.Begin(ctx)
	if err != nil {
		return nil, translate(err)
	}
	return txWrapper{tx}, nil
}

func (w txWrapper) Commit(ctx context.Context) error   { return translate(w.tx.Commit(ctx)) }
func (w txWrapper) Rollback(ctx context.Context) error { return translate(w.tx.Rollback(ctx)) }

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
