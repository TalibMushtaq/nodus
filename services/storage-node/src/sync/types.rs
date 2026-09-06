use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProtocolEnvelope {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub schema_version: String,
    pub message_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
    pub payload: serde_json::Value,
}

impl ProtocolEnvelope {
    pub fn new(msg_type: &str, payload: serde_json::Value) -> Self {
        Self {
            msg_type: msg_type.to_string(),
            schema_version: "1.0.0".to_string(),
            message_id: uuid::Uuid::new_v4().to_string(),
            timestamp: Some(chrono::Utc::now().to_rfc3339()),
            payload,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeAuthChallengePayload {
    pub nonce: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeAuthResponsePayload {
    pub node_id: String,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeAuthResultPayload {
    pub status: String, // "ok" | "fail"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Phase 11: Relay → Node delivery of a freshly issued pairing token. The
/// node stores it in `pairing_sessions` so the device's `/nodus/pair` call
/// can redeem it locally without a round trip to the Relay.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairingTokenPushPayload {
    pub node_id: String,
    pub token: String,
    /// Raw Ed25519 public key the token is bound to, **base64-encoded**.
    pub device_public_key: String,
    /// RFC3339 instant after which the token is invalid.
    pub expires_at: String,
}

/// Node → Relay: identity registration. The Relay keys pending-buffer delivery
/// on node_id, so the node must register before it can receive pending_notify.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    pub node_id: String,
    pub public_key: String,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncCursor {
    pub origin_id: String,
    pub sequence: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncCursorWithCount {
    pub origin_id: String,
    pub sequence: i64,
    pub known_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncHelloPayload {
    pub node_id: String,
    pub cursors: Vec<SyncCursor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncStatusPayload {
    pub node_id: String,
    pub cursors: Vec<SyncCursorWithCount>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncEvent {
    pub event_id: String,
    pub origin_id: String,
    pub origin_sequence: i64,
    #[serde(rename = "type")]
    pub event_type: String,
    pub payload: serde_json::Value,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventBatchPayload {
    pub events: Vec<SyncEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchAckPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub batch_id: Option<String>,
    pub applied_event_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileVersionPayload {
    pub file_id: String,
    pub version_number: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_version_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflict_status: Option<String>,
    pub shard_count: i64,
    pub version_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encrypted_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_folder_id: Option<String>,
}

// ── Phase 10: Buffer-and-Relay (Path C) wire types ───────────────

/// Relay → Node: a buffered shard is waiting for pickup.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingNotifyPayload {
    pub file_id: String,
    pub version_number: i64,
    pub shard_index: i64,
    pub buffer_id: String,
    pub fetch_token: String,
    pub from_device: String,
    pub hash: String,
    pub size: i64,
}

/// Node → Relay: acknowledgement of shard receipt/verification.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShardAckPayload {
    pub file_id: String,
    pub version_number: i64,
    pub shard_index: i64,
    pub status: String, // "received" | "verified" | "failed"
    pub transfer_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}

/// Node → Relay: request to fetch a shard from the Relay buffer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShardFetchPayload {
    pub file_id: String,
    pub version_number: i64,
    pub shard_index: i64,
    pub transfer_id: String,
    pub source: String, // "relay_buffer"
}

// ── Phase 9: Snapshot / Rebuild wire types ─────────────────────────

/// Relay → Node request to initiate a full snapshot / rebuild (§20).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RebuildRequiredPayload {
    pub node_id: String,
    pub reason: String, // "admin" | "restore" | "schema_mismatch"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_content_hash: Option<String>,
}

/// A file/version row captured in a snapshot chunk.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileVersionRecord {
    pub file_id: String,
    pub version_number: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_version_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflict_status: Option<String>,
    pub version_hash: String,
    pub shard_count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encrypted_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_folder_id: Option<String>,
}

/// A tombstone row captured in a snapshot chunk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TombstoneRecord {
    pub entity_type: String, // "file" | "folder"
    pub entity_id: String,
    pub deleted_at: String,
}

/// Snapshot chunk record — a single file_version or tombstone row.
/// `untagged` keeps records as plain JSON objects on the wire (matching the TS
/// `SnapshotChunkPayloadSchema`); the outer `record_type` discriminates which
/// shape each record has.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SnapshotRecord {
    FileVersion(FileVersionRecord),
    Tombstone(TombstoneRecord),
}

/// Snapshot_begin metadata (§20).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotBeginPayload {
    pub snapshot_id: String,
    pub node_id: String,
    pub snapshot_sequence: i64,
    pub total_chunks: i64,
    pub content_hash: String,
    pub signature: String,
    pub data_schema_version: String,
    pub cursors: Vec<SyncCursor>,
}

/// Snapshot chunk carrying up to 1000 homogeneous records.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotChunkPayload {
    pub snapshot_id: String,
    pub chunk_index: i64,
    pub record_type: String, // "file_version" | "tombstone"
    pub records: Vec<SnapshotRecord>,
}

/// Snapshot completion marker with end-to-end content hash.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotEndPayload {
    pub snapshot_id: String,
    pub final_hash: String,
    pub signature: String,
}
