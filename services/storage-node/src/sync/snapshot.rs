//! Snapshot builder for Phase 9 full Relay rebuilds (§20).
//!
//! The node serializes its durable metadata (files + versions, tombstones
//! within the 90-day retention window, and per-origin sync cursors) into
//! typed, homogeneous chunks of at most [`SNAPSHOT_CHUNK_MAX_RECORDS`] records,
//! computes a BLAKE3 content hash over the whole snapshot, and signs it with
//! the node's identity key. The Relay verifies signature + hash before
//! promoting any state.

use futures_util::TryStreamExt;
use sqlx::{Acquire, Row, SqliteConnection, SqlitePool};

use super::types::{
    ActivitySnapshotRecord, FileVersionRecord, FolderKeyEnvelopeRecord, FolderRecord,
    KeyEnvelopeRecord, RebuildRequiredPayload, ShardHashRecord, SnapshotBeginPayload,
    SnapshotChunkPayload, SnapshotEndPayload, SnapshotRecord, SyncCursor, TombstoneRecord,
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
/// `sync_cursors` after promotion. Runs on the caller's connection so it sees
/// the same read snapshot as the chunk passes.
pub async fn load_cursors_conn(conn: &mut SqliteConnection) -> anyhow::Result<Vec<SyncCursor>> {
    let rows = sqlx::query(
        r#"
        SELECT peer_id, last_sequence_seen
        FROM sync_cursors
        ORDER BY peer_id ASC
        "#,
    )
    .fetch_all(&mut *conn)
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

/// Fold one chunk into the running content hash. Chunks are hashed in order as
/// `[8-byte BE record count] ++ [canonical JSON records]` — exactly what the
/// Relay recomputes over the chunks it receives, so a successful reassembly
/// makes BEGIN's `content_hash` equal END's `final_hash`.
pub fn hash_chunk(hasher: &mut blake3::Hasher, chunk: &SnapshotChunkPayload) -> anyhow::Result<()> {
    let records_json = serde_json::to_vec(&chunk.records)?;
    hasher.update(&(chunk.records.len() as u64).to_be_bytes());
    hasher.update(&records_json);
    Ok(())
}

/// BLAKE3 hash over the concatenated canonical JSON of every record in the
/// snapshot, in chunk order.
pub fn hash_snapshot_records(chunks: &[SnapshotChunkPayload]) -> anyhow::Result<String> {
    let mut hasher = blake3::Hasher::new();
    for chunk in chunks {
        hash_chunk(&mut hasher, chunk)?;
    }
    Ok(hasher.finalize().to_hex().to_string())
}

/// Returns true when the cursor map is consistent: every origin tracked in
/// `sync_cursors` appears exactly once. Used as a sanity check by callers.
pub fn cursors_in_snapshot(cursors: &[SyncCursor]) -> bool {
    let mut seen = std::collections::HashSet::new();
    cursors.iter().all(|c| seen.insert(c.origin_id.clone()))
}

/// Receives snapshot chunks in canonical order. Implemented once per pass so the
/// streaming path can hash a first pass and transmit a second pass over the same
/// DB read snapshot without materializing every chunk.
#[async_trait::async_trait]
pub trait SnapshotSink: Send {
    async fn chunk(&mut self, chunk: SnapshotChunkPayload) -> anyhow::Result<()>;
}

/// Groups records into homogeneous chunks of at most
/// [`SNAPSHOT_CHUNK_MAX_RECORDS`] and flushes them to a [`SnapshotSink`].
/// Deterministic split keeps the content hash stable for identical DB states.
struct ChunkWriter<'a> {
    snapshot_id: &'a str,
    next_index: i64,
    open: Option<(String, i64, Vec<SnapshotRecord>)>,
}

impl<'a> ChunkWriter<'a> {
    fn new(snapshot_id: &'a str) -> Self {
        Self {
            snapshot_id,
            next_index: 0,
            open: None,
        }
    }

    async fn push(
        &mut self,
        sink: &mut (dyn SnapshotSink + Send),
        record_type: &str,
        record: SnapshotRecord,
    ) -> anyhow::Result<()> {
        let start_new = match &self.open {
            Some((kind, _, records)) => {
                kind != record_type || records.len() >= SNAPSHOT_CHUNK_MAX_RECORDS
            }
            None => true,
        };
        if start_new {
            self.flush(sink).await?;
            self.open = Some((record_type.to_string(), self.next_index, Vec::new()));
            self.next_index += 1;
        }
        if let Some((_, _, records)) = &mut self.open {
            records.push(record);
        }
        Ok(())
    }

    async fn flush(&mut self, sink: &mut (dyn SnapshotSink + Send)) -> anyhow::Result<()> {
        if let Some((record_type, chunk_index, records)) = self.open.take() {
            sink.chunk(SnapshotChunkPayload {
                snapshot_id: self.snapshot_id.to_string(),
                chunk_index,
                record_type,
                records,
            })
            .await?;
        }
        Ok(())
    }
}

/// Enumerate every snapshot chunk in canonical order, handing each to `sink`.
///
/// The caller MUST run this on a stable DB snapshot when invoking it twice (the
/// streaming path wraps both passes in one read transaction); otherwise the hash
/// pass and the send pass could observe different rows and the Relay's
/// reassembly hash check would fail.
pub async fn emit_chunks(
    conn: &mut SqliteConnection,
    snapshot_id: &str,
    sink: &mut (dyn SnapshotSink + Send),
) -> anyhow::Result<()> {
    let mut writer = ChunkWriter::new(snapshot_id);

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
    .fetch(&mut *conn);
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
        writer
            .push(
                sink,
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
            )
            .await?;
    }
    drop(version_rows);

    // Folders: carried so a rebuild reconstructs the tree instead of leaving
    // files with dangling `parent_folder_id` values.
    let mut folder_rows = sqlx::query(
        r#"
        SELECT folder_id, parent_folder_id, encrypted_name, created_at
        FROM folders
        ORDER BY folder_id ASC
        "#,
    )
    .fetch(&mut *conn);
    while let Some(row) = folder_rows.try_next().await? {
        writer
            .push(
                sink,
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
            )
            .await?;
    }
    drop(folder_rows);

    // Key envelopes: opaque here; carrying them keeps a rebuild from dropping
    // them (Phase 14 F2c).
    let mut envelope_rows = sqlx::query(
        r#"
        SELECT file_id, recipient_id, recipient_kind, encrypted_key, created_at
        FROM key_envelopes
        ORDER BY file_id ASC, recipient_id ASC
        "#,
    )
    .fetch(&mut *conn);
    while let Some(row) = envelope_rows.try_next().await? {
        writer
            .push(
                sink,
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
            )
            .await?;
    }
    drop(envelope_rows);

    // Folder key envelopes: same rationale as file envelopes — a rebuild that
    // dropped these would make every folder name undecryptable.
    let mut folder_envelope_rows = sqlx::query(
        r#"
        SELECT folder_id, recipient_id, recipient_kind, encrypted_key, created_at
        FROM folder_key_envelopes
        ORDER BY folder_id ASC, recipient_id ASC
        "#,
    )
    .fetch(&mut *conn);
    while let Some(row) = folder_envelope_rows.try_next().await? {
        writer
            .push(
                sink,
                "folder_key_envelope",
                SnapshotRecord::FolderKeyEnvelope(FolderKeyEnvelopeRecord {
                    folder_id: row.get("folder_id"),
                    recipient_id: row.get("recipient_id"),
                    recipient_kind: row.get("recipient_kind"),
                    encrypted_key: row.get("encrypted_key"),
                    created_at: row
                        .try_get::<Option<String>, _>("created_at")
                        .ok()
                        .flatten(),
                }),
            )
            .await?;
    }
    drop(folder_envelope_rows);

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
    .fetch(&mut *conn);
    while let Some(row) = tombstone_rows.try_next().await? {
        writer
            .push(
                sink,
                "tombstone",
                SnapshotRecord::Tombstone(TombstoneRecord {
                    entity_type: row.get("entity_type"),
                    entity_id: row.get("entity_id"),
                    deleted_at: row.get("deleted_at"),
                }),
            )
            .await?;
    }
    drop(tombstone_rows);

    // Signed per-shard hashes (audit #22): carried so a rebuilt Relay preserves
    // the authenticated hashes alongside the versions that reference them.
    let mut shard_rows = sqlx::query(
        r#"
        SELECT file_id, version_number, shard_index, shard_hash
        FROM file_version_shard_hashes
        ORDER BY file_id ASC, version_number ASC, shard_index ASC
        "#,
    )
    .fetch(&mut *conn);
    while let Some(row) = shard_rows.try_next().await? {
        writer
            .push(
                sink,
                "shard_hash",
                SnapshotRecord::ShardHash(ShardHashRecord {
                    file_id: row.get("file_id"),
                    version_number: row.get("version_number"),
                    shard_index: row.get("shard_index"),
                    shard_hash: row.get("shard_hash"),
                }),
            )
            .await?;
    }
    drop(shard_rows);

    // Activity feed entries. The node keeps ACTIVITY_LOGGED events in
    // `sync_events`; carrying them here is what lets a Relay rebuilt from an
    // empty database keep the account's history. The payload is JSON, so the
    // fields are extracted defensively and a malformed row is skipped rather
    // than failing the whole snapshot.
    let mut activity_rows = sqlx::query(
        r#"
        SELECT origin_id, payload, timestamp
        FROM sync_events
        WHERE event_type = 'ACTIVITY_LOGGED'
        ORDER BY timestamp ASC
        "#,
    )
    .fetch(&mut *conn);
    while let Some(row) = activity_rows.try_next().await? {
        let origin_id: String = row.get("origin_id");
        let payload_str: String = row.get("payload");
        let row_timestamp: String = row.get("timestamp");
        let payload: serde_json::Value = match serde_json::from_str(&payload_str) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let str_field = |key: &str| payload.get(key).and_then(|value| value.as_str());
        let activity_id = str_field("activity_id").unwrap_or("");
        if activity_id.is_empty() {
            continue;
        }
        writer
            .push(
                sink,
                "activity",
                SnapshotRecord::Activity(ActivitySnapshotRecord {
                    activity_id: activity_id.to_string(),
                    // The origin device comes from the row, not the payload.
                    device_id: origin_id,
                    kind: str_field("kind").unwrap_or("").to_string(),
                    outcome: str_field("outcome").unwrap_or("").to_string(),
                    file_id: str_field("file_id").map(str::to_string),
                    path: str_field("path").map(str::to_string),
                    detail: str_field("detail").map(str::to_string),
                    created_at: str_field("created_at")
                        .unwrap_or(&row_timestamp)
                        .to_string(),
                }),
            )
            .await?;
    }
    drop(activity_rows);

    writer.flush(sink).await?;
    Ok(())
}

/// Collecting sink used by [`build_snapshot`] (tests and callers that want the
/// whole payload set in memory).
struct CollectSink {
    chunks: Vec<SnapshotChunkPayload>,
}

#[async_trait::async_trait]
impl SnapshotSink for CollectSink {
    async fn chunk(&mut self, chunk: SnapshotChunkPayload) -> anyhow::Result<()> {
        self.chunks.push(chunk);
        Ok(())
    }
}

/// Build a full snapshot payload set (BEGIN + ordered homogeneous chunks + END)
/// from the local SQLite database. This is deterministic for a given DB state:
/// same records in, same chunks and content hash out. It materializes every
/// chunk; the daemon's live path uses the streaming two-pass variant instead.
pub async fn build_snapshot(
    db: &SqlitePool,
    identity: &NodeIdentity,
) -> anyhow::Result<(
    SnapshotBeginPayload,
    Vec<SnapshotChunkPayload>,
    SnapshotEndPayload,
)> {
    let snapshot_id = uuid::Uuid::new_v4().to_string();
    let snapshot_sequence = bump_snapshot_counter(db).await?;

    let mut conn = db.acquire().await?;
    let mut tx = conn.begin().await?;
    let mut sink = CollectSink { chunks: Vec::new() };
    emit_chunks(&mut tx, &snapshot_id, &mut sink).await?;
    let cursors = load_cursors_conn(&mut tx).await?;
    tx.commit().await?;

    let chunks = sink.chunks;
    let total_chunks = chunks.len() as i64;
    let content_hash = hash_snapshot_records(&chunks)?;

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
pub async fn bump_snapshot_counter(db: &SqlitePool) -> anyhow::Result<i64> {
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
    async fn test_build_snapshot_includes_folder_key_envelopes() {
        let dir = tempdir().unwrap();
        let pool = db::open(dir.path()).await.unwrap();
        let identity = crate::identity::load_or_generate(dir.path()).unwrap();

        sqlx::query(
            "INSERT INTO folder_key_envelopes (folder_id, recipient_id, recipient_kind, encrypted_key, created_at) VALUES ('dir-1', 'dev-1', 'device', 'opaque', 'now')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let (_begin, chunks, _end) = build_snapshot(&pool, &identity).await.unwrap();

        let envelope_chunks: Vec<_> = chunks
            .iter()
            .filter(|c| c.record_type == "folder_key_envelope")
            .collect();
        assert_eq!(envelope_chunks.len(), 1);
        match &envelope_chunks[0].records[0] {
            SnapshotRecord::FolderKeyEnvelope(e) => {
                assert_eq!(e.folder_id, "dir-1");
                assert_eq!(e.recipient_id, "dev-1");
            }
            other => panic!("expected folder_key_envelope record, got {other:?}"),
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
    async fn test_build_snapshot_includes_shard_hashes() {
        let dir = tempdir().unwrap();
        let pool = db::open(dir.path()).await.unwrap();
        let identity = crate::identity::load_or_generate(dir.path()).unwrap();

        sqlx::query(
            "INSERT INTO file_version_shard_hashes (file_id, version_number, shard_index, shard_hash) \
             VALUES ('f1', 1, 0, 'h0')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let (_begin, chunks, _end) = build_snapshot(&pool, &identity).await.unwrap();

        let shard_chunks: Vec<_> = chunks
            .iter()
            .filter(|c| c.record_type == "shard_hash")
            .collect();
        assert_eq!(shard_chunks.len(), 1);
        match &shard_chunks[0].records[0] {
            SnapshotRecord::ShardHash(s) => {
                assert_eq!(s.file_id, "f1");
                assert_eq!(s.shard_hash, "h0");
            }
            other => panic!("expected shard_hash record, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn test_build_snapshot_includes_activities() {
        let dir = tempdir().unwrap();
        let pool = db::open(dir.path()).await.unwrap();
        let identity = crate::identity::load_or_generate(dir.path()).unwrap();

        // An ACTIVITY_LOGGED event in the journal must surface as an `activity`
        // snapshot chunk so a rebuilt Relay keeps the feed.
        let payload = serde_json::json!({
            "activity_id": "act-1",
            "kind": "upload",
            "outcome": "complete",
            "file_id": "f1",
            "path": "local",
            "detail": "2 shards",
            "created_at": "2026-09-19T10:00:00Z",
        })
        .to_string();
        sqlx::query(
            "INSERT INTO sync_events (event_id, origin_id, origin_sequence, event_type, payload, timestamp) \
             VALUES ('ev-1', 'dev-1', 1, 'ACTIVITY_LOGGED', ?, '2026-09-19T10:00:00Z')",
        )
        .bind(payload)
        .execute(&pool)
        .await
        .unwrap();

        let (_begin, chunks, _end) = build_snapshot(&pool, &identity).await.unwrap();

        let activity_chunks: Vec<_> = chunks
            .iter()
            .filter(|c| c.record_type == "activity")
            .collect();
        assert_eq!(activity_chunks.len(), 1);
        match &activity_chunks[0].records[0] {
            SnapshotRecord::Activity(a) => {
                assert_eq!(a.activity_id, "act-1");
                assert_eq!(a.device_id, "dev-1");
                assert_eq!(a.file_id.as_deref(), Some("f1"));
            }
            other => panic!("expected activity record, got {other:?}"),
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

    #[tokio::test]
    async fn two_passes_on_one_transaction_are_identical() {
        let dir = tempdir().unwrap();
        let pool = db::open(dir.path()).await.unwrap();

        // Seed across record types so both passes exercise every chunk source.
        for i in 0..3 {
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
        sqlx::query(
            "INSERT INTO folders (folder_id, created_at, updated_at) VALUES ('d1','now','now')",
        )
        .execute(&pool)
        .await
        .unwrap();

        // The streaming path runs both passes over one read transaction; verify
        // the second pass sees exactly the chunks the first hashed.
        let mut conn = pool.acquire().await.unwrap();
        let mut tx = conn.begin().await.unwrap();
        let mut first = CollectSink { chunks: Vec::new() };
        emit_chunks(&mut tx, "snap", &mut first).await.unwrap();
        let mut second = CollectSink { chunks: Vec::new() };
        emit_chunks(&mut tx, "snap", &mut second).await.unwrap();
        drop(tx);

        assert_eq!(
            serde_json::to_value(&first.chunks).unwrap(),
            serde_json::to_value(&second.chunks).unwrap(),
            "passes must emit identical chunks"
        );
        assert_eq!(
            hash_snapshot_records(&first.chunks).unwrap(),
            hash_snapshot_records(&second.chunks).unwrap()
        );
        assert!(!first.chunks.is_empty());
    }
}
