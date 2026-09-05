//! Snapshot builder for Phase 9 full Relay rebuilds (§20).
//!
//! The node serializes its durable metadata (files + versions, tombstones
//! within the 90-day retention window, and per-origin sync cursors) into
//! typed, homogeneous chunks of at most [`SNAPSHOT_CHUNK_MAX_RECORDS`] records,
//! computes a BLAKE3 content hash over the whole snapshot, and signs it with
//! the node's identity key. The Relay verifies signature + hash before
//! promoting any state.

use sqlx::{Row, SqlitePool};

use super::types::{
    FileVersionRecord, RebuildRequiredPayload, SnapshotBeginPayload, SnapshotChunkPayload,
    SnapshotEndPayload, SnapshotRecord, SyncCursor, TombstoneRecord,
};
use crate::identity::NodeIdentity;

/// Maximum records per homogeneous snapshot chunk (protocol constant).
pub const SNAPSHOT_CHUNK_MAX_RECORDS: usize = 1000;

/// Tombstone retention window (90 days, ADR-0005). Tombstones older than this
/// are omitted from a fresh snapshot since they're already prunable.
pub const TOMBSTONE_RETENTION_DAYS: i64 = 90;

/// The data schema version this node emits in snapshots.
pub const SNAPSHOT_DATA_SCHEMA_VERSION: &str = "1.0";

/// Determines whether `payload` is a REBUILD_REQUIRED request directed at this
/// node (node_id must match after the Relay authenticates us).
pub fn is_rebuild_required_for(
    payload: &serde_json::Value,
    node_id: &str,
) -> Option<RebuildRequiredPayload> {
    let req: RebuildRequiredPayload = serde_json::from_value(payload.clone()).ok()?;
    if req.node_id == node_id {
        Some(req)
    } else {
        None
    }
}

/// Loads every file_version row (joined with the file catalog for encrypted
/// name/folder metadata) from SQLite, ordered deterministically for a stable
/// content hash.
async fn load_file_version_records(db: &SqlitePool) -> anyhow::Result<Vec<FileVersionRecord>> {
    let rows = sqlx::query(
        r#"
        SELECT
            fv.file_id,
            fv.version_number,
            fv.parent_version_id,
            fv.version_hash,
            fv.shard_count,
            f.created_at,
            f.encrypted_name,
            f.parent_folder_id
        FROM file_versions fv
        JOIN files f ON f.file_id = fv.file_id
        ORDER BY fv.file_id ASC, fv.version_number ASC
        "#,
    )
    .fetch_all(db)
    .await?;

    let mut records = Vec::with_capacity(rows.len());
    for row in rows {
        let parent_version_id: Option<i64> = row.get("parent_version_id");
        let version_hash: String = row.get("version_hash");
        let shard_count: i64 = row.get("shard_count");
        if version_hash.is_empty() || shard_count <= 0 {
            continue;
        }
        records.push(FileVersionRecord {
            file_id: row.get("file_id"),
            version_number: row.get("version_number"),
            parent_version_id,
            conflict_status: None,
            version_hash,
            shard_count,
            encrypted_name: row
                .try_get::<Option<String>, _>("encrypted_name")
                .ok()
                .flatten(),
            parent_folder_id: row
                .try_get::<Option<String>, _>("parent_folder_id")
                .ok()
                .flatten(),
        });
    }

    Ok(records)
}

/// Loads tombstones newer than the retention window from SQLite.
async fn load_tombstone_records(db: &SqlitePool) -> anyhow::Result<Vec<TombstoneRecord>> {
    let cutoff = chrono::Utc::now() - chrono::Duration::days(TOMBSTONE_RETENTION_DAYS);
    let cutoff_str = cutoff.to_rfc3339();

    let rows = sqlx::query(
        r#"
        SELECT entity_type, entity_id, deleted_at
        FROM tombstones
        WHERE deleted_at >= ?
        ORDER BY entity_type ASC, entity_id ASC
        "#,
    )
    .bind(&cutoff_str)
    .fetch_all(db)
    .await?;

    let mut records = Vec::with_capacity(rows.len());
    for row in rows {
        records.push(TombstoneRecord {
            entity_type: row.get("entity_type"),
            entity_id: row.get("entity_id"),
            deleted_at: row.get("deleted_at"),
        });
    }

    Ok(records)
}

/// Loads the per-origin sync cursor map so the Relay can repopulate
/// `sync_cursors` after promotion.
async fn load_cursors(db: &SqlitePool) -> anyhow::Result<Vec<SyncCursor>> {
    let rows = sqlx::query(
        r#"
        SELECT peer_id, last_sequence_seen
        FROM sync_cursors
        ORDER BY peer_id ASC
        "#,
    )
    .fetch_all(db)
    .await?;

    let cursors = rows
        .into_iter()
        .map(|r| SyncCursor {
            origin_id: r.get("peer_id"),
            sequence: r.get("last_sequence_seen"),
        })
        .collect();

    Ok(cursors)
}

/// Loads the current max sync sequence across all origins, used as a stable
/// checkpoint marker for the snapshot. Not authoritative for resuming sync
/// (that's the per-origin cursor map), but useful for logging/debugging.
pub async fn load_total_events_sequence(db: &SqlitePool) -> anyhow::Result<i64> {
    let total: Option<i64> = sqlx::query_scalar("SELECT MAX(last_sequence_seen) FROM sync_cursors")
        .fetch_one(db)
        .await?;
    Ok(total.unwrap_or(0))
}

/// BLAKE3 hash over the concatenated canonical JSON of every record in the
/// snapshot, in chunk order. Mirrors what the Relay recomputes during
/// reassembly, so BEGIN's content_hash == END's final_hash when all chunks
/// arrive intact.
pub fn hash_snapshot_records(chunks: &[SnapshotChunkPayload]) -> anyhow::Result<String> {
    let mut hasher = blake3::Hasher::new();

    // Hash chunks in order; each chunk's records are canonicalized by serde.
    for chunk in chunks {
        let records_json = serde_json::to_vec(&chunk.records)?;
        hasher.update(&(chunk.records.len() as u64).to_be_bytes());
        hasher.update(&records_json);
    }

    Ok(hasher.finalize().to_hex().to_string())
}

/// Returns true when the cursor map is consistent: every origin tracked in
/// `sync_cursors` appears exactly once. Used as a sanity check by callers.
pub fn cursors_in_snapshot(cursors: &[SyncCursor]) -> bool {
    let mut seen = std::collections::HashSet::new();
    cursors.iter().all(|c| seen.insert(c.origin_id.clone()))
}

/// Build a full snapshot payload set (BEGIN + ordered homogeneous chunks + END)
/// from the local SQLite database. This is deterministic for a given DB state:
/// same records in, same chunks and content hash out.
pub async fn build_snapshot(
    db: &SqlitePool,
    identity: &NodeIdentity,
) -> anyhow::Result<(
    SnapshotBeginPayload,
    Vec<SnapshotChunkPayload>,
    SnapshotEndPayload,
)> {
    let file_records = load_file_version_records(db).await?;
    let tombstone_records = load_tombstone_records(db).await?;
    let cursors = load_cursors(db).await?;

    // Homogeneous chunking: file_versions first, then tombstones, each chunk
    // capped at SNAPSHOT_CHUNK_MAX_RECORDS. Deterministic split keeps the
    // content hash stable for identical DB states.
    let mut chunks = Vec::<SnapshotChunkPayload>::new();
    let mut chunk_index: i64 = 0;

    for record in file_records.into_iter().map(SnapshotRecord::FileVersion) {
        if let Some(last) = chunks.last_mut()
            && last.record_type == "file_version"
            && last.records.len() < SNAPSHOT_CHUNK_MAX_RECORDS
        {
            last.records.push(record);
            continue;
        }
        chunks.push(SnapshotChunkPayload {
            snapshot_id: String::new(),
            chunk_index,
            record_type: "file_version".to_string(),
            records: vec![record],
        });
        chunk_index += 1;
    }

    for record in tombstone_records.into_iter().map(SnapshotRecord::Tombstone) {
        if let Some(last) = chunks.last_mut()
            && last.record_type == "tombstone"
            && last.records.len() < SNAPSHOT_CHUNK_MAX_RECORDS
        {
            last.records.push(record);
            continue;
        }
        chunks.push(SnapshotChunkPayload {
            snapshot_id: String::new(),
            chunk_index,
            record_type: "tombstone".to_string(),
            records: vec![record],
        });
        chunk_index += 1;
    }

    let total_chunks = chunks.len() as i64;

    // Content hash computed over the full chunk set.
    let content_hash = hash_snapshot_records(&chunks)?;
    let snapshot_id = uuid::Uuid::new_v4().to_string();

    for chunk in &mut chunks {
        chunk.snapshot_id = snapshot_id.clone();
    }

    // Monotonic per-node snapshot counter (snapshot #1, #2, ...). Read from a
    // dedicated SQLite counter table so restarts don't reuse a sequence number.
    let snapshot_sequence = bump_snapshot_counter(db).await?;

    let signature = identity.sign(content_hash.as_bytes());
    let signature_hex = hex::encode(signature.to_bytes());

    let begin = SnapshotBeginPayload {
        snapshot_id: snapshot_id.clone(),
        node_id: identity.node_id.clone(),
        snapshot_sequence,
        total_chunks,
        content_hash: content_hash.clone(),
        signature: signature_hex.clone(),
        data_schema_version: SNAPSHOT_DATA_SCHEMA_VERSION.to_string(),
        cursors,
    };

    let end = SnapshotEndPayload {
        snapshot_id,
        final_hash: content_hash,
        signature: signature_hex,
    };

    Ok((begin, chunks, end))
}

/// Next monotonic per-node snapshot sequence number. Persisted in SQLite so
/// concurrent snapshot attempts on the same node can't double-assign a number.
async fn bump_snapshot_counter(db: &SqlitePool) -> anyhow::Result<i64> {
    sqlx::query(
        r#"
        INSERT INTO snapshot_counter (counter_name, value)
        VALUES ('snapshot_sequence', 1)
        ON CONFLICT(counter_name) DO UPDATE SET value = snapshot_counter.value + 1
        "#,
    )
    .execute(db)
    .await?;

    let current: i64 = sqlx::query_scalar(
        "SELECT value FROM snapshot_counter WHERE counter_name = 'snapshot_sequence'",
    )
    .fetch_one(db)
    .await?;
    Ok(current)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use tempfile::tempdir;

    #[tokio::test]
    async fn test_build_snapshot_round_trip() {
        let dir = tempdir().unwrap();
        let pool = db::open(dir.path()).await.unwrap();
        let identity = crate::identity::load_or_generate(dir.path()).unwrap();

        // Seed a file, a version, a tombstone, and a cursor.
        sqlx::query(
            "INSERT INTO files (file_id, created_at, updated_at) VALUES ('f1', 'now', 'now')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO file_versions (file_id, version_number, version_hash, shard_count, created_at) VALUES ('f1', 1, 'hash1', 2, 'now')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO tombstones (entity_type, entity_id, deleted_at) VALUES ('file', 'f-del', '2026-09-01T00:00:00Z')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO sync_cursors (peer_id, last_sequence_seen, updated_at) VALUES ('origin-1', 42, 'now')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let (begin, chunks, end) = build_snapshot(&pool, &identity).await.unwrap();

        assert_eq!(begin.node_id, identity.node_id);
        assert_eq!(begin.total_chunks as usize, chunks.len());
        assert_eq!(begin.cursors.len(), 1);
        assert_eq!(begin.cursors[0].origin_id, "origin-1");
        assert_eq!(begin.cursors[0].sequence, 42);
        assert_eq!(end.final_hash, begin.content_hash);
        assert_eq!(begin.snapshot_sequence, 1);
        assert_eq!(chunks.iter().map(|c| c.records.len()).sum::<usize>(), 2);
    }

    #[tokio::test]
    async fn test_snapshot_counter_monotonic() {
        let dir = tempdir().unwrap();
        let pool = db::open(dir.path()).await.unwrap();

        let s1 = bump_snapshot_counter(&pool).await.unwrap();
        let s2 = bump_snapshot_counter(&pool).await.unwrap();
        assert_eq!(s1, 1);
        assert_eq!(s2, 2);
    }

    #[tokio::test]
    async fn test_snapshot_chunking_at_1000() {
        let dir = tempdir().unwrap();
        let pool = db::open(dir.path()).await.unwrap();
        let identity = crate::identity::load_or_generate(dir.path()).unwrap();

        // Insert 2500 versions spread across 2500 files to force multi-chunk.
        for i in 0..2500 {
            let fid = format!("f-{i}");
            sqlx::query(
                "INSERT INTO files (file_id, created_at, updated_at) VALUES (?, 'now', 'now')",
            )
            .bind(&fid)
            .execute(&pool)
            .await
            .unwrap();
            sqlx::query(
                "INSERT INTO file_versions (file_id, version_number, version_hash, shard_count, created_at) VALUES (?, 1, 'h', 1, 'now')",
            )
            .bind(&fid)
            .execute(&pool)
            .await
            .unwrap();
        }

        let (begin, chunks, _) = build_snapshot(&pool, &identity).await.unwrap();

        let total: usize = chunks.iter().map(|c| c.records.len()).sum();
        assert_eq!(total, 2500);
        assert_eq!(begin.total_chunks, 3);
        assert!(
            chunks
                .iter()
                .all(|c| c.records.len() <= SNAPSHOT_CHUNK_MAX_RECORDS)
        );
        assert!(chunks.iter().all(|c| c.record_type == "file_version"));
    }
}
