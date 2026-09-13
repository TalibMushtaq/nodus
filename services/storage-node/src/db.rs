//! Database initialisation for the Nodus Storage Node.
//!
//! `open` is the single entry point: it connects to (or creates) `nodus.db`
//! inside `data_dir`, applies any pending migrations, and configures the
//! per-connection SQLite PRAGMAs required for correct behaviour.

use std::path::Path;

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions};

/// How long a connection waits for a competing writer before failing with
/// SQLITE_BUSY. WAL lets readers run alongside a writer, but writers still
/// serialize; without this, a burst (e.g. concurrent pairing redemptions)
/// would fail fast instead of waiting for the lock.
const BUSY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Open (or create) the node database and run all pending migrations.
///
/// SQLite PRAGMAs applied to every connection:
/// - `PRAGMA foreign_keys = ON`  — enforces the FK constraints in the schema.
/// - `PRAGMA journal_mode = WAL` — enables Write-Ahead Logging for concurrent
///   reads during a write, which avoids busy-lock errors in later phases when
///   the reconciliation scanner and sync drain run concurrently.
/// - `PRAGMA busy_timeout = 5000` — a competing writer is waited out instead of
///   surfacing SQLITE_BUSY on the first encounter.
pub async fn open(data_dir: &Path) -> anyhow::Result<SqlitePool> {
    std::fs::create_dir_all(data_dir)?;
    let db_path = data_dir.join("nodus.db");

    let connect_opts = SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .foreign_keys(true)
        .busy_timeout(BUSY_TIMEOUT);

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(connect_opts)
        .await?;

    // Apply all migrations from the migrations/ directory at compile time.
    sqlx::migrate!("./migrations").run(&pool).await?;

    Ok(pool)
}
