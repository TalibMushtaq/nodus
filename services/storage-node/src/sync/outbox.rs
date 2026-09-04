use sqlx::{Row, SqlitePool};

use super::types::SyncEvent;

/// Insert a new pending event into the sync_outbox.
pub async fn insert_outbox_event(db: &SqlitePool, event: &SyncEvent) -> anyhow::Result<()> {
    let payload_str = serde_json::to_string(&event.payload)?;
    sqlx::query(
        r#"
        INSERT INTO sync_outbox (event_id, origin_id, origin_sequence, event_type, payload, created_at, synced)
        VALUES (?, ?, ?, ?, ?, ?, 0)
        ON CONFLICT(event_id) DO NOTHING
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

    Ok(())
}

/// Drain up to `limit` unsynced events from `sync_outbox`, ordered by `origin_sequence`.
pub async fn drain_unsynced_events(
    db: &SqlitePool,
    limit: i64,
) -> anyhow::Result<Vec<SyncEvent>> {
    let rows = sqlx::query(
        r#"
        SELECT event_id, origin_id, origin_sequence, event_type, payload, created_at
        FROM sync_outbox
        WHERE synced = 0
        ORDER BY origin_sequence ASC
        LIMIT ?
        "#,
    )
    .bind(limit)
    .fetch_all(db)
    .await?;

    let mut events = Vec::with_capacity(rows.len());
    for row in rows {
        let event_id: String = row.get("event_id");
        let origin_id: String = row.get("origin_id");
        let origin_sequence: i64 = row.get("origin_sequence");
        let event_type: String = row.get("event_type");
        let payload_raw: String = row.get("payload");
        let created_at: String = row.get("created_at");

        let payload: serde_json::Value = serde_json::from_str(&payload_raw)?;
        events.push(SyncEvent {
            event_id,
            origin_id,
            origin_sequence,
            event_type,
            payload,
            timestamp: created_at,
        });
    }

    Ok(events)
}

/// Mark a batch of events as acknowledged/synced by the Relay.
pub async fn mark_events_synced(
    db: &SqlitePool,
    event_ids: &[String],
) -> anyhow::Result<()> {
    if event_ids.is_empty() {
        return Ok(());
    }

    for event_id in event_ids {
        sqlx::query(
            r#"
            UPDATE sync_outbox
            SET synced = 1
            WHERE event_id = ?
            "#,
        )
        .bind(event_id)
        .execute(db)
        .await?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use tempfile::tempdir;

    #[tokio::test]
    async fn test_outbox_insert_drain_mark_synced() {
        let dir = tempdir().unwrap();
        let pool = db::open(dir.path()).await.unwrap();

        let event1 = SyncEvent {
            event_id: "evt-1".to_string(),
            origin_id: "node-1".to_string(),
            origin_sequence: 1,
            event_type: "FILE_CREATED".to_string(),
            payload: serde_json::json!({ "file_id": "f1" }),
            timestamp: chrono::Utc::now().to_rfc3339(),
        };

        let event2 = SyncEvent {
            event_id: "evt-2".to_string(),
            origin_id: "node-1".to_string(),
            origin_sequence: 2,
            event_type: "FILE_VERSION_ADDED".to_string(),
            payload: serde_json::json!({ "file_id": "f1", "version_number": 1, "shard_count": 1, "version_hash": "abc" }),
            timestamp: chrono::Utc::now().to_rfc3339(),
        };

        insert_outbox_event(&pool, &event1).await.unwrap();
        insert_outbox_event(&pool, &event2).await.unwrap();

        let pending = drain_unsynced_events(&pool, 500).await.unwrap();
        assert_eq!(pending.len(), 2);
        assert_eq!(pending[0].event_id, "evt-1");
        assert_eq!(pending[1].event_id, "evt-2");

        // Mark event1 synced
        mark_events_synced(&pool, &["evt-1".to_string()]).await.unwrap();

        let pending_after = drain_unsynced_events(&pool, 500).await.unwrap();
        assert_eq!(pending_after.len(), 1);
        assert_eq!(pending_after[0].event_id, "evt-2");
    }
}
