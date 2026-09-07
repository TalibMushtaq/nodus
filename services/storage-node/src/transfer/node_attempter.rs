use std::sync::Arc;

use sqlx::SqlitePool;
use tokio::sync::Mutex;

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
    pending_repairs: Mutex<Vec<ShardTransferRequest>>,
}

impl NodePathAttempter {
    pub fn new(db: SqlitePool, store: Arc<ObjectStore>, identity: Arc<NodeIdentity>) -> Self {
        Self {
            db,
            store,
            identity,
            pending_repairs: Mutex::new(Vec::new()),
        }
    }
}

#[async_trait::async_trait]
impl PathAttempt for NodePathAttempter {
    async fn attempt(
        &self,
        request: &ShardTransferRequest,
        path: TransferPath,
    ) -> TransferResult {
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
            // Path C / Path D: store the repair in the local queue for retry
            // on connectivity restoration (the honest v1 behavior — the
            // upstream peer address may simply be unavailable right now).
            TransferPath::BufferRelay | TransferPath::LocalQueue => {
                self.pending_repairs.lock().await.push(request.clone());
                TransferResult {
                    path,
                    duration_ms: 0,
                    transfer_id: request.transfer_id.clone(),
                    bytes_transferred: 0,
                    success: false,
                    error: Some("queued for retry via local queue".to_string()),
                }
            }
        }
    }
}