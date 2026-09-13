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
pub async fn drain_unsynced_events(db: &SqlitePool, limit: i64) -> anyhow::Result<Vec<SyncEvent>> {
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
pub async fn mark_events_synced(db: &SqlitePool, event_ids: &[String]) -> anyhow::Result<()> {
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

/// Purge outbox rows the Relay has acknowledged and whose `created_at` predates
/// `grace_before` (an RFC3339 instant), keeping `sync_outbox` from growing
/// without bound (#15). `grace_before` is a timestamp so the caller controls
/// the retention window. Compared through SQLite's `datetime()` rather than as
/// raw strings: RFC3339 instants may mix `Z`/`+00:00` and fractional seconds,
/// which do not order correctly lexicographically.
pub async fn sweep_synced_outbox(db: &SqlitePool, grace_before: &str) -> anyhow::Result<u64> {
    let res = sqlx::query(
        r#"
        DELETE FROM sync_outbox
        WHERE synced = 1 AND datetime(created_at) < datetime(?)
        "#,
    )
    .bind(grace_before)
    .execute(db)
    .await?;

    Ok(res.rows_affected())
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
        mark_events_synced(&pool, &["evt-1".to_string()])
            .await
            .unwrap();

        let pending_after = drain_unsynced_events(&pool, 500).await.unwrap();
        assert_eq!(pending_after.len(), 1);
        assert_eq!(pending_after[0].event_id, "evt-2");
    }

    #[tokio::test]
    async fn test_sweep_only_removes_old_acked_events() {
        let dir = tempdir().unwrap();
        let pool = db::open(dir.path()).await.unwrap();
        let now = chrono::Utc::now();

        let old = SyncEvent {
            event_id: "evt-old-acked".to_string(),
            origin_id: "node-1".to_string(),
            origin_sequence: 1,
            event_type: "FILE_CREATED".to_string(),
            payload: serde_json::json!({ "file_id": "f1" }),
            timestamp: (now - chrono::Duration::days(2)).to_rfc3339(),
        };
        let fresh_acked = SyncEvent {
            event_id: "evt-fresh-acked".to_string(),
            origin_id: "node-1".to_string(),
            origin_sequence: 2,
            event_type: "FILE_CREATED".to_string(),
            payload: serde_json::json!({ "file_id": "f2" }),
            timestamp: now.to_rfc3339(),
        };
        let unsynced = SyncEvent {
            event_id: "evt-old-unsynced".to_string(),
            origin_id: "node-1".to_string(),
            origin_sequence: 3,
            event_type: "FILE_CREATED".to_string(),
            payload: serde_json::json!({ "file_id": "f3" }),
            timestamp: (now - chrono::Duration::days(2)).to_rfc3339(),
        };

        insert_outbox_event(&pool, &old).await.unwrap();
        insert_outbox_event(&pool, &fresh_acked).await.unwrap();
        insert_outbox_event(&pool, &unsynced).await.unwrap();

        // Ack the two events that were successfully relayed; leave #3 pending.
        mark_events_synced(
            &pool,
            &["evt-old-acked".to_string(), "evt-fresh-acked".to_string()],
        )
        .await
        .unwrap();

        let grace = (now - chrono::Duration::days(1)).to_rfc3339();
        let removed = sweep_synced_outbox(&pool, &grace).await.unwrap();

        // Only the acked row older than the grace period goes away.
        assert_eq!(removed, 1);
        let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_outbox")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(remaining, 2);
        let remaining_ids: Vec<String> =
            sqlx::query_scalar("SELECT event_id FROM sync_outbox ORDER BY origin_sequence")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(remaining_ids, vec!["evt-fresh-acked", "evt-old-unsynced"]);
    }

    #[tokio::test]
    async fn sweep_compares_timezone_normalized() {
        let dir = tempdir().unwrap();
        let pool = db::open(dir.path()).await.unwrap();

        // `19:00-05:00` is exactly `00:00Z`, i.e. NOT older than the grace
        // instant. Lexicographic comparison would see "2026-09-11..." <
        // "2026-09-12..." and wrongly delete it; `datetime()` normalizes.
        let at_grace = SyncEvent {
            event_id: "evt-at-grace".to_string(),
            origin_id: "node-1".to_string(),
            origin_sequence: 1,
            event_type: "FILE_CREATED".to_string(),
            payload: serde_json::json!({ "file_id": "f1" }),
            timestamp: "2026-09-11T19:00:00-05:00".to_string(),
        };
        let older = SyncEvent {
            event_id: "evt-older".to_string(),
            origin_id: "node-1".to_string(),
            origin_sequence: 2,
            event_type: "FILE_CREATED".to_string(),
            payload: serde_json::json!({ "file_id": "f2" }),
            timestamp: "2026-09-10T00:00:00Z".to_string(),
        };
        insert_outbox_event(&pool, &at_grace).await.unwrap();
        insert_outbox_event(&pool, &older).await.unwrap();
        mark_events_synced(
            &pool,
            &["evt-at-grace".to_string(), "evt-older".to_string()],
        )
        .await
        .unwrap();

        let removed = sweep_synced_outbox(&pool, "2026-09-12T00:00:00Z")
            .await
            .unwrap();
        assert_eq!(removed, 1, "only the genuinely older row is swept");
        let remaining: Vec<String> =
            sqlx::query_scalar("SELECT event_id FROM sync_outbox ORDER BY origin_sequence")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(remaining, vec!["evt-at-grace"]);
    }
}
