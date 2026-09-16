use std::sync::Arc;
use std::time::{Duration, Instant};

use sqlx::SqlitePool;
use tokio::sync::Mutex;

use super::executor::PathAttempt;
use super::types::{ShardTransferRequest, TransferPath, TransferResult};
use crate::identity::NodeIdentity;
use crate::store::ObjectStore;
use crate::sync::types::{NodeShardFetchPayload, ProtocolEnvelope};

/// Shared slot the sync loop fills with its live WS sender so the transfer
/// manager can emit `node_shard_fetch` requests for Path B repairs. `None`
/// while no sync session is live.
pub type RelaySignalSender =
    Arc<Mutex<Option<tokio::sync::mpsc::UnboundedSender<ProtocolEnvelope>>>>;

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
    /// Relay HTTP base (scheme + host, `/ws` stripped) for the Path C
    /// relay-mediated shard fetch. Derived from the configured relay URL.
    relay_http_base: String,
    /// Path B signaling channel to the live sync WS (see `RelaySignalSender`).
    relay_signal_tx: RelaySignalSender,
    http: reqwest::Client,
}

/// Canonical bytes a node signs for a node→relay HTTP request. Must match the
/// relay's `auth.NodeRequestMessage` byte-for-byte, including millisecond time.
pub fn node_request_message(
    node_id: &str,
    method: &str,
    path: &str,
    timestamp_millis: i64,
) -> String {
    format!("nodus-node-request:{node_id}:{method}:{path}:{timestamp_millis}")
}

/// Total budget for one direct peer shard fetch (#9): covers the whole
/// exchange including the body read. A shard is at most `MAX_SHARD_BYTES` on
/// this node and the peer is on the LAN, so 30 s of silence means the peer is
/// wedged — fail the attempt and let the executor fall through to another
/// path / the next reconciliation scan.
const PEER_FETCH_TIMEOUT: Duration = Duration::from_secs(30);

impl NodePathAttempter {
    pub fn new(
        db: SqlitePool,
        store: Arc<ObjectStore>,
        identity: Arc<NodeIdentity>,
        relay_http_base: String,
        relay_signal_tx: RelaySignalSender,
    ) -> Self {
        Self {
            db,
            store,
            identity,
            relay_http_base,
            relay_signal_tx,
            // Fresh client per attempter: pooled, cheap, and isolates DNS/header
            // state from the manager's own Relay-fetch client. The timeout
            // bounds the whole peer exchange (#9) so a wedged peer can't pin a
            // repair slot of the shared concurrency pool.
            http: reqwest::Client::builder()
                .timeout(PEER_FETCH_TIMEOUT)
                .build()
                .expect("reqwest client build cannot fail"),
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

                // A non-2xx means the peer said no, not "bad bytes"; check it
                // before reading so an error page is never buffered.
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

                // Stream with a hard cap. The peer IP came from spoofable mDNS,
                // so an on-link attacker advertising this node_id must not be
                // able to stream an unbounded body and OOM the node. The repair
                // loop still hash-verifies the payload against `object_id`.
                let body =
                    match crate::limits::read_body_capped(resp, crate::limits::MAX_SHARD_BYTES)
                        .await
                    {
                        Ok(b) => b,
                        Err(e) => {
                            return TransferResult {
                                path,
                                duration_ms: started.elapsed().as_millis() as u64,
                                transfer_id: request.transfer_id.clone(),
                                bytes_transferred: 0,
                                success: false,
                                error: Some(format!(
                                    "reading shard response from {addr} failed: {e}"
                                )),
                                data: Vec::new(),
                                object_id: request.object_id.clone(),
                            };
                        }
                    };

                TransferResult {
                    path,
                    duration_ms: started.elapsed().as_millis() as u64,
                    transfer_id: request.transfer_id.clone(),
                    bytes_transferred: body.len(),
                    success: true,
                    error: None,
                    data: body,
                    object_id: request.object_id.clone(),
                }
            }
            // Path B: direct node→node transfer over the Relay's signaling
            // plane. We ask the holder for the object; it originates a WebRTC
            // offer, we answer, and it streams the shard into our inbound
            // session, which stores it. We then read the stored bytes back and
            // hand them to the caller (the restore path verifies the hash
            // again). The Relay only ever sees signaling.
            TransferPath::RelaySignaling => {
                let started = Instant::now();
                let sender = self.relay_signal_tx.lock().await.clone();
                let Some(tx) = sender else {
                    return TransferResult {
                        path,
                        duration_ms: started.elapsed().as_millis() as u64,
                        transfer_id: request.transfer_id.clone(),
                        bytes_transferred: 0,
                        success: false,
                        error: Some("no live relay signaling session for Path B".to_string()),
                        data: Vec::new(),
                        object_id: request.object_id.clone(),
                    };
                };

                let payload = NodeShardFetchPayload {
                    from_peer: self.identity.node_id.clone(),
                    to_peer: request.target_node.clone(),
                    object_id: request.object_id.clone(),
                };
                match serde_json::to_value(&payload) {
                    Ok(value) => {
                        let env = ProtocolEnvelope::new("node_shard_fetch", value);
                        if tx.send(env).is_err() {
                            return TransferResult {
                                path,
                                duration_ms: started.elapsed().as_millis() as u64,
                                transfer_id: request.transfer_id.clone(),
                                bytes_transferred: 0,
                                success: false,
                                error: Some("relay signaling channel closed".to_string()),
                                data: Vec::new(),
                                object_id: request.object_id.clone(),
                            };
                        }
                    }
                    Err(e) => {
                        return TransferResult {
                            path,
                            duration_ms: started.elapsed().as_millis() as u64,
                            transfer_id: request.transfer_id.clone(),
                            bytes_transferred: 0,
                            success: false,
                            error: Some(format!("serializing node_shard_fetch failed: {e}")),
                            data: Vec::new(),
                            object_id: request.object_id.clone(),
                        };
                    }
                }

                // The peer pushes asynchronously; poll the store for the
                // object within the negotiation budget.
                let deadline = Instant::now() + PEER_FETCH_TIMEOUT;
                loop {
                    match self.store.get(&request.object_id).await {
                        Ok(bytes) => {
                            return TransferResult {
                                path,
                                duration_ms: started.elapsed().as_millis() as u64,
                                transfer_id: request.transfer_id.clone(),
                                bytes_transferred: bytes.len(),
                                success: true,
                                error: None,
                                data: bytes,
                                object_id: request.object_id.clone(),
                            };
                        }
                        Err(_) => {
                            if Instant::now() >= deadline {
                                return TransferResult {
                                    path,
                                    duration_ms: started.elapsed().as_millis() as u64,
                                    transfer_id: request.transfer_id.clone(),
                                    bytes_transferred: 0,
                                    success: false,
                                    error: Some(
                                        "timed out waiting for peer WebRTC push".to_string(),
                                    ),
                                    data: Vec::new(),
                                    object_id: request.object_id.clone(),
                                };
                            }
                            tokio::time::sleep(Duration::from_millis(200)).await;
                        }
                    }
                }
            }
            // Path C: relay-mediated repair fetch. Ask the Relay to fetch the
            // object from whichever holder node is online (`GET /node/shards/…`,
            // authenticated by a stateless node signature) and stream the bytes
            // back. This is the internet fallback when the holder is not
            // reachable directly on the LAN; the Relay carries ciphertext only,
            // exactly as the browser download proxy does.
            TransferPath::BufferRelay => {
                let started = Instant::now();
                let signed_path = format!("/node/shards/{}", request.object_id);
                let url = format!("{}{}", self.relay_http_base, signed_path);
                let timestamp = chrono::Utc::now().timestamp_millis();
                let message =
                    node_request_message(&self.identity.node_id, "GET", &signed_path, timestamp);
                let signature = hex::encode(self.identity.sign(message.as_bytes()).to_bytes());

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
                            error: Some(format!("relay shard fetch failed: {e}")),
                            data: Vec::new(),
                            object_id: request.object_id.clone(),
                        };
                    }
                };

                let status = resp.status();
                if !status.is_success() {
                    // 404 = no online holder (yet); not a hard error. The next
                    // scan / reconnect drain retries.
                    return TransferResult {
                        path,
                        duration_ms: started.elapsed().as_millis() as u64,
                        transfer_id: request.transfer_id.clone(),
                        bytes_transferred: 0,
                        success: false,
                        error: Some(format!("relay rejected shard fetch: HTTP {status}")),
                        data: Vec::new(),
                        object_id: request.object_id.clone(),
                    };
                }

                // Stream with a hard cap: the shard is at most MAX_SHARD_BYTES,
                // so a misbehaving relay cannot OOM the node.
                let body =
                    match crate::limits::read_body_capped(resp, crate::limits::MAX_SHARD_BYTES)
                        .await
                    {
                        Ok(b) => b,
                        Err(e) => {
                            return TransferResult {
                                path,
                                duration_ms: started.elapsed().as_millis() as u64,
                                transfer_id: request.transfer_id.clone(),
                                bytes_transferred: 0,
                                success: false,
                                error: Some(format!("reading relay shard response failed: {e}")),
                                data: Vec::new(),
                                object_id: request.object_id.clone(),
                            };
                        }
                    };

                TransferResult {
                    path,
                    duration_ms: started.elapsed().as_millis() as u64,
                    transfer_id: request.transfer_id.clone(),
                    bytes_transferred: body.len(),
                    success: true,
                    error: None,
                    data: body,
                    object_id: request.object_id.clone(),
                }
            }
            // Path D: a repair fetch cannot be served synchronously from the
            // local queue. The executor only reaches this path after A/B/C
            // failed, and the reconciliation loop then enqueues the failed
            // request (`enqueue_repair`) for a retry when the relay reconnects
            // (`drain_queue`). Report failure so the chain reads exhausted;
            // the queued retry is the actual Path D behavior.
            TransferPath::LocalQueue => TransferResult {
                path,
                duration_ms: 0,
                transfer_id: request.transfer_id.clone(),
                bytes_transferred: 0,
                success: false,
                error: Some("queued for retry on the next relay reconnect".to_string()),
                data: Vec::new(),
                object_id: request.object_id.clone(),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Router;
    use axum::body::Body;
    use axum::extract::Path as AxumPath;
    use axum::http::{HeaderMap, StatusCode};
    use axum::response::IntoResponse;
    use axum::routing::get;
    use ed25519_dalek::Verifier;
    use tempfile::tempdir;

    #[test]
    fn node_request_message_matches_relay_format() {
        // Must stay byte-identical to the relay's auth.NodeRequestMessage.
        assert_eq!(
            node_request_message("n1", "GET", "/node/shards/abc", 1234),
            "nodus-node-request:n1:GET:/node/shards/abc:1234"
        );
    }

    #[tokio::test]
    async fn path_c_fetches_via_signed_relay_request() {
        let dir = tempdir().unwrap();
        let identity = Arc::new(crate::identity::load_or_generate(dir.path()).unwrap());
        let expected = b"relay-served-shard-bytes".to_vec();
        let object_id = blake3::hash(&expected).to_hex().to_string();

        // Relay stand-in that verifies the node signature exactly as
        // RequireNodeAuth does before serving the object bytes.
        let verifier = Arc::clone(&identity);
        let served = expected.clone();
        let expected_id = object_id.clone();
        let app = Router::new().route(
            "/node/shards/{object_id}",
            get(move |headers: HeaderMap, AxumPath(id): AxumPath<String>| {
                let verifier = Arc::clone(&verifier);
                let served = served.clone();
                let expected_id = expected_id.clone();
                async move {
                    let node_id = headers
                        .get("x-nodus-node-id")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("");
                    let timestamp = headers
                        .get("x-nodus-timestamp")
                        .and_then(|v| v.to_str().ok())
                        .and_then(|v| v.parse::<i64>().ok())
                        .unwrap_or(0);
                    let signature_hex = headers
                        .get("x-nodus-signature")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("");
                    let message = node_request_message(
                        node_id,
                        "GET",
                        &format!("/node/shards/{id}"),
                        timestamp,
                    );
                    let Some(sig_bytes) = hex::decode(signature_hex)
                        .ok()
                        .and_then(|b| <[u8; 64]>::try_from(b).ok())
                    else {
                        return (StatusCode::UNAUTHORIZED, Vec::new()).into_response();
                    };
                    let signature = ed25519_dalek::Signature::from_bytes(&sig_bytes);
                    if verifier
                        .public_key
                        .verify(message.as_bytes(), &signature)
                        .is_err()
                    {
                        return (StatusCode::UNAUTHORIZED, Vec::new()).into_response();
                    }
                    if id != expected_id {
                        return (StatusCode::NOT_FOUND, Vec::new()).into_response();
                    }
                    (StatusCode::OK, served).into_response()
                }
            }),
        );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let pool = crate::db::open(dir.path()).await.unwrap();
        let store = Arc::new(
            crate::store::ObjectStore::new(dir.path().join("objects"), pool.clone())
                .await
                .unwrap(),
        );
        let attempter = NodePathAttempter::new(
            pool,
            store,
            Arc::clone(&identity),
            format!("http://{addr}"),
            Arc::new(tokio::sync::Mutex::new(None)),
        );

        let request = ShardTransferRequest {
            transfer_id: "t-c".to_string(),
            file_id: "f1".to_string(),
            version_number: 1,
            shard_index: 0,
            data: Vec::new(),
            hash: object_id.clone(),
            object_id: object_id.clone(),
            target_node: "peer-node".to_string(),
            source_device: None,
        };

        let result = attempter.attempt(&request, TransferPath::BufferRelay).await;
        assert!(result.success, "path C failed: {:?}", result.error);
        assert_eq!(result.path, TransferPath::BufferRelay);
        assert_eq!(result.data, expected);

        // A different object is not served, so the attempt fails rather than
        // returning the wrong bytes.
        let mut other = request.clone();
        other.object_id = "0".repeat(64);
        let missing = attempter.attempt(&other, TransferPath::BufferRelay).await;
        assert!(!missing.success);
    }

    // Silence unused-import warnings if Body is not needed on some axum builds.
    #[allow(dead_code)]
    fn _body_marker(_: Body) {}
}
