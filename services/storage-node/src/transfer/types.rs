use serde::{Deserialize, Serialize};

/// Transfer path identifiers — the four methods in the fallback chain.
/// Mirrors the TS `TransferPath` enum exactly (see spec §"Transfer Paths").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransferPath {
    LocalSignaling,
    RelaySignaling,
    BufferRelay,
    LocalQueue,
}

impl TransferPath {
    /// Convert to/from the string form stored in SQLite.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::LocalSignaling => "local_signaling",
            Self::RelaySignaling => "relay_signaling",
            Self::BufferRelay => "buffer_relay",
            Self::LocalQueue => "local_queue",
        }
    }

    /// Parse a TransferPath from its persisted string form.
    ///
    /// Deliberately returns `Option` (not `Result`) to keep callers that only
    /// need to recognize stored values simple; clippy's `should_implement_trait`
    /// hint is inapplicable because we are not adopting `std::str::FromStr`.
    #[allow(clippy::should_implement_trait)]
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "local_signaling" => Some(Self::LocalSignaling),
            "relay_signaling" => Some(Self::RelaySignaling),
            "buffer_relay" => Some(Self::BufferRelay),
            "local_queue" => Some(Self::LocalQueue),
            _ => None,
        }
    }
}

/// Per-shard transfer state.
#[derive(Debug, Clone)]
pub enum TransferState {
    Pending,
    Attempting(TransferPath),
    Succeeded,
    FailedPermanent,
}

/// A single shard transfer request.
#[derive(Debug, Clone)]
pub struct ShardTransferRequest {
    pub transfer_id: String,
    pub file_id: String,
    pub version_number: i64,
    pub shard_index: i64,
    pub data: Vec<u8>,
    pub hash: String,
    pub target_node: String,
    pub source_device: Option<String>,
}

/// Outcome of a shard transfer attempt.
#[derive(Debug, Clone)]
pub struct TransferResult {
    pub path: TransferPath,
    pub duration_ms: u64,
    pub transfer_id: String,
    pub bytes_transferred: usize,
    pub success: bool,
    pub error: Option<String>,
}
