package db

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/postgres"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	"github.com/jackc/pgx/v5/pgconn"
	_ "github.com/jackc/pgx/v5/stdlib"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// The abstraction below is intentionally a thin wrapper rather than a
// repository layer. The service keeps writing SQL inline; what changes is that
// the types in the signatures are ours, not the driver's, so the storage
// backend can move from PostgreSQL to SQLite without touching every call site a
// second time. database/sql types do not satisfy these interfaces directly
// (Close/RowsAffected signatures differ, and there is no nested transaction), so
// the small wrappers below adapt them.

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

// Tx is one transaction. Begin returns a nested transaction (a savepoint) so a
// failing statement can be rolled back without poisoning the enclosing
// transaction. database/sql has no nested transaction, so the savepoint is
// issued explicitly.
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
	if errors.Is(err, sql.ErrNoRows) {
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
	db *sql.DB
}

// Compile-time confirmation that *Pool satisfies the service-facing DB.
var _ DB = (*Pool)(nil)

// Open creates a new PostgreSQL connection pool and runs database migrations.
func Open(ctx context.Context, cfg *config.Config) (*Pool, error) {
	// 1. Run migrations
	if err := RunMigrations(cfg.DatabaseURL); err != nil {
		return nil, fmt.Errorf("running migrations: %w", err)
	}

	// 2. Open the database/sql pool through the pgx stdlib driver.
	pool, err := sql.Open("pgx", cfg.DatabaseURL)
	if err != nil {
		return nil, fmt.Errorf("parsing db config: %w", err)
	}

	pool.SetMaxOpenConns(25)
	pool.SetMaxIdleConns(2)
	pool.SetConnMaxLifetime(1 * time.Hour)
	pool.SetConnMaxIdleTime(30 * time.Minute)

	// Ping database to ensure connectivity
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	if err := pool.PingContext(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("pinging postgres: %w", err)
	}

	return &Pool{db: pool}, nil
}

func (p *Pool) Exec(ctx context.Context, query string, args ...any) (CommandTag, error) {
	res, err := p.db.ExecContext(ctx, query, args...)
	if err != nil {
		return nil, translate(err)
	}
	return sqlResult{res}, nil
}

func (p *Pool) Query(ctx context.Context, query string, args ...any) (Rows, error) {
	rows, err := p.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, translate(err)
	}
	return sqlRows{rows}, nil
}

func (p *Pool) QueryRow(ctx context.Context, query string, args ...any) Row {
	return sqlRow{p.db.QueryRowContext(ctx, query, args...)}
}

func (p *Pool) Begin(ctx context.Context) (Tx, error) {
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, translate(err)
	}
	seq := 0
	return &sqlTx{tx: tx, seq: &seq}, nil
}

func (p *Pool) Ping(ctx context.Context) error {
	return p.db.PingContext(ctx)
}

func (p *Pool) Close() {
	_ = p.db.Close()
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

// sqlResult adapts sql.Result to CommandTag.
type sqlResult struct {
	res sql.Result
}

func (r sqlResult) RowsAffected() int64 {
	n, _ := r.res.RowsAffected()
	return n
}

// sqlRow translates the driver's no-rows sentinel on Scan.
type sqlRow struct {
	row *sql.Row
}

func (w sqlRow) Scan(dest ...any) error {
	return translate(w.row.Scan(dest...))
}

// sqlRows passes iteration through and translates Scan/Err.
type sqlRows struct {
	rows *sql.Rows
}

func (w sqlRows) Next() bool             { return w.rows.Next() }
func (w sqlRows) Scan(dest ...any) error { return translate(w.rows.Scan(dest...)) }
func (w sqlRows) Err() error             { return translate(w.rows.Err()) }
func (w sqlRows) Close()                 { _ = w.rows.Close() }

// sqlTx adapts *sql.Tx to Tx and implements nested transactions as SAVEPOINTs.
// A root transaction shares one counter with its savepoints so names stay
// unique; a savepoint commits with RELEASE and rolls back with ROLLBACK TO
// followed by RELEASE, since ROLLBACK TO does not pop the savepoint.
type sqlTx struct {
	tx  *sql.Tx
	sp  string
	seq *int
}

func (t *sqlTx) Exec(ctx context.Context, query string, args ...any) (CommandTag, error) {
	res, err := t.tx.ExecContext(ctx, query, args...)
	if err != nil {
		return nil, translate(err)
	}
	return sqlResult{res}, nil
}

func (t *sqlTx) Query(ctx context.Context, query string, args ...any) (Rows, error) {
	rows, err := t.tx.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, translate(err)
	}
	return sqlRows{rows}, nil
}

func (t *sqlTx) QueryRow(ctx context.Context, query string, args ...any) Row {
	return sqlRow{t.tx.QueryRowContext(ctx, query, args...)}
}

func (t *sqlTx) Begin(ctx context.Context) (Tx, error) {
	name := fmt.Sprintf("sp_%d", *t.seq)
	*t.seq++
	if _, err := t.tx.ExecContext(ctx, "SAVEPOINT "+name); err != nil {
		return nil, translate(err)
	}
	return &sqlTx{tx: t.tx, sp: name, seq: t.seq}, nil
}

func (t *sqlTx) Commit(ctx context.Context) error {
	if t.sp != "" {
		if _, err := t.tx.ExecContext(ctx, "RELEASE SAVEPOINT "+t.sp); err != nil {
			return translate(err)
		}
		return nil
	}
	return translate(t.tx.Commit())
}

func (t *sqlTx) Rollback(ctx context.Context) error {
	if t.sp != "" {
		if _, err := t.tx.ExecContext(ctx, "ROLLBACK TO SAVEPOINT "+t.sp); err != nil {
			return translate(err)
		}
		if _, err := t.tx.ExecContext(ctx, "RELEASE SAVEPOINT "+t.sp); err != nil {
			return translate(err)
		}
		return nil
	}
	return translate(t.tx.Rollback())
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
