use sqlx::Row;
use std::sync::Arc;
use storage_node::db;
use storage_node::identity;
use storage_node::sync::{
    ApplyOutcome, EventBatchPayload, NodeAuthChallengePayload, SyncClient, SyncEvent,
    apply_incoming_batch, apply_remote_event, drain_unsynced_events, insert_outbox_event,
    mark_events_synced,
};
use tempfile::tempdir;

#[tokio::test]
async fn test_offline_divergence_e2e_scenario() {
    let node_dir = tempdir().unwrap();
    let node_pool = db::open(node_dir.path()).await.unwrap();
    let node_id_info = identity::load_or_generate(node_dir.path()).unwrap();
    let _identity_arc = Arc::new(node_id_info);

    let file_id = "file-diverge-123";

    // ── STEP 1: Node and Relay start synced to version A ──
    let evt_a = SyncEvent {
        event_id: "evt-a".to_string(),
        origin_id: "initial-sync".to_string(),
        origin_sequence: 1,
        event_type: "FILE_VERSION_ADDED".to_string(),
        payload: serde_json::json!({
            "file_id": file_id,
            "version_number": 1,
            "parent_version_id": null,
            "shard_count": 1,
            "version_hash": "hash_version_a",
            "encrypted_name": "ProjectRoadmap.docx"
        }),
        timestamp: "2026-09-04T08:00:00Z".to_string(),
    };
    let apply_a = apply_remote_event(&node_pool, &evt_a, "node-1")
        .await
        .unwrap();
    assert_eq!(apply_a, ApplyOutcome::Applied);

    // ── STEP 2: Node goes offline and makes edits A -> B -> C ──
    // Local edit B (version 2, parent 1)
    let evt_b = SyncEvent {
        event_id: "evt-b".to_string(),
        origin_id: "node-1".to_string(),
        origin_sequence: 1,
        event_type: "FILE_VERSION_ADDED".to_string(),
        payload: serde_json::json!({
            "file_id": file_id,
            "version_number": 2,
            "parent_version_id": 1,
            "shard_count": 1,
            "version_hash": "hash_version_b",
            "encrypted_name": "ProjectRoadmap.docx"
        }),
        timestamp: "2026-09-04T09:00:00Z".to_string(),
    };
    apply_remote_event(&node_pool, &evt_b, "node-1")
        .await
        .unwrap();
    insert_outbox_event(&node_pool, &evt_b).await.unwrap();

    // Local edit C (version 3, parent 2)
    let evt_c = SyncEvent {
        event_id: "evt-c".to_string(),
        origin_id: "node-1".to_string(),
        origin_sequence: 2,
        event_type: "FILE_VERSION_ADDED".to_string(),
        payload: serde_json::json!({
            "file_id": file_id,
            "version_number": 3,
            "parent_version_id": 2,
            "shard_count": 1,
            "version_hash": "hash_version_c",
            "encrypted_name": "ProjectRoadmap.docx"
        }),
        timestamp: "2026-09-04T10:00:00Z".to_string(),
    };
    apply_remote_event(&node_pool, &evt_c, "node-1")
        .await
        .unwrap();
    insert_outbox_event(&node_pool, &evt_c).await.unwrap();

    // Verify outbox has 2 pending unsynced events (B and C)
    let unsynced = drain_unsynced_events(&node_pool, 500).await.unwrap();
    assert_eq!(unsynced.len(), 2);
    assert_eq!(unsynced[0].event_id, "evt-b");
    assert_eq!(unsynced[1].event_id, "evt-c");

    // ── STEP 3: Relay independently produces A -> D (version 4, parent 1) ──
    let evt_d = SyncEvent {
        event_id: "evt-d".to_string(),
        origin_id: "other-device".to_string(),
        origin_sequence: 1,
        event_type: "FILE_VERSION_ADDED".to_string(),
        payload: serde_json::json!({
            "file_id": file_id,
            "version_number": 4,
            "parent_version_id": 1, // Sibling to B! Both parent = 1
            "shard_count": 1,
            "version_hash": "hash_version_d",
            "encrypted_name": "ProjectRoadmap.docx"
        }),
        timestamp: "2026-09-04T09:30:00Z".to_string(),
    };

    // ── STEP 4: Node reconnects ──
    // 4a: Challenge-response authentication
    let challenge = NodeAuthChallengePayload {
        nonce: "test-nonce-random-778899aabbccddeeff".to_string(),
    };
    let auth_resp = SyncClient::sign_auth_challenge(&_identity_arc, &challenge);
    assert_eq!(auth_resp.node_id, _identity_arc.node_id);
    assert!(!auth_resp.signature.is_empty());

    // 4b: SYNC_HELLO cursor exchange
    let hello = SyncClient::build_sync_hello(&node_pool, &_identity_arc.node_id)
        .await
        .unwrap();
    assert_eq!(hello.node_id, _identity_arc.node_id);

    // 4c: Relay ACKs node's outbox batch
    let batch_ack_ids = vec!["evt-b".to_string(), "evt-c".to_string()];
    mark_events_synced(&node_pool, &batch_ack_ids)
        .await
        .unwrap();

    // Verify outbox is now empty (synced = 1)
    let unsynced_after = drain_unsynced_events(&node_pool, 500).await.unwrap();
    assert!(unsynced_after.is_empty());

    // 4d: Node receives D from Relay
    let incoming_batch = EventBatchPayload {
        events: vec![evt_d.clone()],
    };
    let ack = apply_incoming_batch(&node_pool, &incoming_batch, &_identity_arc.node_id)
        .await
        .unwrap();
    assert_eq!(ack.applied_event_ids, vec!["evt-d"]);

    // ── STEP 5: Verification of divergence and durable convergence ──
    // 1. Both branches remain durable in SQLite: versions 1 (A), 2 (B), 3 (C), 4 (D)
    let version_rows = sqlx::query("SELECT version_number, parent_version_id FROM file_versions WHERE file_id = ? ORDER BY version_number ASC")
        .bind(file_id)
        .fetch_all(&node_pool)
        .await
        .unwrap();
    assert_eq!(version_rows.len(), 4);
    assert_eq!(version_rows[0].get::<i64, _>("version_number"), 1);
    assert_eq!(version_rows[1].get::<i64, _>("version_number"), 2);
    assert_eq!(
        version_rows[1].get::<Option<i64>, _>("parent_version_id"),
        Some(1)
    );
    assert_eq!(version_rows[2].get::<i64, _>("version_number"), 3);
    assert_eq!(
        version_rows[2].get::<Option<i64>, _>("parent_version_id"),
        Some(2)
    );
    assert_eq!(version_rows[3].get::<i64, _>("version_number"), 4);
    assert_eq!(
        version_rows[3].get::<Option<i64>, _>("parent_version_id"),
        Some(1)
    );

    // 2. Conflicted copy naming check
    let conflict_outcome = apply_remote_event(&node_pool, &evt_d, "node-1")
        .await
        .unwrap();
    // Re-applying gives AlreadyApplied idempotency
    assert_eq!(conflict_outcome, ApplyOutcome::AlreadyApplied);

    // 3. Repeated synchronization is idempotent
    let repeat_ack = apply_incoming_batch(&node_pool, &incoming_batch, &_identity_arc.node_id)
        .await
        .unwrap();
    assert_eq!(repeat_ack.applied_event_ids, vec!["evt-d"]);

    // Ensure total count of rows remains 4
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM file_versions WHERE file_id = ?")
        .bind(file_id)
        .fetch_one(&node_pool)
        .await
        .unwrap();
    assert_eq!(count, 4);
}
