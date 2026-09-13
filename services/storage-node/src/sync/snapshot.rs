//! Snapshot builder for Phase 9 full Relay rebuilds (§20).
//!
//! The node serializes its durable metadata (files + versions, tombstones
//! within the 90-day retention window, and per-origin sync cursors) into
//! typed, homogeneous chunks of at most [`SNAPSHOT_CHUNK_MAX_RECORDS`] records,
//! computes a BLAKE3 content hash over the whole snapshot, and signs it with
//! the node's identity key. The Relay verifies signature + hash before
//! promoting any state.

use futures_util::TryStreamExt;
use sqlx::{Row, SqlitePool};

use super::types::{
    FileVersionRecord, FolderRecord, KeyEnvelopeRecord, RebuildRequiredPayload,
    SnapshotBeginPayload, SnapshotChunkPayload, SnapshotEndPayload, SnapshotRecord, SyncCursor,
    TombstoneRecord,
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

/// Append `record` to the last chunk when it is the same record type and still
/// under the per-chunk cap, otherwise start a new chunk. Shared by every type
/// so the deterministic split (and therefore the content hash) is identical to
/// the previous builder.
fn push_snapshot_record(
    chunks: &mut Vec<SnapshotChunkPayload>,
    chunk_index: &mut i64,
    record_type: &str,
    record: SnapshotRecord,
) {
    if let Some(last) = chunks.last_mut()
        && last.record_type == record_type
        && last.records.len() < SNAPSHOT_CHUNK_MAX_RECORDS
    {
        last.records.push(record);
        return;
    }
    chunks.push(SnapshotChunkPayload {
        snapshot_id: String::new(),
        chunk_index: *chunk_index,
        record_type: record_type.to_string(),
        records: vec![record],
    });
    *chunk_index += 1;
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
    // Homogeneous chunking built directly from the row streams: records are not
    // first collected into per-type `Vec`s, so peak memory is the chunks we
    // return rather than records + chunks. The order, 1000-record cap, and skip
    // rules match the previous builder exactly, so the content hash (and the
    // Relay's reassembly check) is unchanged.
    let mut chunks = Vec::<SnapshotChunkPayload>::new();
    let mut chunk_index: i64 = 0;

    // file_versions, joined with the file catalog for name/folder metadata.
    let mut version_rows = sqlx::query(
        r#"
        SELECT
            fv.file_id,
            fv.version_number,
            fv.parent_version_id,
            fv.conflict_status,
            fv.version_hash,
            fv.shard_count,
            f.created_at,
            f.encrypted_name,
            f.parent_folder_id,
            fv.conflicted_name
        FROM file_versions fv
        JOIN files f ON f.file_id = fv.file_id
        ORDER BY fv.file_id ASC, fv.version_number ASC
        "#,
    )
    .fetch(db);
    while let Some(row) = version_rows.try_next().await? {
        let version_hash: String = row.get("version_hash");
        let shard_count: i64 = row.get("shard_count");
        if version_hash.is_empty() || shard_count <= 0 {
            // A malformed row would be silently absent from a rebuild; surface
            // it so the operator can investigate rather than losing a version.
            eprintln!(
                "[snapshot] omitting file_version {}:{} from snapshot: version_hash={:?} shard_count={}",
                row.get::<String, _>("file_id"),
                row.get::<i64, _>("version_number"),
                version_hash,
                shard_count
            );
            continue;
        }
        push_snapshot_record(
            &mut chunks,
            &mut chunk_index,
            "file_version",
            SnapshotRecord::FileVersion(FileVersionRecord {
                file_id: row.get("file_id"),
                version_number: row.get("version_number"),
                parent_version_id: row.get("parent_version_id"),
                conflict_status: row
                    .try_get::<Option<String>, _>("conflict_status")
                    .ok()
                    .flatten(),
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
                conflicted_name: row
                    .try_get::<Option<String>, _>("conflicted_name")
                    .ok()
                    .flatten(),
            }),
        );
    }

    // Folders: carried so a rebuild reconstructs the tree instead of leaving
    // files with dangling `parent_folder_id` values.
    let mut folder_rows = sqlx::query(
        r#"
        SELECT folder_id, parent_folder_id, encrypted_name, created_at
        FROM folders
        ORDER BY folder_id ASC
        "#,
    )
    .fetch(db);
    while let Some(row) = folder_rows.try_next().await? {
        push_snapshot_record(
            &mut chunks,
            &mut chunk_index,
            "folder",
            SnapshotRecord::Folder(FolderRecord {
                folder_id: row.get("folder_id"),
                parent_folder_id: row
                    .try_get::<Option<String>, _>("parent_folder_id")
                    .ok()
                    .flatten(),
                encrypted_name: row
                    .try_get::<Option<String>, _>("encrypted_name")
                    .ok()
                    .flatten(),
                created_at: row
                    .try_get::<Option<String>, _>("created_at")
                    .ok()
                    .flatten(),
            }),
        );
    }

    // Key envelopes: opaque here; carrying them keeps a rebuild from dropping
    // them (Phase 14 F2c).
    let mut envelope_rows = sqlx::query(
        r#"
        SELECT file_id, recipient_id, recipient_kind, encrypted_key, created_at
        FROM key_envelopes
        ORDER BY file_id ASC, recipient_id ASC
        "#,
    )
    .fetch(db);
    while let Some(row) = envelope_rows.try_next().await? {
        push_snapshot_record(
            &mut chunks,
            &mut chunk_index,
            "key_envelope",
            SnapshotRecord::KeyEnvelope(KeyEnvelopeRecord {
                file_id: row.get("file_id"),
                recipient_id: row.get("recipient_id"),
                recipient_kind: row.get("recipient_kind"),
                encrypted_key: row.get("encrypted_key"),
                created_at: row
                    .try_get::<Option<String>, _>("created_at")
                    .ok()
                    .flatten(),
            }),
        );
    }

    // Tombstones within the retention window (older ones are already prunable).
    let cutoff = chrono::Utc::now() - chrono::Duration::days(TOMBSTONE_RETENTION_DAYS);
    let cutoff_str = cutoff.to_rfc3339();
    let mut tombstone_rows = sqlx::query(
        r#"
        SELECT entity_type, entity_id, deleted_at
        FROM tombstones
        WHERE deleted_at >= ?
        ORDER BY entity_type ASC, entity_id ASC
        "#,
    )
    .bind(&cutoff_str)
    .fetch(db);
    while let Some(row) = tombstone_rows.try_next().await? {
        push_snapshot_record(
            &mut chunks,
            &mut chunk_index,
            "tombstone",
            SnapshotRecord::Tombstone(TombstoneRecord {
                entity_type: row.get("entity_type"),
                entity_id: row.get("entity_id"),
                deleted_at: row.get("deleted_at"),
            }),
        );
    }

    let cursors = load_cursors(db).await?;

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
    // A single upsert with `RETURNING` is atomic: a separate follow-up SELECT
    // would let two concurrent callers read the same value (the old comment
    // claimed an atomicity the two-statement version did not have).
    let current: i64 = sqlx::query_scalar(
        r#"
        INSERT INTO snapshot_counter (counter_name, value)
        VALUES ('snapshot_sequence', 1)
        ON CONFLICT(counter_name) DO UPDATE SET value = snapshot_counter.value + 1
        RETURNING value
        "#,
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
    async fn test_build_snapshot_includes_folders() {
        let dir = tempdir().unwrap();
        let pool = db::open(dir.path()).await.unwrap();
        let identity = crate::identity::load_or_generate(dir.path()).unwrap();

        sqlx::query(
            "INSERT INTO folders (folder_id, parent_folder_id, encrypted_name, created_at, updated_at) VALUES ('dir-1', NULL, 'enc', 'now', 'now')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let (_begin, chunks, _end) = build_snapshot(&pool, &identity).await.unwrap();

        let folder_chunks: Vec<_> = chunks
            .iter()
            .filter(|c| c.record_type == "folder")
            .collect();
        assert_eq!(folder_chunks.len(), 1);
        assert_eq!(folder_chunks[0].records.len(), 1);
        match &folder_chunks[0].records[0] {
            SnapshotRecord::Folder(f) => assert_eq!(f.folder_id, "dir-1"),
            other => panic!("expected folder record, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn test_build_snapshot_includes_key_envelopes() {
        let dir = tempdir().unwrap();
        let pool = db::open(dir.path()).await.unwrap();
        let identity = crate::identity::load_or_generate(dir.path()).unwrap();

        sqlx::query(
            "INSERT INTO key_envelopes (file_id, recipient_id, recipient_kind, encrypted_key, created_at) VALUES ('f1', 'dev-1', 'device', 'opaque', 'now')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let (_begin, chunks, _end) = build_snapshot(&pool, &identity).await.unwrap();

        let envelope_chunks: Vec<_> = chunks
            .iter()
            .filter(|c| c.record_type == "key_envelope")
            .collect();
        assert_eq!(envelope_chunks.len(), 1);
        match &envelope_chunks[0].records[0] {
            SnapshotRecord::KeyEnvelope(e) => {
                assert_eq!(e.recipient_id, "dev-1");
                assert_eq!(e.recipient_kind, "device");
            }
            other => panic!("expected key_envelope record, got {other:?}"),
        }
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
