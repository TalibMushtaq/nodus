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
    /// The shard bytes. For a push this is the payload to send; for a fetch
    /// the peer supplies these, so the outgoing request carries empty data.
    pub data: Vec<u8>,
    /// Expected content hash (BLAKE3 hex) of the shard. For a repair fetch
    /// this is the `object_id` the receiver restores bytes under.
    pub hash: String,
    /// The `object_id` (BLAKE3 hex) the receiving node restores the shard
    /// bytes under. Needed by the repair loop to verify and write-on-restore.
    pub object_id: String,
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
    /// Bytes actually received for a fetch. Empty for pushes and for failed
    /// or not-yet-implemented paths (e.g. relay signaling).
    pub data: Vec<u8>,
    /// The `object_id` this result expected (copied from the request). Lets
    /// the repair loop verify and restore without an extra mapping.
    pub object_id: String,
}
