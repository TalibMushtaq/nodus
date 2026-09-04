use sqlx::SqlitePool;

use super::conflict::{detect_branch_conflict, generate_conflicted_filename};
use super::types::{BatchAckPayload, EventBatchPayload, FileVersionPayload, SyncEvent};

#[derive(Debug, PartialEq, Eq)]
pub enum ApplyOutcome {
    Applied,
    AlreadyApplied,
    Conflicted {
        conflicted_filename: String,
        sibling_version: i64,
    },
}

/// Apply a single remote sync event idempotently to SQLite database.
pub async fn apply_remote_event(
    db: &SqlitePool,
    event: &SyncEvent,
    local_node_id: &str,
) -> anyhow::Result<ApplyOutcome> {
    // 1. Idempotency check: see if (origin_id, origin_sequence) or event_id is already in sync_events
    let existing = sqlx::query(
        r#"
        SELECT 1 AS dummy
        FROM sync_events
        WHERE (origin_id = ? AND origin_sequence = ?) OR event_id = ?
        LIMIT 1
        "#,
    )
    .bind(&event.origin_id)
    .bind(event.origin_sequence)
    .bind(&event.event_id)
    .fetch_optional(db)
    .await?;

    if existing.is_some() {
        return Ok(ApplyOutcome::AlreadyApplied);
    }

    let payload_str = serde_json::to_string(&event.payload)?;

    // 2. Insert into sync_events log
    sqlx::query(
        r#"
        INSERT INTO sync_events (event_id, origin_id, origin_sequence, event_type, payload, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(origin_id, origin_sequence) DO NOTHING
        "#,
    )
    .bind(&event.event_id)
    .bind(&event.origin_id)
    .bind(event.origin_sequence)
    .bind(&event.event_type)
    .bind(&payload_str)
    .bind(&event.timestamp)
    .execute(db)
    .await?;

    let mut outcome = ApplyOutcome::Applied;

    // 3. Domain projections
    match event.event_type.as_str() {
        "FILE_CREATED" => {
            let file_id = event
                .payload
                .get("file_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let parent_folder_id = event
                .payload
                .get("parent_folder_id")
                .and_then(|v| v.as_str());
            let encrypted_name = event.payload.get("encrypted_name").and_then(|v| v.as_str());

            if !file_id.is_empty() {
                sqlx::query(
                    r#"
                    INSERT INTO files (file_id, parent_folder_id, encrypted_name, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(file_id) DO UPDATE SET
                        parent_folder_id = excluded.parent_folder_id,
                        encrypted_name = excluded.encrypted_name,
                        updated_at = excluded.updated_at
                    "#,
                )
                .bind(file_id)
                .bind(parent_folder_id)
                .bind(encrypted_name)
                .bind(&event.timestamp)
                .bind(&event.timestamp)
                .execute(db)
                .await?;
            }
        }

        "FILE_VERSION_ADDED" | "FILE_MODIFIED" => {
            if let Ok(ver) = serde_json::from_value::<FileVersionPayload>(event.payload.clone()) {
                // Ensure parent file row exists
                sqlx::query(
                    r#"
                    INSERT INTO files (file_id, created_at, updated_at)
                    VALUES (?, ?, ?)
                    ON CONFLICT(file_id) DO NOTHING
                    "#,
                )
                .bind(&ver.file_id)
                .bind(&event.timestamp)
                .bind(&event.timestamp)
                .execute(db)
                .await?;

                // Check for conflict
                let conflict_sibling = detect_branch_conflict(
                    db,
                    &ver.file_id,
                    ver.parent_version_id,
                    ver.version_number,
                )
                .await?;

                let is_flagged =
                    ver.conflict_status.as_deref() == Some("flagged") || conflict_sibling.is_some();

                sqlx::query(
                    r#"
                    INSERT INTO file_versions (file_id, version_number, parent_version_id, version_hash, shard_count, created_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(file_id, version_number) DO UPDATE SET
                        parent_version_id = excluded.parent_version_id,
                        version_hash = excluded.version_hash,
                        shard_count = excluded.shard_count
                    "#,
                )
                .bind(&ver.file_id)
                .bind(ver.version_number)
                .bind(ver.parent_version_id)
                .bind(&ver.version_hash)
                .bind(ver.shard_count)
                .bind(&event.timestamp)
                .execute(db)
                .await?;

                if is_flagged {
                    let base_name = ver
                        .encrypted_name
                        .unwrap_or_else(|| format!("{}.nodus", ver.file_id));
                    let conflicted_name = generate_conflicted_filename(
                        &base_name,
                        &event.origin_id,
                        &event.timestamp,
                    );

                    outcome = ApplyOutcome::Conflicted {
                        conflicted_filename: conflicted_name,
                        sibling_version: conflict_sibling.unwrap_or(0),
                    };
                }
            }
        }

        "FILE_DELETED" | "TOMBSTONE_CREATED" => {
            let entity_id = event
                .payload
                .get("entity_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let entity_type = event
                .payload
                .get("entity_type")
                .and_then(|v| v.as_str())
                .unwrap_or("file");

            if !entity_id.is_empty() {
                sqlx::query(
                    r#"
                    INSERT INTO tombstones (entity_type, entity_id, deleted_at)
                    VALUES (?, ?, ?)
                    ON CONFLICT(entity_type, entity_id) DO UPDATE SET deleted_at = excluded.deleted_at
                    "#,
                )
                .bind(entity_type)
                .bind(entity_id)
                .bind(&event.timestamp)
                .execute(db)
                .await?;
            }
        }

        _ => {}
    }

    // 4. Update sync_cursors for the origin peer
    sqlx::query(
        r#"
        INSERT INTO sync_cursors (peer_id, last_sequence_seen, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(peer_id) DO UPDATE SET
            last_sequence_seen = MAX(sync_cursors.last_sequence_seen, excluded.last_sequence_seen),
            updated_at = excluded.updated_at
        "#,
    )
    .bind(&event.origin_id)
    .bind(event.origin_sequence)
    .bind(&event.timestamp)
    .execute(db)
    .await?;

    let _ = local_node_id;
    Ok(outcome)
}

/// Apply a batch of incoming events from Relay and build the BATCH_ACK.
pub async fn apply_incoming_batch(
    db: &SqlitePool,
    batch: &EventBatchPayload,
    local_node_id: &str,
) -> anyhow::Result<BatchAckPayload> {
    let mut applied_ids = Vec::with_capacity(batch.events.len());

    for event in &batch.events {
        match apply_remote_event(db, event, local_node_id).await {
            Ok(_) => {
                // Both Applied and AlreadyApplied are considered successful delivery
                applied_ids.push(event.event_id.clone());
            }
            Err(e) => {
                eprintln!("failed to apply event {}: {}", event.event_id, e);
            }
        }
    }

    Ok(BatchAckPayload {
        batch_id: None,
        applied_event_ids: applied_ids,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use tempfile::tempdir;

    #[tokio::test]
    async fn test_apply_event_idempotency() {
        let dir = tempdir().unwrap();
        let pool = db::open(dir.path()).await.unwrap();

        let event = SyncEvent {
            event_id: "evt-apply-1".to_string(),
            origin_id: "relay-1".to_string(),
            origin_sequence: 10,
            event_type: "FILE_CREATED".to_string(),
            payload: serde_json::json!({
                "file_id": "file-100",
                "encrypted_name": "photo.jpg"
            }),
            timestamp: "2026-09-04T12:00:00Z".to_string(),
        };

        // First application -> Applied
        let res1 = apply_remote_event(&pool, &event, "node-test")
            .await
            .unwrap();
        assert_eq!(res1, ApplyOutcome::Applied);

        // Second application with same event -> AlreadyApplied
        let res2 = apply_remote_event(&pool, &event, "node-test")
            .await
            .unwrap();
        assert_eq!(res2, ApplyOutcome::AlreadyApplied);

        // Batch application
        let batch = EventBatchPayload {
            events: vec![event.clone()],
        };
        let ack = apply_incoming_batch(&pool, &batch, "node-test")
            .await
            .unwrap();
        assert_eq!(ack.applied_event_ids, vec!["evt-apply-1"]);
    }

    #[tokio::test]
    async fn test_apply_event_conflict_detection() {
        let dir = tempdir().unwrap();
        let pool = db::open(dir.path()).await.unwrap();

        // 1. Base version A (version 1, parent NULL)
        let evt_a = SyncEvent {
            event_id: "evt-a".to_string(),
            origin_id: "node-1".to_string(),
            origin_sequence: 1,
            event_type: "FILE_VERSION_ADDED".to_string(),
            payload: serde_json::json!({
                "file_id": "f-diverge",
                "version_number": 1,
                "parent_version_id": null,
                "shard_count": 1,
                "version_hash": "hash_a",
                "encrypted_name": "report.docx"
            }),
            timestamp: "2026-09-04T10:00:00Z".to_string(),
        };
        apply_remote_event(&pool, &evt_a, "node-1").await.unwrap();

        // 2. Offline branch version B (version 2, parent 1)
        let evt_b = SyncEvent {
            event_id: "evt-b".to_string(),
            origin_id: "node-1".to_string(),
            origin_sequence: 2,
            event_type: "FILE_VERSION_ADDED".to_string(),
            payload: serde_json::json!({
                "file_id": "f-diverge",
                "version_number": 2,
                "parent_version_id": 1,
                "shard_count": 1,
                "version_hash": "hash_b",
                "encrypted_name": "report.docx"
            }),
            timestamp: "2026-09-04T11:00:00Z".to_string(),
        };
        let res_b = apply_remote_event(&pool, &evt_b, "node-1").await.unwrap();
        assert_eq!(res_b, ApplyOutcome::Applied);

        // 3. Concurrent branch version D from Relay (version 3, also parent 1!)
        let evt_d = SyncEvent {
            event_id: "evt-d".to_string(),
            origin_id: "relay-origin".to_string(),
            origin_sequence: 1,
            event_type: "FILE_VERSION_ADDED".to_string(),
            payload: serde_json::json!({
                "file_id": "f-diverge",
                "version_number": 3,
                "parent_version_id": 1,
                "shard_count": 1,
                "version_hash": "hash_d",
                "encrypted_name": "report.docx"
            }),
            timestamp: "2026-09-04T11:30:00Z".to_string(),
        };

        let res_d = apply_remote_event(&pool, &evt_d, "node-1").await.unwrap();
        match res_d {
            ApplyOutcome::Conflicted {
                conflicted_filename,
                sibling_version,
            } => {
                assert!(conflicted_filename.contains("conflicted copy"));
                assert_eq!(sibling_version, 2);
            }
            other => panic!("expected Conflicted outcome, got {:?}", other),
        }

        // Check both versions remain durable in SQLite
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM file_versions WHERE file_id = 'f-diverge'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, 3); // Versions 1, 2, 3 all exist!
    }
}
