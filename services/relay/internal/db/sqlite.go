package db

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"embed"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/golang-migrate/migrate/v4"
	migratesqlite "github.com/golang-migrate/migrate/v4/database/sqlite"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	"modernc.org/sqlite"
)

//go:embed sqlite_migrations/*.sql
var sqliteMigrationsFS embed.FS

// The connection pool uses a custom modernc driver so a now() scalar returning
// UTC unix milliseconds is available on every connection. The schema stores
// timestamps as INTEGER millis, so this lets existing NOW() clauses keep
// working instead of threading a Go time parameter through every query. It is
// registered once under its own name, leaving the default "sqlite" driver the
// migration runner uses untouched.
var (
	sqliteDriverOnce sync.Once
	sqliteDriverName = "nodus_sqlite"
)

func sqliteDriver() string {
	sqliteDriverOnce.Do(func() {
		d := &sqlite.Driver{}
		d.MustRegisterScalarFunction("now", 0, func(_ *sqlite.FunctionContext, _ []driver.Value) (driver.Value, error) {
			return time.Now().UTC().UnixMilli(), nil
		})
		sql.Register(sqliteDriverName, d)
	})
	return sqliteDriverName
}

// SQLite pragmas are per-connection, and database/sql pools connections. They
// are therefore set in the DSN so the modernc driver applies them to every new
// connection; a one-off PRAGMA Exec would configure only the single connection
// it happened to grab. modernc reads only _pragma, _txlock, and _time_format
// from the DSN and silently ignores anything else.
const sqlitePragmas = "_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)"

// sqliteDSN builds the DSN for one pool. The writer takes _txlock=immediate so
// a write transaction takes the write lock at BEGIN: a deferred transaction
// that reads then upgrades to a write fails with SQLITE_BUSY_SNAPSHOT, which
// busy_timeout cannot recover. The reader pool omits it so reads never hold the
// write lock.
func sqliteDSN(path string, writer bool) string {
	dsn := "file:" + path + "?" + sqlitePragmas
	if writer {
		dsn += "&_txlock=immediate"
	}
	return dsn
}

// RunSQLiteMigrations applies the embedded baseline to path using a short-lived
// single connection, then closes it.
func RunSQLiteMigrations(path string) error {
	conn, err := sql.Open("sqlite", sqliteDSN(path, false))
	if err != nil {
		return fmt.Errorf("opening sqlite for migrations: %w", err)
	}
	defer conn.Close()
	conn.SetMaxOpenConns(1)

	if err := conn.Ping(); err != nil {
		return fmt.Errorf("pinging sqlite: %w", err)
	}

	source, err := iofs.New(sqliteMigrationsFS, "sqlite_migrations")
	if err != nil {
		return fmt.Errorf("creating iofs driver: %w", err)
	}
	driver, err := migratesqlite.WithInstance(conn, &migratesqlite.Config{})
	if err != nil {
		return fmt.Errorf("creating sqlite migrate driver: %w", err)
	}
	m, err := migrate.NewWithInstance("iofs", source, "sqlite", driver)
	if err != nil {
		return fmt.Errorf("creating migrate instance: %w", err)
	}
	defer m.Close()

	if err := m.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		return err
	}
	return nil
}

// AcquireDBLock takes the exclusive relay lock for dbPath. It fails when
// another process (the running relay) already holds it. This enforces the
// single-writer installation requirement and lets the factory reset refuse to
// delete the database out from under a live process.
func AcquireDBLock(dbPath string) (release func(), err error) {
	f, err := os.OpenFile(dbPath+".lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = f.Close()
		return nil, err
	}
	return func() {
		_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		_ = f.Close()
	}, nil
}

// openSQLite opens the writer/reader pool pair for path and runs the baseline
// migrations. It is wired into Open in the cutover; kept separate so the SQLite
// path is testable before the service switches over.
func openSQLite(ctx context.Context, path string) (*Pool, error) {
	// SQLite creates the file but not its directory; a fresh deploy points
	// DB_PATH at a directory the image creates, but a dev path may not exist.
	if dir := filepath.Dir(path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("creating sqlite directory: %w", err)
		}
	}
	// One relay per database file, enforced by an exclusive lock held for the
	// pool's lifetime.
	unlock, err := AcquireDBLock(path)
	if err != nil {
		return nil, fmt.Errorf("another relay instance holds %s: %w", path, err)
	}
	if err := RunSQLiteMigrations(path); err != nil {
		unlock()
		return nil, fmt.Errorf("running migrations: %w", err)
	}

	// One writer connection: SQLite allows a single writer, so capping the pool
	// makes the serialization explicit and rules out write-write deadlocks.
	writer, err := sql.Open(sqliteDriver(), sqliteDSN(path, true))
	if err != nil {
		unlock()
		return nil, fmt.Errorf("opening sqlite writer: %w", err)
	}
	writer.SetMaxOpenConns(1)
	writer.SetMaxIdleConns(1)
	writer.SetConnMaxLifetime(0)

	reader, err := sql.Open(sqliteDriver(), sqliteDSN(path, false))
	if err != nil {
		writer.Close()
		unlock()
		return nil, fmt.Errorf("opening sqlite reader: %w", err)
	}
	reader.SetMaxOpenConns(8)
	reader.SetMaxIdleConns(8)
	reader.SetConnMaxLifetime(0)

	pingCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	if err := writer.PingContext(pingCtx); err != nil {
		writer.Close()
		reader.Close()
		unlock()
		return nil, fmt.Errorf("pinging sqlite: %w", err)
	}
	if err := reader.PingContext(pingCtx); err != nil {
		writer.Close()
		reader.Close()
		unlock()
		return nil, fmt.Errorf("pinging sqlite reader: %w", err)
	}

	return &Pool{writer: writer, reader: reader, unlock: unlock}, nil
}

// translateSQLite maps modernc result codes to the driver-neutral sentinels.
// Codes are the extended SQLITE_CONSTRAINT_* / SQLITE_BUSY values.
func translateSQLite(err error) error {
	var sqliteErr *sqlite.Error
	if !errors.As(err, &sqliteErr) {
		return err
	}
	switch sqliteErr.Code() {
	case 1555, 2067: // SQLITE_CONSTRAINT_PRIMARYKEY, SQLITE_CONSTRAINT_UNIQUE
		return fmt.Errorf("%w: %s", ErrUniqueViolation, sqliteErr.Error())
	case 787: // SQLITE_CONSTRAINT_FOREIGNKEY
		return fmt.Errorf("%w: %s", ErrForeignKey, sqliteErr.Error())
	case 5, 261, 517: // SQLITE_BUSY, SQLITE_BUSY_RECOVERY, SQLITE_BUSY_SNAPSHOT
		return fmt.Errorf("%w: %s", ErrBusy, sqliteErr.Error())
	}
	return err
}
