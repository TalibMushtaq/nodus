use std::sync::Arc;

use sqlx::SqlitePool;

use super::executor::PathAttempt;
use super::types::{ShardTransferRequest, TransferPath, TransferResult};
use crate::identity::NodeIdentity;
use crate::store::ObjectStore;

/// Node-side path attempter for the fallback chain.
///
/// This is where the node's actual transport backends plug in: fresh mDNS
/// discovery + local HTTP signaling (Path A), Relay WS signaling (Path B),
/// Relay buffer (Path C), and the local queue (Path D). The Transfer
/// Manager's executor drives the fallback/backoff/cache behavior around
/// these attempts, so the repair action (§21a) gets identical semantics to
/// any client-initiated transfer.
pub struct NodePathAttempter {
    pub db: SqlitePool,
    pub store: Arc<ObjectStore>,
    pub identity: Arc<NodeIdentity>,
}

impl NodePathAttempter {
    pub fn new(db: SqlitePool, store: Arc<ObjectStore>, identity: Arc<NodeIdentity>) -> Self {
        Self {
            db,
            store,
            identity,
        }
    }
}

#[async_trait::async_trait]
impl PathAttempt for NodePathAttempter {
    async fn attempt(&self, request: &ShardTransferRequest, path: TransferPath) -> TransferResult {
        match path {
            // ponytail: Path A (node→node direct WebRTC) also needs the
            // receiving side to accept an inbound offer from a *node* peer,
            // which the Phase 11 WebRtcManager doesn't yet support (it only
            // accepts offers from paired devices). Until that lands, local
            // signaling reports a hard failure so the executor falls through
            // instead of blocking on a dead path.
            TransferPath::LocalSignaling => TransferResult {
                path,
                duration_ms: 0,
                transfer_id: request.transfer_id.clone(),
                bytes_transferred: 0,
                success: false,
                error: Some(
                    "node-to-node WebRTC receive not yet supported (WebRtcManager accepts paired devices only)"
                        .to_string(),
                ),
            },
            // ponytail: Path B needs node-initiated WS signaling to the Relay
            // for a *peer* target. The node's sync WS client is session-scoped;
            // a generic peer signaling channel is a later phase. Report failure
            // so the executor legitimately falls through.
            TransferPath::RelaySignaling => TransferResult {
                path,
                duration_ms: 0,
                transfer_id: request.transfer_id.clone(),
                bytes_transferred: 0,
                success: false,
                error: Some("node-to-node relay signaling not yet supported".to_string()),
            },
            // Path C: node-initiated push/fetch of a *peer's* shard through
            // the Relay buffer is not yet supported (Phase 10 wires the
            // client→relay→node direction only). Report failure so the
            // executor falls through; the scheduled reconciliation scan
            // re-attempts the repair.
            TransferPath::BufferRelay => TransferResult {
                path,
                duration_ms: 0,
                transfer_id: request.transfer_id.clone(),
                bytes_transferred: 0,
                success: false,
                error: Some("node-to-node repair via relay buffer not yet supported".to_string()),
            },
            // Path D: for repairs the retry mechanism is the next scheduled
            // reconciliation scan, not the in-memory queue — nothing drives
            // `drain_queue` on connectivity restoration today, so a queued
            // repair would sit forever. Return failure and let the caller
            // (which already re-queries DEGRADED shards each scan) retry.
            TransferPath::LocalQueue => TransferResult {
                path,
                duration_ms: 0,
                transfer_id: request.transfer_id.clone(),
                bytes_transferred: 0,
                success: false,
                error: Some("repair has no retry path yet; next reconciliation scan will re-attempt".to_string()),
            },
        }
    }
}
