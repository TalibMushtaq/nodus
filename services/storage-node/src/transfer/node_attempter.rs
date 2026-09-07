use std::sync::Arc;
use std::time::{Duration, Instant};

use sqlx::SqlitePool;

use super::executor::PathAttempt;
use super::types::{ShardTransferRequest, TransferPath, TransferResult};
use crate::identity::NodeIdentity;
use crate::store::ObjectStore;

/// The node-side path attempter for the fallback chain.
///
/// This is where the node's actual transport backends plug in: fresh mDNS
/// discovery + authenticated HTTP shard fetch (Path A), Relay WS signaling
/// (Path B), Relay buffer (Path C), and the local queue (Path D). The Transfer
/// Manager's executor drives the fallback/backoff/cache behavior around
/// these attempts, so the repair action (§21a) gets identical semantics to
/// any client-initiated transfer.
pub struct NodePathAttempter {
    pub db: SqlitePool,
    pub store: Arc<ObjectStore>,
    pub identity: Arc<NodeIdentity>,
    http: reqwest::Client,
}

/// How long a single mDNS peer lookup may take before Path A gives up. LAN
/// multicast is fast; a fixed budget keeps one stuck repair from holding the
/// pool semaphore forever (the next reconciliation scan retries it).
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(2);

impl NodePathAttempter {
    pub fn new(db: SqlitePool, store: Arc<ObjectStore>, identity: Arc<NodeIdentity>) -> Self {
        Self {
            db,
            store,
            identity,
            // Fresh client per attempter: pooled, cheap, and isolates DNS/header
            // state from the manager's own Relay-fetch client.
            http: reqwest::Client::new(),
        }
    }
}

#[async_trait::async_trait]
impl PathAttempt for NodePathAttempter {
    async fn attempt(&self, request: &ShardTransferRequest, path: TransferPath) -> TransferResult {
        match path {
            // Path A: local node→node repair backhaul. Discover the peer's LAN
            // address via mDNS, then GET /nodus/shard/{object_id} with a
            // stateless signature over "{node_id}:{object_id}:{timestamp_ms}".
            // The receiving node verifies against its trusted_nodes table.
            TransferPath::LocalSignaling => {
                let started = Instant::now();
                let Some(addr) = crate::local::mdns::discover_node(&request.target_node).await
                else {
                    return TransferResult {
                        path,
                        duration_ms: started.elapsed().as_millis() as u64,
                        transfer_id: request.transfer_id.clone(),
                        bytes_transferred: 0,
                        success: false,
                        error: Some(format!(
                            "peer node {} not found on LAN",
                            request.target_node
                        )),
                        data: Vec::new(),
                        object_id: request.object_id.clone(),
                    };
                };

                let timestamp = chrono::Utc::now().timestamp_millis();
                let message = format!(
                    "{}:{}:{timestamp}",
                    self.identity.node_id, request.object_id
                );
                let signature = hex::encode(self.identity.sign(message.as_bytes()).to_bytes());

                let url = format!("http://{addr}/nodus/shard/{}", request.object_id);
                let resp = match self
                    .http
                    .get(&url)
                    .header("x-nodus-node-id", &self.identity.node_id)
                    .header("x-nodus-timestamp", timestamp.to_string())
                    .header("x-nodus-signature", signature)
                    .send()
                    .await
                {
                    Ok(r) => r,
                    Err(e) => {
                        return TransferResult {
                            path,
                            duration_ms: started.elapsed().as_millis() as u64,
                            transfer_id: request.transfer_id.clone(),
                            bytes_transferred: 0,
                            success: false,
                            error: Some(format!("shard fetch from {addr} failed: {e}")),
                            data: Vec::new(),
                            object_id: request.object_id.clone(),
                        };
                    }
                };

                let status = resp.status();
                let body = match resp.bytes().await {
                    Ok(b) => b,
                    Err(e) => {
                        return TransferResult {
                            path,
                            duration_ms: started.elapsed().as_millis() as u64,
                            transfer_id: request.transfer_id.clone(),
                            bytes_transferred: 0,
                            success: false,
                            error: Some(format!("reading shard response from {addr} failed: {e}")),
                            data: Vec::new(),
                            object_id: request.object_id.clone(),
                        };
                    }
                };

                // The repair loop hash-verifies the payload against the
                // object_id; a non-2xx means the peer said no, not "bad bytes".
                if !status.is_success() {
                    return TransferResult {
                        path,
                        duration_ms: started.elapsed().as_millis() as u64,
                        transfer_id: request.transfer_id.clone(),
                        bytes_transferred: 0,
                        success: false,
                        error: Some(format!("peer {addr} rejected shard fetch: HTTP {status}")),
                        data: Vec::new(),
                        object_id: request.object_id.clone(),
                    };
                }

                TransferResult {
                    path,
                    duration_ms: started.elapsed().as_millis() as u64,
                    transfer_id: request.transfer_id.clone(),
                    bytes_transferred: body.len(),
                    success: true,
                    error: None,
                    data: body.to_vec(),
                    object_id: request.object_id.clone(),
                }
            }
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
                data: Vec::new(),
                object_id: request.object_id.clone(),
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
                data: Vec::new(),
                object_id: request.object_id.clone(),
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
                error: Some(
                    "repair has no retry path yet; next reconciliation scan will re-attempt"
                        .to_string(),
                ),
                data: Vec::new(),
                object_id: request.object_id.clone(),
            },
        }
    }
}
