// SQLite database for the mobile client's local state.
//
// This is the native counterpart to the web client's IndexedDB store: it holds
// the durable, non-secret data (trusted nodes, the Path D transfer queue, the
// last-working-path cache, and later the cached catalogue/keys). Credentials
// stay in the OS keychain via expo-secure-store, never here.
//
// The file lives in the app's sandboxed document directory and is opened over
// expo-sqlite's async API; WAL keeps a background write from blocking reads.

import * as SQLite from "expo-sqlite";

export const DB_NAME = "nodus.db";

/**
 * Ordered schema migrations, applied by `PRAGMA user_version`. Append only —
 * never edit a published entry, since a device that already ran it will not
 * re-run the change.
 */
const MIGRATIONS: string[] = [
  `
    CREATE TABLE IF NOT EXISTS trusted_nodes (
      node_id    TEXT PRIMARY KEY,
      host       TEXT NOT NULL,
      account_id TEXT NOT NULL,
      device_id  TEXT NOT NULL,
      paired_at  TEXT NOT NULL
    );

    -- Path D queue. The data column holds the encrypted shard bytes as a BLOB
    -- rather than base64 text (shards are MiB-scale).
    CREATE TABLE IF NOT EXISTS transfer_queue (
      transfer_id    TEXT PRIMARY KEY,
      file_id        TEXT NOT NULL,
      version_number INTEGER NOT NULL,
      shard_index    INTEGER NOT NULL,
      data           BLOB NOT NULL,
      hash           TEXT NOT NULL,
      target_node    TEXT NOT NULL,
      source_device  TEXT,
      enqueued_at    INTEGER NOT NULL,
      retry_count    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_transfer_queue_enqueued ON transfer_queue(enqueued_at);

    CREATE TABLE IF NOT EXISTS path_cache (
      node_id         TEXT PRIMARY KEY,
      path            TEXT NOT NULL,
      last_success_at INTEGER NOT NULL
    );
  `,

  // Migration 2: Path C upload state — the per-file FEK, the resumable upload
  // progress record, and the per-origin sync sequence counter.
  `
    CREATE TABLE IF NOT EXISTS file_keys (
      file_id TEXT PRIMARY KEY,
      fek     BLOB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS upload_progress (
      transfer_id      TEXT PRIMARY KEY,
      file_id          TEXT NOT NULL,
      version_number   INTEGER NOT NULL,
      target_node      TEXT NOT NULL,
      total_shards     INTEGER NOT NULL,
      version_hash     TEXT NOT NULL,
      encrypted_name   TEXT NOT NULL,
      shard_size_bytes INTEGER,
      announced        INTEGER NOT NULL,
      completed_shards TEXT NOT NULL,
      shard_hashes     TEXT,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_state (
      origin_id TEXT PRIMARY KEY,
      sequence  INTEGER NOT NULL
    );
  `,

  // Migration 3: small non-secret key/value preferences (shard size, etc.).
  `
    CREATE TABLE IF NOT EXISTS preferences (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `,

  // Migration 4: the account recovery phrase (ADR-0002), revealed on demand.
  `
    CREATE TABLE IF NOT EXISTS recovery (
      account_id TEXT PRIMARY KEY,
      phrase     TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `,

  // Migration 5: the device-local activity log that backs the Activity tab.
  // The Relay has no account-wide activity endpoint, so (as on web) this is
  // per-device history of terminal outcomes.
  `
    CREATE TABLE IF NOT EXISTS transfer_log (
      id         TEXT PRIMARY KEY,
      kind       TEXT NOT NULL,
      file_id    TEXT,
      file_name  TEXT,
      detail     TEXT,
      path       TEXT,
      outcome    TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_transfer_log_created ON transfer_log(created_at);
  `,

  // Migration 6: make the activity log part of the account-wide feed. `synced`
  // flags locally-recorded terminal entries that still need uploading as
  // ACTIVITY_LOGGED events; `device_id` records the origin of entries pulled
  // from the Relay/Node so the UI can attribute them. `cleared_at` (preference)
  // hides older rows after a local Clear.
  `
    ALTER TABLE transfer_log ADD COLUMN synced INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE transfer_log ADD COLUMN device_id TEXT;
  `,
];

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

/** Open (once) and migrate the local database. */
export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (dbPromise === null) {
    dbPromise = openAndMigrate().catch((err) => {
      // A failed open/migrate must not be cached forever; the next call retries.
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

async function openAndMigrate(): Promise<SQLite.SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync(DB_NAME);
  await db.execAsync("PRAGMA journal_mode = WAL;");

  const row = await db.getFirstAsync<{ user_version: number }>("PRAGMA user_version");
  let version = row?.user_version ?? 0;

  for (let i = version; i < MIGRATIONS.length; i += 1) {
    await db.execAsync(MIGRATIONS[i]!);
    version = i + 1;
  }
  await db.execAsync(`PRAGMA user_version = ${version};`);
  return db;
}
