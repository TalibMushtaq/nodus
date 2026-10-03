package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
)

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
// a SQLite result code; it matches on these instead.
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
	return translateSQLite(err)
}

// adaptScanDest bridges INTEGER milliseconds back to time.Time. Call sites scan
// timestamps into *time.Time (and nullable **time.Time), but SQLite returns the
// stored INTEGER; wrapping the destination here keeps the representation out of
// every scan site, mirroring normalizeArgs on the write path.
func adaptScanDest(dest []any) []any {
	for i, d := range dest {
		switch v := d.(type) {
		case *time.Time:
			dest[i] = millisTime{dst: v}
		case **time.Time:
			dest[i] = millisTimePtr{dst: v}
		}
	}
	return dest
}

type millisTime struct{ dst *time.Time }

func (m millisTime) Scan(src any) error {
	switch v := src.(type) {
	case nil:
		*m.dst = time.Time{}
	case int64:
		*m.dst = time.UnixMilli(v).UTC()
	case float64:
		*m.dst = time.UnixMilli(int64(v)).UTC()
	case time.Time:
		*m.dst = v
	default:
		return fmt.Errorf("db: cannot scan %T into time.Time", src)
	}
	return nil
}

type millisTimePtr struct{ dst **time.Time }

func (m millisTimePtr) Scan(src any) error {
	switch v := src.(type) {
	case nil:
		*m.dst = nil
	case int64:
		t := time.UnixMilli(v).UTC()
		*m.dst = &t
	case float64:
		t := time.UnixMilli(int64(v)).UTC()
		*m.dst = &t
	case time.Time:
		t := v
		*m.dst = &t
	default:
		return fmt.Errorf("db: cannot scan %T into *time.Time", src)
	}
	return nil
}

// Placeholders returns n comma-separated positional placeholders for an IN
// list. SQLite cannot bind a slice as one parameter the way PostgreSQL's
// = ANY($1) can, so callers expand the list and append its values to the args.
func Placeholders(n int) string {
	if n <= 0 {
		return ""
	}
	return strings.TrimSuffix(strings.Repeat("?,", n), ",")
}

// normalizeArgs bridges Go values to SQLite's storage classes. Timestamps are
// INTEGER unix milliseconds, but the driver binds time.Time as RFC3339 text and
// []byte as a BLOB, both of which a STRICT column rejects. Converting here, at
// the one boundary every query crosses, keeps the representation out of every
// call site.
func normalizeArgs(args []any) []any {
	for i, a := range args {
		switch v := a.(type) {
		case time.Time:
			args[i] = v.UTC().UnixMilli()
		case *time.Time:
			if v == nil {
				args[i] = nil
			} else {
				args[i] = v.UTC().UnixMilli()
			}
		case []byte:
			args[i] = string(v)
		case json.RawMessage:
			args[i] = string(v)
		}
	}
	return args
}

// Pool owns the backing connection pools and is the concrete DB handed to the
// service. Callers keep taking *Pool; the method set is what makes the backend
// swappable.
//
// There are two handles because SQLite has a single writer: the writer pool is
// capped at one connection so every write serializes, while reads can use a
// separate connection. PostgreSQL uses the same *sql.DB for both.
type Pool struct {
	writer *sql.DB
	reader *sql.DB
	unlock func()
}

// Compile-time confirmation that *Pool satisfies the service-facing DB.
var _ DB = (*Pool)(nil)

// Open opens the SQLite-backed pool and applies the baseline migrations.
func Open(ctx context.Context, cfg *config.Config) (*Pool, error) {
	return openSQLite(ctx, cfg.DBPath)
}

func (p *Pool) Exec(ctx context.Context, query string, args ...any) (CommandTag, error) {
	res, err := p.writer.ExecContext(ctx, query, normalizeArgs(args)...)
	if err != nil {
		return nil, translate(err)
	}
	return sqlResult{res}, nil
}

func (p *Pool) Query(ctx context.Context, query string, args ...any) (Rows, error) {
	rows, err := p.reader.QueryContext(ctx, query, normalizeArgs(args)...)
	if err != nil {
		return nil, translate(err)
	}
	return sqlRows{rows}, nil
}

func (p *Pool) QueryRow(ctx context.Context, query string, args ...any) Row {
	return sqlRow{p.reader.QueryRowContext(ctx, query, normalizeArgs(args)...)}
}

func (p *Pool) Begin(ctx context.Context) (Tx, error) {
	tx, err := p.writer.BeginTx(ctx, nil)
	if err != nil {
		return nil, translate(err)
	}
	seq := 0
	return &sqlTx{tx: tx, seq: &seq}, nil
}

// BeginRead starts a read-only transaction on the reader pool. It is used to
// hold a consistent snapshot (for example a long read) without taking the
// SQLite write lock, which the writer pool's immediate transactions do.
func (p *Pool) BeginRead(ctx context.Context) (Tx, error) {
	tx, err := p.reader.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, translate(err)
	}
	seq := 0
	return &sqlTx{tx: tx, seq: &seq}, nil
}

// BeginForeignKeysOff begins a transaction on a connection with foreign-key
// enforcement disabled. The rebuild swap deletes live catalog rows and reloads
// them from staging; with enforcement on, the DELETE would cascade into
// buffer locations and envelopes the swap deliberately preserves. SQLite cannot
// drop and re-add a constraint inside a transaction (and PRAGMA foreign_keys is
// a no-op there), so the pragma is set on the dedicated connection before BEGIN
// and restored when the transaction ends.
func (p *Pool) BeginForeignKeysOff(ctx context.Context) (Tx, error) {
	conn, err := p.writer.Conn(ctx)
	if err != nil {
		return nil, translate(err)
	}
	if _, err := conn.ExecContext(ctx, "PRAGMA foreign_keys=OFF"); err != nil {
		_ = conn.Close()
		return nil, translate(err)
	}
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		_ = conn.Close()
		return nil, translate(err)
	}
	seq := 0
	return &sqlTx{tx: tx, seq: &seq, conn: conn}, nil
}

func (p *Pool) Ping(ctx context.Context) error {
	return p.writer.PingContext(ctx)
}

func (p *Pool) Close() {
	_ = p.writer.Close()
	if p.reader != p.writer {
		_ = p.reader.Close()
	}
	if p.unlock != nil {
		p.unlock()
	}
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
	return translate(w.row.Scan(adaptScanDest(dest)...))
}

// sqlRows passes iteration through and translates Scan/Err.
type sqlRows struct {
	rows *sql.Rows
}

func (w sqlRows) Next() bool             { return w.rows.Next() }
func (w sqlRows) Scan(dest ...any) error { return translate(w.rows.Scan(adaptScanDest(dest)...)) }
func (w sqlRows) Err() error             { return translate(w.rows.Err()) }
func (w sqlRows) Close()                 { _ = w.rows.Close() }

// sqlTx adapts *sql.Tx to Tx and implements nested transactions as SAVEPOINTs.
// A root transaction shares one counter with its savepoints so names stay
// unique; a savepoint commits with RELEASE and rolls back with ROLLBACK TO
// followed by RELEASE, since ROLLBACK TO does not pop the savepoint.
type sqlTx struct {
	tx   *sql.Tx
	sp   string
	seq  *int
	conn *sql.Conn // set only on the root of a foreign-keys-off transaction
}

func (t *sqlTx) Exec(ctx context.Context, query string, args ...any) (CommandTag, error) {
	res, err := t.tx.ExecContext(ctx, query, normalizeArgs(args)...)
	if err != nil {
		return nil, translate(err)
	}
	return sqlResult{res}, nil
}

func (t *sqlTx) Query(ctx context.Context, query string, args ...any) (Rows, error) {
	rows, err := t.tx.QueryContext(ctx, query, normalizeArgs(args)...)
	if err != nil {
		return nil, translate(err)
	}
	return sqlRows{rows}, nil
}

func (t *sqlTx) QueryRow(ctx context.Context, query string, args ...any) Row {
	return sqlRow{t.tx.QueryRowContext(ctx, query, normalizeArgs(args)...)}
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
	err := translate(t.tx.Commit())
	t.restoreForeignKeys(ctx)
	return err
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
	err := translate(t.tx.Rollback())
	t.restoreForeignKeys(ctx)
	return err
}

// restoreForeignKeys re-enables enforcement and returns the dedicated
// connection to the pool after a foreign-keys-off transaction ends.
func (t *sqlTx) restoreForeignKeys(ctx context.Context) {
	if t.conn == nil {
		return
	}
	_, _ = t.conn.ExecContext(ctx, "PRAGMA foreign_keys=ON")
	_ = t.conn.Close()
	t.conn = nil
}
