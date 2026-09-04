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
