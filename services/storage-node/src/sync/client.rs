use futures_util::{SinkExt, StreamExt};
use sqlx::{Acquire, Row, SqlitePool};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;
use url::Url;

use super::engine::{apply_incoming_batch, drain_pending_fetches};
use super::outbox::{drain_unsynced_events, mark_events_synced, sweep_synced_outbox};
use super::snapshot::is_rebuild_required_for;
use super::types::{
    BatchAckPayload, EventBatchPayload, NodeAuthChallengePayload, NodeAuthResponsePayload,
    NodeAuthResultPayload, NodePeer, NodeShardFetchPayload, PairingTokenPushPayload,
    PendingNotifyPayload, ProtocolEnvelope, RegisterPayload, ShardAckPayload,
    ShardFetchRequestPayload, ShardFetchResultPayload, SnapshotBeginPayload, SnapshotChunkPayload,
    SnapshotEndPayload, SyncCursor, SyncHelloPayload, SyncStatusPayload,
};
use crate::identity::NodeIdentity;
use crate::store::ObjectStore;
use crate::webrtc::OutboundSession;
use crate::webrtc::session::ShardUploadPayload;

/// A signal routed from the sync read loop to an outbound (Path B initiator)
/// repair task. The task owns the peer connection; the read loop only feeds it
/// the answer and remote ICE candidates addressed to it.
enum OutboundSignal {
    Answer(String),
    Ice(String),
}

/// If an event is a tombstone, return `(entity_type, entity_id)` so the client
/// can ack it to the Relay. `FOLDER_DELETED` carries a `folder_id` instead of
/// the generic entity fields used by `TOMBSTONE_CREATED`/`FILE_DELETED`.
fn tombstone_entity(ev: &super::types::SyncEvent) -> Option<(String, String)> {
    match ev.event_type.as_str() {
        "TOMBSTONE_CREATED" | "FILE_DELETED" => {
            let id = ev.payload.get("entity_id").and_then(|v| v.as_str())?;
            let ty = ev
                .payload
                .get("entity_type")
                .and_then(|v| v.as_str())
                .unwrap_or("file");
            Some((ty.to_string(), id.to_string()))
        }
        "FOLDER_DELETED" => {
            let id = ev.payload.get("folder_id").and_then(|v| v.as_str())?;
            Some(("folder".to_string(), id.to_string()))
        }
        _ => None,
    }
}

/// Seed `trusted_nodes` from the relay's auth-success peer list so node-to-node
/// shard fetch/repair has a trust anchor (§21a). Self is skipped, a malformed
/// hex/off-length key is ignored rather than aborting the batch, and an
/// existing row keeps its path-cache columns (`last_successful_path` /
/// `last_success_at`) — only the published key is refreshed. This is the only
/// production writer of `trusted_nodes`.
async fn store_trusted_peers(
    db: &SqlitePool,
    self_node_id: &str,
    peers: &[NodePeer],
) -> anyhow::Result<()> {
    for peer in peers {
        if peer.node_id == self_node_id {
            continue;
        }
        let Ok(key) = hex::decode(&peer.public_key) else {
            eprintln!(
                "[sync] ignoring trusted peer {}: public_key is not hex",
                peer.node_id
            );
            continue;
        };
        if key.len() != 32 {
            eprintln!(
                "[sync] ignoring trusted peer {}: expected a 32-byte Ed25519 key, got {}",
                peer.node_id,
                key.len()
            );
            continue;
        }
        sqlx::query(
            "INSERT INTO trusted_nodes (node_id, public_key_bytes, created_at)
             VALUES (?, ?, ?)
             ON CONFLICT(node_id) DO UPDATE SET public_key_bytes = excluded.public_key_bytes",
        )
        .bind(&peer.node_id)
        .bind(key)
        .bind(chrono::Utc::now().to_rfc3339())
        .execute(db)
        .await?;
    }
    Ok(())
}

/// Path B holder task: originate a WebRTC session to the repairing peer, stream
/// the requested object, and wait for its ack. Signaling rides `out_tx` (drained
/// into the session's WS by the read loop) and `signal_rx` (answer/ICE fed back
/// by the read loop).
#[allow(clippy::too_many_arguments)]
async fn outbound_repair_task(
    identity: Arc<NodeIdentity>,
    store: Arc<ObjectStore>,
    to_peer: String,
    object_id: String,
    file_id: String,
    version_number: i64,
    shard_index: i64,
    out_tx: mpsc::UnboundedSender<ProtocolEnvelope>,
    mut signal_rx: mpsc::UnboundedReceiver<OutboundSignal>,
) -> anyhow::Result<()> {
    let bytes = store
        .get(&object_id)
        .await
        .map_err(|e| anyhow::anyhow!("reading object {object_id} to serve: {e}"))?;

    let session = OutboundSession::new().await?;

    // Forward our local ICE candidates over the signaling channel.
    let mut ice_rx = session.subscribe_ice();
    let out_ice = out_tx.clone();
    let from = identity.node_id.clone();
    let to = to_peer.clone();
    tokio::spawn(async move {
        while let Ok(candidate) = ice_rx.recv().await {
            let env = ProtocolEnvelope::new(
                "webrtc_ice_candidate",
                serde_json::json!({ "from_peer": from, "to_peer": to, "candidate": candidate }),
            );
            if out_ice.send(env).is_err() {
                break;
            }
        }
    });

    // Sign the offer so the peer can verify us against its trusted_nodes
    // (same message shape the device Path B uses).
    let sdp = session.create_offer().await?;
    let timestamp = chrono::Utc::now().timestamp_millis();
    let digest = blake3::hash(sdp.as_bytes()).to_hex().to_string();
    let message = format!(
        "{}:relay-{}:{timestamp}:{digest}",
        identity.node_id, identity.node_id
    );
    let signature = hex::encode(identity.sign(message.as_bytes()).to_bytes());
    let offer = ProtocolEnvelope::new(
        "webrtc_offer",
        serde_json::json!({
            "from_peer": identity.node_id,
            "to_peer": to_peer,
            "sdp": sdp,
            "timestamp": timestamp,
            "signature": signature,
        }),
    );
    out_tx
        .send(offer)
        .map_err(|_| anyhow::anyhow!("relay signaling channel closed"))?;

    // Await the answer, buffering any ICE that arrives before it.
    let mut answer: Option<String> = None;
    let mut pending_ice: Vec<String> = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while answer.is_none() {
        match tokio::time::timeout_at(deadline, signal_rx.recv()).await {
            Ok(Some(OutboundSignal::Answer(s))) => answer = Some(s),
            Ok(Some(OutboundSignal::Ice(c))) => pending_ice.push(c),
            Ok(None) | Err(_) => anyhow::bail!("timed out waiting for the peer's WebRTC answer"),
        }
    }
    session
        .set_answer(answer.as_deref().unwrap_or_default())
        .await?;
    for candidate in pending_ice {
        let _ = session.add_ice_candidate(&candidate).await;
    }

    let meta = ShardUploadPayload {
        file_id,
        version_number,
        shard_index,
        hash: object_id.clone(),
        size: bytes.len() as i64,
        transfer_id: uuid::Uuid::new_v4().to_string(),
        target_node: Some(to_peer),
        source_device: Some(identity.node_id.clone()),
    };
    let ack = session.send_shard(&meta, &bytes).await?;
    session.close().await;
    if ack.status != "verified" {
        anyhow::bail!("peer rejected the shard: {:?}", ack.error_message);
    }
    Ok(())
}

/// Derive the Relay's plain-HTTP base from any configured relay URL. Accepts
/// the operator-facing public origin (`https://host`, `http://host`) as well as
/// the legacy explicit WebSocket form (`ws(s)://…/ws`): the scheme flips to
/// http(s) and a trailing `/ws` gateway segment is dropped. Query strings and
/// fragments are discarded (they are per-connection, never base-affecting), and
/// a non-`/ws` base path is preserved for proxied deployments. Unparseable
/// values are returned unchanged so a malformed config fails on connection.
pub fn relay_http_base(raw: &str) -> String {
    let Ok(mut url) = Url::parse(raw) else {
        return raw.to_string();
    };
    let _ = url.set_scheme(if url.scheme() == "wss" || url.scheme() == "https" {
        "https"
    } else {
        "http"
    });
    url.set_query(None);
    url.set_fragment(None);

    let trimmed = url.path().trim_end_matches('/').to_string();
    let base = match trimmed.strip_suffix("/ws") {
        Some(dir) => dir.trim_end_matches('/').to_string(),
        None => trimmed,
    };
    url.set_path(&base);
    url.to_string().trim_end_matches('/').to_string()
}

/// Derive the Relay's HTTP fetch endpoint from its WebSocket URL. Builds on
/// `relay_http_base` and appends the fixed `/buffer/fetch` path; parsed once at
/// construction so the fetch URL is stable for the lifetime of the client.
pub fn relay_http_fetch_url(relay_url: &str) -> String {
    // Degenerate config: keep the raw value so the node still attempts a
    // fetch instead of failing to boot over a malformed URL.
    if Url::parse(relay_url).is_err() {
        return relay_url.to_string();
    }
    format!("{}/buffer/fetch", relay_http_base(relay_url))
}

/// Marker error returned by `run_sync_session` when the Relay rejects the node
/// with the machine-readable `node_not_found` reason (§7b "Unpaired-node UX").
/// Callers can `downcast_ref` it to print pairing guidance instead of treating
/// an unpaired node as a generic relay outage.
#[derive(Debug)]
pub struct NodeNotPaired;

impl std::fmt::Display for NodeNotPaired {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "storage node is not paired")
    }
}

impl std::error::Error for NodeNotPaired {}

/// True when `e` (or any source in its chain) is the `NodeNotPaired` marker.
pub fn is_node_not_paired(e: &anyhow::Error) -> bool {
    e.chain().any(|c| c.is::<NodeNotPaired>())
}

/// Marker error returned when the Relay reports `node_inactive`: the node is
/// registered but its status is not ACTIVE (e.g. REVOKED). Kept distinct from
/// `NodeNotPaired` so the caller does not tell an operator to re-pair a node
/// that is already bound to an account.
#[derive(Debug)]
pub struct NodeNotActive;

impl std::fmt::Display for NodeNotActive {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "storage node is registered but not active")
    }
}

impl std::error::Error for NodeNotActive {}

/// True when `e` (or any source in its chain) is the `NodeNotActive` marker.
pub fn is_node_not_active(e: &anyhow::Error) -> bool {
    e.chain().any(|c| c.is::<NodeNotActive>())
}

/// Normalize a configured relay URL into the WebSocket URL the sync client
/// dials. `config.toml`/the pairing prompt hold the operator-facing public
/// origin (`https://nodus.example.com`), so https/http are upgraded to
/// wss/ws and the `/ws` gateway path is appended (preserving any base path as
/// a prefix, e.g. `https://host/proxy` → `/proxy/ws`). Explicit `ws://`/`wss://`
/// values (the legacy `NODUS_RELAY_URL` form) are used verbatim so an
/// already-correct endpoint is never double-suffixed. Unparseable values are
/// returned unchanged so a malformed config surfaces as a connection error
/// rather than a panic.
pub fn relay_ws_url(raw: &str) -> String {
    let Ok(mut url) = Url::parse(raw) else {
        return raw.to_string();
    };

    match url.scheme() {
        "https" => {
            let _ = url.set_scheme("wss");
            append_ws_path(&mut url);
        }
        "http" => {
            let _ = url.set_scheme("ws");
            append_ws_path(&mut url);
        }
        // Already a WebSocket URL: the caller is responsible for its path.
        _ => {}
    }

    url.to_string()
}

/// Append `/ws` to a public-origin URL unless the path already names the
/// gateway. Keeping any base path as a prefix means a proxied deployment's WS
/// endpoint (`/proxy/ws`) lines up with the HTTP fetch derivation
/// (`/proxy/buffer/fetch`), instead of both halves disagreeing about the root.
fn append_ws_path(url: &mut Url) {
    let path = url.path().trim_end_matches('/');
    if !path.ends_with("/ws") {
        url.set_path(&format!("{path}/ws"));
    }
}

/// Interval at which an *established* session flushes locally-created outbox
/// events to the Relay. The pre-session drain only covers events produced
/// before connect; without this, events created mid-session would sit in the
/// outbox until the next reconnect (#7).
const OUTBOX_FLUSH_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5);

/// Interval at which acknowledged outbox rows are swept (#15). Held well below
/// the flush cadence so the purge never competes with event delivery.
const OUTBOX_SWEEP_INTERVAL: std::time::Duration = std::time::Duration::from_secs(600);

/// Liveness heartbeat cadence (§13). Used by the idle select loop and, during a
/// long snapshot upload, by the snapshot stream itself so the Relay never marks
/// the node offline mid-rebuild.
const HEARTBEAT_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);

/// Cadence at which a connected node re-sends `sync_hello` to pull events that
/// arrived after the session started. The Relay only pushes missing events in
/// response to `sync_hello`, so without this a long-lived healthy connection
/// would never see new device events (deletes/tombstones in particular) and a
/// `purge_tombstone` control would arrive before the node knew the entity was
/// deleted. `sync_hello` is idempotent.
const SYNC_PULL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);

/// Acknowledged outbox rows younger than this are retained: the Relay ack may
/// still be in flight on the same session, and re-sending a just-acked event
/// is safer than silently dropping one the Relay never received.
const OUTBOX_SWEEP_GRACE: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

/// How long one WebSocket connect to the Relay may take (#9). A black-holed
/// relay IP has no kernel-level fast failure; without an explicit budget the
/// sync retry loop in `main.rs` would stall on a single dial instead of cycling
/// back into its 5 s reconnect cadence. Matches the operator-side pairing HTTP
/// budget (`main.rs` uses the same 15 s).
const RELAY_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// Total budget for one Relay buffer fetch: request, response, and body read
/// (`reqwest` `timeout` covers the whole exchange). A shard is at most
/// `MAX_SHARD_BYTES` on this node; 30 s also matches the WebRTC ack budget.
const RELAY_FETCH_TIMEOUT: Duration = Duration::from_secs(30);

/// Budget for one WebSocket send (#9). A TCP socket that has silently wedged
/// (packets blackholed after connect) would otherwise block the sink forever,
/// pinning the whole session read loop and, with it, the reconnect cadence in
/// `main.rs`. 30 s exceeds any legitimate message (max ~1000-record snapshot
/// chunk) while still failing deterministically.
const WS_WRITE_TIMEOUT: Duration = Duration::from_secs(30);

/// Size of each binary frame when streaming a shard to the Relay for a browser
/// download. The Relay forwards each frame to the HTTP response as it arrives,
/// so a multi-MiB shard no longer has to be buffered whole before the browser
/// sees its first byte. 256 KiB stays well under the Relay's WS read limit.
const SHARD_STREAM_CHUNK_BYTES: usize = 256 * 1024;

/// Freshness window for a signed Path B (relay-signaled WebRTC) message. The
/// signature binds the device, session, timestamp, and payload hash; bounding
/// the timestamp stops a captured offer from being replayed later.
const RELAY_SIGNAL_FRESHNESS_MS: i64 = 60_000;

pub struct SyncClient {
    pub relay_url: String,
    pub identity: Arc<NodeIdentity>,
    pub db: SqlitePool,
    pub batch_size: usize,
    pub object_store: Arc<ObjectStore>,
    /// Shared with the local HTTP listener. Path B (relay-signaled internet
    /// WebRTC) creates sessions here from offers that arrive over the Relay WS,
    /// so the same session cap/TTL/telemetry governs both signaling paths.
    pub webrtc_manager: Arc<crate::webrtc::WebRtcManager>,
    pub http_fetch_url: String,
    pub http_client: reqwest::Client,
    /// Fired once per successful session immediately after Relay auth, so the
    /// caller can publish "connected" while the session is *live* (a long
    /// message loop) rather than only when it later returns.
    on_connected: Option<Arc<dyn Fn() + Send + Sync>>,
}

impl SyncClient {
    pub fn new(
        relay_url: String,
        identity: Arc<NodeIdentity>,
        db: SqlitePool,
        object_store: Arc<ObjectStore>,
        webrtc_manager: Arc<crate::webrtc::WebRtcManager>,
        batch_size: usize,
        on_connected: Option<Arc<dyn Fn() + Send + Sync>>,
    ) -> Self {
        Self {
            http_fetch_url: relay_http_fetch_url(&relay_url),
            relay_url,
            identity,
            db,
            object_store,
            webrtc_manager,
            // Bound the buffer fetch (#9): a stalled Relay should fail this
            // shard and let the session continue, not pin the read loop.
            http_client: reqwest::Client::builder()
                .timeout(RELAY_FETCH_TIMEOUT)
                .build()
                .expect("reqwest client build cannot fail"),
            batch_size,
            on_connected,
        }
    }

    /// Sign the challenge nonce using the node's persistent Ed25519 identity key.
    pub fn sign_auth_challenge(
        identity: &NodeIdentity,
        challenge: &NodeAuthChallengePayload,
    ) -> NodeAuthResponsePayload {
        let sig = identity.sign(challenge.nonce.as_bytes());
        let sig_hex = hex::encode(sig.to_bytes());

        NodeAuthResponsePayload {
            node_id: identity.node_id.clone(),
            signature: sig_hex,
        }
    }

    /// Build the SYNC_HELLO payload from local sync_cursors.
    pub async fn build_sync_hello(
        db: &SqlitePool,
        node_id: &str,
    ) -> anyhow::Result<SyncHelloPayload> {
        let rows = sqlx::query(
            r#"
            SELECT peer_id, last_sequence_seen
            FROM sync_cursors
            "#,
        )
        .fetch_all(db)
        .await?;

        let cursors = rows
            .into_iter()
            .map(|r| SyncCursor {
                origin_id: r.get("peer_id"),
                sequence: r.get("last_sequence_seen"),
            })
            .collect();

        Ok(SyncHelloPayload {
            node_id: node_id.to_string(),
            cursors,
        })
    }

    /// Perform a single sync exchange run over WebSocket.
    ///
    /// `repair_rx` carries `node_shard_fetch` requests emitted by the transfer
    /// manager for Path B node→node repairs; the session drains it into the
    /// same WS write half used for every other relay envelope.
    pub async fn run_sync_session(
        &self,
        mut repair_rx: Option<mpsc::UnboundedReceiver<ProtocolEnvelope>>,
    ) -> anyhow::Result<()> {
        // Bound the dial itself (#9): tokio_tungstenite has no connect timeout,
        // and a black-holed relay has no kernel fast-fail, so without this the
        // main loop's reconnect cadence is held hostage by one stuck connect.
        // `connect_async` completes only when the HTTP->WS handshake finishes,
        // so this covers DNS, TCP connect, and the upgrade in one budget.
        let (ws_stream, _) =
            tokio::time::timeout(RELAY_CONNECT_TIMEOUT, connect_async(&self.relay_url))
                .await
                .map_err(|_| {
                    anyhow::anyhow!(
                        "relay websocket connect timed out after {RELAY_CONNECT_TIMEOUT:?}"
                    )
                })?
                .map_err(|e| anyhow::anyhow!("relay websocket connect failed: {e}"))?;
        let (mut write, mut read) = ws_stream.split();

        // 1. Wait for auth challenge
        let mut authenticated = false;
        // A challenge must be answered before an "ok" result is honoured, so a
        // relay frame ordering bug (or a replayed/forged result) cannot
        // authenticate a session that never proved possession of the node key.
        let mut challenged = false;
        while let Some(msg_res) = read.next().await {
            let msg = msg_res?;
            if let Message::Text(text) = msg {
                // One malformed frame must not tear down the whole session; a
                // relay glitch would otherwise force a reconnect storm.
                let env: ProtocolEnvelope = match serde_json::from_str(&text) {
                    Ok(env) => env,
                    Err(e) => {
                        eprintln!("[sync] ignoring malformed relay frame: {e}");
                        continue;
                    }
                };
                if !schema_major_compatible(&env.schema_version) {
                    eprintln!(
                        "[sync] ignoring envelope with incompatible schema_version {}",
                        env.schema_version
                    );
                    continue;
                }
                if env.msg_type == "node_auth_challenge" {
                    let challenge: NodeAuthChallengePayload = serde_json::from_value(env.payload)?;
                    let resp = Self::sign_auth_challenge(&self.identity, &challenge);
                    let resp_env =
                        ProtocolEnvelope::new("node_auth_response", serde_json::to_value(resp)?);
                    Self::send_json(&mut write, &resp_env).await?;
                    challenged = true;
                } else if env.msg_type == "node_auth_result" {
                    let result: NodeAuthResultPayload = serde_json::from_value(env.payload)?;
                    if result.status == "ok" {
                        if !challenged {
                            anyhow::bail!("relay accepted auth without ever issuing a challenge");
                        }
                        authenticated = true;
                        // Seed the local trust table with the account's other
                        // active nodes (relay-delivered on success) so
                        // peer-to-peer repair has a trust anchor. Best-effort:
                        // a store failure must not fail authentication.
                        if let Err(e) =
                            store_trusted_peers(&self.db, &self.identity.node_id, &result.nodes)
                                .await
                        {
                            eprintln!("[sync] failed to store trusted peer nodes: {e}");
                        }
                        // Relay accepted us: this session is live, so let the
                        // sync-loop telemetry stop showing "connecting" now.
                        if let Some(on_connected) = &self.on_connected {
                            on_connected();
                        }
                        break;
                    } else if result.reason.as_deref() == Some("node_not_found") {
                        // Unpaired node: surface a typed marker so the caller can
                        // print pairing guidance instead of a relay-outage line.
                        return Err(anyhow::Error::new(NodeNotPaired));
                    } else if result.reason.as_deref() == Some("node_inactive") {
                        // Registered but disabled/revoked: do not tell the
                        // operator to pair again.
                        return Err(anyhow::Error::new(NodeNotActive));
                    } else {
                        anyhow::bail!("authentication failed: {:?}", result.message);
                    }
                }
            }
        }

        if !authenticated {
            anyhow::bail!("connection closed before auth completed");
        }

        // Path B (node repair) plumbing: envelopes the outbound repair tasks
        // want written to the Relay, and the per-peer signal routing table for
        // their answers/ICE.
        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<ProtocolEnvelope>();
        let outbound_sessions: Arc<
            tokio::sync::Mutex<HashMap<String, mpsc::UnboundedSender<OutboundSignal>>>,
        > = Arc::new(tokio::sync::Mutex::new(HashMap::new()));

        // 2. Send SYNC_HELLO
        self.send_sync_hello(&mut write).await?;

        // 2b. Register with the Relay. The Relay only scans for RELAY_BUFFERED
        // shards after a `register` envelope, so this is what triggers
        // pending_notify delivery for shards uploaded while we were offline.
        let reg = RegisterPayload {
            account_id: None,
            device_id: None,
            node_id: self.identity.node_id.clone(),
            public_key: hex::encode(self.identity.public_key.to_bytes()),
            // Catalog capability names (`message-catalog.md`): a storage node
            // stores shards and runs the sync protocol. The Relay currently
            // ignores these on node register, but advertising a non-catalog
            // value was wrong.
            capabilities: vec!["storage".to_string(), "sync".to_string()],
        };
        let reg_env = ProtocolEnvelope::new("register", serde_json::to_value(&reg)?);
        Self::send_json(&mut write, &reg_env).await?;

        // 3. Drain local outbox
        let unsynced = drain_unsynced_events(&self.db, self.batch_size as i64).await?;
        if !unsynced.is_empty() {
            let batch = EventBatchPayload { events: unsynced };
            let batch_env = ProtocolEnvelope::new("event_batch", serde_json::to_value(batch)?);
            Self::send_json(&mut write, &batch_env).await?;
        }

        // 4. Read loop for incoming batches, SYNC_STATUS, and ACKs
        //
        // The loop is otherwise driven by the Relay pushing messages, but an
        // idle-but-connected node would still age out of the UI's online window:
        // `last_seen_at` is only written on auth or a heartbeat. Beat every 30 s
        // so the Relay's throttled write (once/minute, hub.go) keeps the node
        // "online" regardless of traffic. The 30 s cadence matches the web
        // client and the 2-minute online window (NODE_ONLINE_WINDOW_MS).
        let mut heartbeat = tokio::time::interval(HEARTBEAT_INTERVAL);
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut outbox_flush = tokio::time::interval(OUTBOX_FLUSH_INTERVAL);
        outbox_flush.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut outbox_sweep = tokio::time::interval(OUTBOX_SWEEP_INTERVAL);
        outbox_sweep.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut sync_pull = tokio::time::interval(SYNC_PULL_INTERVAL);
        sync_pull.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        // Consume the immediate first tick; the initial SYNC_HELLO was already
        // sent above, so the first periodic pull is one interval later.
        sync_pull.tick().await;

        // Path B: a WebRTC session produces its local ICE candidates
        // asynchronously *after* the answer is sent, so they cannot ride the
        // answer SDP. A per-session forwarding task pushes them into this
        // channel, and the select loop drains it into `webrtc_ice_candidate`
        // envelopes. Sender and receiver are separate variables on purpose:
        // the offer branch clones only the sender while the ICE branch awaits
        // the receiver, so `select!` has no borrow conflict.
        let (ice_tx, mut ice_rx) = tokio::sync::mpsc::unbounded_channel::<(String, String)>();
        // One forwarder per session id, removed by the task when it ends (its
        // session was pruned) so a later re-offer spawns a fresh one.
        let ice_forwarders: Arc<tokio::sync::Mutex<std::collections::HashSet<String>>> =
            Arc::new(tokio::sync::Mutex::new(std::collections::HashSet::new()));

        loop {
            tokio::select! {
                maybe_msg = read.next() => {
                    let Some(msg_res) = maybe_msg else { break };
                    let msg = msg_res?;
                    if let Message::Text(text) = msg {
                        // Tolerate a single malformed frame rather than ending
                        // the session (and the whole sync cycle) on it.
                        let env: ProtocolEnvelope = match serde_json::from_str(&text) {
                            Ok(env) => env,
                            Err(e) => {
                                eprintln!("[sync] ignoring malformed relay frame: {e}");
                                continue;
                            }
                        };
                        if !schema_major_compatible(&env.schema_version) {
                            eprintln!(
                                "[sync] ignoring envelope with incompatible schema_version {}",
                                env.schema_version
                            );
                            continue;
                        }
                        match env.msg_type.as_str() {
                    "sync_status" => {
                        let status: SyncStatusPayload = serde_json::from_value(env.payload)?;
                        // The Relay reports its per-origin cursor. If it is
                        // *behind* our local cursor, the Relay lost events
                        // (e.g. a DB reset without a rebuild) and the account is
                        // diverging — surface it. Ahead is the normal catch-up
                        // case and the event stream will close the gap.
                        for cursor in &status.cursors {
                            let local: Option<i64> = sqlx::query_scalar(
                                "SELECT last_sequence_seen FROM sync_cursors WHERE peer_id = ?",
                            )
                            .bind(&cursor.origin_id)
                            .fetch_optional(&self.db)
                            .await?;
                            if let Some(local) = local
                                && cursor.sequence < local
                            {
                                eprintln!(
                                    "[sync] relay is behind for origin {} (relay seq {}, local {}); \
                                     possible relay data loss — a rebuild may be required",
                                    cursor.origin_id, cursor.sequence, local
                                );
                            }
                        }
                    }
                    "batch_ack" => {
                        let ack: BatchAckPayload = serde_json::from_value(env.payload)?;
                        mark_events_synced(&self.db, &ack.applied_event_ids).await?;
                    }
                    "event_batch" => {
                        let batch: EventBatchPayload = serde_json::from_value(env.payload)?;
                        let ack =
                            apply_incoming_batch(&self.db, &batch, &self.identity.node_id).await?;
                        let applied_ids = ack.applied_event_ids.clone();
                        let ack_env =
                            ProtocolEnvelope::new("batch_ack", serde_json::to_value(ack)?);
                        Self::send_json(&mut write, &ack_env).await?;

                        // Tombstones whose event actually applied are reported
                        // as deleted (the data itself is retained so restore
                        // works; the ack drives the UI's per-node progress).
                        // A rejected event must not be acked as deleted, or the
                        // Relay would consider the purge confirmed early (#11).
                        for ev in &batch.events {
                            if !applied_ids.iter().any(|id| id == &ev.event_id) {
                                continue;
                            }
                            if let Some((entity_type, entity_id)) = tombstone_entity(ev) {
                                let payload = serde_json::json!({
                                    "entity_type": entity_type,
                                    "entity_id": entity_id,
                                    "status": "deleted",
                                });
                                Self::send_envelope(&mut write, "tombstone_ack", &payload).await?;
                            }
                        }
                    }
                    // Phase 9: Relay asked for a full snapshot/rebuild (§20).
                    "rebuild_required"
                        if is_rebuild_required_for(&env.payload, &self.identity.node_id)
                            .is_some() =>
                    {
                        self.stream_snapshot(&mut write).await?;
                    }
                    // Phase 10: a shard is sitting in the Relay buffer waiting
                    // for us (Path C). Fetch it over HTTP, verify the BLAKE3
                    // digest, store it, and ack the result.
                    "pending_notify" => {
                        let n: PendingNotifyPayload = serde_json::from_value(env.payload)?;
                        self.handle_pending_notify(&mut write, n).await?;
                    }
                    // Phase 11: the Relay issued a pairing token for this node —
                    // persist it so /nodus/pair can redeem locally (fast path),
                    // even if the device scans the QR while the Relay is down.
                    "pairing_token_push" => {
                        let push: PairingTokenPushPayload = serde_json::from_value(env.payload)?;
                        store_pairing_token(&self.db, &push, &self.identity.node_id).await?;
                    }
                    // Relay asked us to permanently remove a tombstoned entity.
                    // Free the data, then ack so the Relay can finalize the
                    // purge once every owning node has reported in.
                    "purge_tombstone" => {
                        let entity_type = env
                            .payload
                            .get("entity_type")
                            .and_then(|v| v.as_str())
                            .unwrap_or("file")
                            .to_string();
                        let entity_id = env
                            .payload
                            .get("entity_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        // Only purge entities we actually hold a tombstone for,
                        // and only the two known types. A compromised relay must
                        // not be able to delete a *live* file's shards by
                        // sending an unmatched purge; the tombstone proves the
                        // account deleted it (and prevents the restore path from
                        // racing this purge).
                        if purge_tombstoned_entity(
                            &self.db,
                            &self.object_store,
                            &entity_type,
                            &entity_id,
                        )
                        .await?
                        {
                            let payload = serde_json::json!({
                                "entity_type": entity_type,
                                "entity_id": entity_id,
                                "status": "purged",
                            });
                            Self::send_envelope(&mut write, "tombstone_ack", &payload).await?;
                        } else {
                            eprintln!(
                                "[sync] ignoring purge_tombstone for {entity_type} \
                                 {entity_id}: no matching local tombstone"
                            );
                        }
                    }
                    // Restore: drop our tombstone so retained data is not purged
                    // at the original retention deadline.
                    "restore_tombstone" => {
                        let entity_type = env
                            .payload
                            .get("entity_type")
                            .and_then(|v| v.as_str())
                            .unwrap_or("file");
                        let entity_id = env
                            .payload
                            .get("entity_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        if !entity_id.is_empty() {
                            sqlx::query(
                                "DELETE FROM tombstones WHERE entity_type = ? AND entity_id = ?",
                            )
                            .bind(entity_type)
                            .bind(entity_id)
                            .execute(&self.db)
                            .await?;
                        }
                    }
                    // Manual reachability probe from the Relay (Devices page
                    // "Ping"): echo the correlation id straight back so the
                    // Relay can measure a real round trip. Runs inline in the
                    // read loop, so it also proves the node's event loop is live.
                    "ping" => {
                        if let Some(id) = env.payload.get("id").and_then(|v| v.as_str()) {
                            let payload = serde_json::json!({ "id": id });
                            Self::send_envelope(&mut write, "pong", &payload).await?;
                        }
                    }
                    // Design A: the Relay needs an object we hold, to serve a
                    // browser download that has no direct host. Read the bytes
                    // off disk and answer with a text result followed by the raw
                    // payload as one binary frame. "missing"/"error" resolve the
                    // Relay's waiter so it can try another holder instead.
                    "shard_fetch_request" => {
                        let req: ShardFetchRequestPayload = serde_json::from_value(env.payload)?;
                        match self
                            .object_store
                            .get(&req.object_id)
                            .await
                        {
                            Ok(bytes) => {
                                Self::send_envelope(
                                    &mut write,
                                    "shard_fetch_result",
                                    &serde_json::to_value(ShardFetchResultPayload {
                                        request_id: req.request_id.clone(),
                                        object_id: req.object_id.clone(),
                                        status: "ok".to_string(),
                                        error: None,
                                    })?,
                                )
                                .await?;
                                // Stream the shard as chunks then a done marker,
                                // so the Relay can forward each frame to the
                                // browser as it arrives rather than buffering the
                                // whole object before the first byte.
                                for chunk in bytes.chunks(SHARD_STREAM_CHUNK_BYTES) {
                                    Self::send_binary(&mut write, chunk.to_vec()).await?;
                                }
                                Self::send_envelope(
                                    &mut write,
                                    "shard_fetch_done",
                                    &serde_json::json!({ "request_id": req.request_id }),
                                )
                                .await?;
                            }
                            Err(_) => {
                                Self::send_envelope(
                                    &mut write,
                                    "shard_fetch_result",
                                    &serde_json::to_value(ShardFetchResultPayload {
                                        request_id: req.request_id.clone(),
                                        object_id: req.object_id.clone(),
                                        status: "missing".to_string(),
                                        error: Some("object not found in store".to_string()),
                                    })?,
                                )
                                .await?;
                            }
                        }
                    }
                    // Path B (node repair): a peer we trust needs an object we
                    // hold. Start an outbound WebRTC transfer that offers the
                    // peer a direct data channel and streams the shard.
                    "node_shard_fetch" => {
                        let req: NodeShardFetchPayload = serde_json::from_value(env.payload.clone())?;
                        if req.to_peer == self.identity.node_id
                            && self.is_trusted_peer(&req.from_peer).await
                        {
                            self.spawn_outbound_repair(
                                req.from_peer.clone(),
                                req.object_id.clone(),
                                out_tx.clone(),
                                Arc::clone(&outbound_sessions),
                            )
                            .await;
                        }
                    }
                    // Path B: a device (browser) that cannot reach us on the LAN
                    // is opening a WebRTC data channel over the Relay. Gate on a
                    // paired/ACTIVE device of this account, create or reuse the
                    // session, and send the answer back over the same WS.
                    "webrtc_offer" => {
                        self.handle_relay_offer(&mut write, &env, &ice_tx, &ice_forwarders)
                            .await?;
                    }
                    // Path B (node repair): the peer answered our outbound
                    // offer; route it to the waiting repair task.
                    "webrtc_answer" => {
                        self.route_outbound_signal(&env, &outbound_sessions, true)
                            .await;
                    }
                    // Path B trickle: route to an outbound (initiator) repair
                    // task if one is waiting on this peer, otherwise treat it as
                    // an inbound (answerer) candidate. Unknown
                    // sessions/candidates are ignored (a late candidate after
                    // the session was pruned is not fatal).
                    "webrtc_ice_candidate" => {
                        let routed = self
                            .route_outbound_signal(&env, &outbound_sessions, false)
                            .await;
                        if !routed {
                            self.handle_relay_ice_candidate(&env).await?;
                        }
                    }
                    _ => {}
                }
            }
                }
                Some((device_id, candidate)) = ice_rx.recv() => {
                    // Forward one node-side ICE candidate to its device.
                    let payload = serde_json::json!({
                        "from_peer": self.identity.node_id,
                        "to_peer": device_id,
                        "candidate": candidate,
                    });
                    Self::send_envelope(&mut write, "webrtc_ice_candidate", &payload).await?;
                }
                // Path B: a repair request from the transfer manager, written to
                // the Relay so the holder node can offer us a direct transfer.
                Some(env) = async {
                    match repair_rx.as_mut() {
                        Some(rx) => rx.recv().await,
                        None => std::future::pending().await,
                    }
                } => {
                    Self::send_json(&mut write, &env).await?;
                }
                // Path B: an outbound repair task's offer/local-ICE envelope.
                Some(env) = out_rx.recv() => {
                    Self::send_json(&mut write, &env).await?;
                }
                _ = heartbeat.tick() => {
                    // Liveness ping (§13): the Relay keys the node's
                    // online/offline state off this envelope, and it writes
                    // `last_seen_at` at most once per minute. Payload matches
                    // the protocol's HeartbeatPayloadSchema (id + RFC3339 ts,
                    // plus this node's disk figures).
                    Self::send_heartbeat(
                        &mut write,
                        &self.identity.node_id,
                        self.heartbeat_storage(),
                    )
                    .await?;
                }
                _ = sync_pull.tick() => {
                    // Re-send SYNC_HELLO so the Relay re-delivers any events
                    // that arrived after this session began (and any pending
                    // purge controls the node missed while offline). Without
                    // this a healthy long-lived session would stay stale.
                    self.send_sync_hello(&mut write).await?;
                }
                _ = outbox_flush.tick() => {
                    // Local events created after the pre-session drain are
                    // flushed here, so a long-lived session keeps delivering
                    // instead of waiting for the next reconnect (#7).
                    let unsynced = drain_unsynced_events(&self.db, self.batch_size as i64).await?;
                    if !unsynced.is_empty() {
                        let batch = EventBatchPayload { events: unsynced };
                        let batch_env =
                            ProtocolEnvelope::new("event_batch", serde_json::to_value(batch)?);
                        Self::send_json(&mut write, &batch_env).await?;
                    }
                }
                _ = outbox_sweep.tick() => {
                    // Rate-limited purge of acknowledged outbox rows; the grace
                    // window covers acks still in flight on this session (#15).
                    let grace = (chrono::Utc::now()
                        - chrono::Duration::seconds(OUTBOX_SWEEP_GRACE.as_secs() as i64))
                        .to_rfc3339();
                    sweep_synced_outbox(&self.db, &grace).await?;
                }
            }
        }

        Ok(())
    }

    /// Verify a device-signed Path B signaling message: the sender must be a
    /// paired, ACTIVE device, the timestamp must be fresh, and the Ed25519
    /// signature must cover
    /// `"{device}:relay-{device}:{timestamp}:{blake3(payload)}"`. This is the
    /// relay-path counterpart to the LAN handler's per-message device proof.
    async fn verify_relay_signaling(
        &self,
        from_peer: &str,
        env: &ProtocolEnvelope,
        payload: &str,
    ) -> anyhow::Result<()> {
        let timestamp = env
            .payload
            .get("timestamp")
            .and_then(|v| v.as_i64())
            .ok_or_else(|| anyhow::anyhow!("missing timestamp"))?;
        let signature = env
            .payload
            .get("signature")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("missing signature"))?;

        // The signer may be a paired device (browser/mobile Path B) or a trusted
        // peer storage node (node↔node repair Path B). Look in both tables.
        let public_key: Vec<u8> = match sqlx::query_scalar(
            "SELECT public_key_bytes FROM devices WHERE device_id = ? AND status = 'ACTIVE'",
        )
        .bind(from_peer)
        .fetch_optional(&self.db)
        .await?
        {
            Some(key) => key,
            None => {
                sqlx::query_scalar("SELECT public_key_bytes FROM trusted_nodes WHERE node_id = ?")
                    .bind(from_peer)
                    .fetch_optional(&self.db)
                    .await?
                    .ok_or_else(|| anyhow::anyhow!("peer is not a paired device or trusted node"))?
            }
        };

        let now_ms = chrono::Utc::now().timestamp_millis();
        if (now_ms - timestamp).abs() > RELAY_SIGNAL_FRESHNESS_MS {
            return Err(anyhow::anyhow!("stale signaling timestamp"));
        }

        let digest = blake3::hash(payload.as_bytes()).to_hex().to_string();
        let message = format!("{from_peer}:relay-{from_peer}:{timestamp}:{digest}");
        crate::local::auth::verify_signature(&public_key, message.as_bytes(), signature)
    }

    /// Path B: handle an inbound `webrtc_offer` from a paired device and reply
    /// with `webrtc_answer` over the Relay WS.
    async fn handle_relay_offer<W>(
        &self,
        write: &mut W,
        env: &ProtocolEnvelope,
        ice_tx: &tokio::sync::mpsc::UnboundedSender<(String, String)>,
        forwarders: &Arc<tokio::sync::Mutex<std::collections::HashSet<String>>>,
    ) -> anyhow::Result<()>
    where
        W: futures_util::Sink<Message> + Unpin,
        W::Error: std::error::Error + Send + Sync + 'static,
    {
        let from_peer = env
            .payload
            .get("from_peer")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let to_peer = env
            .payload
            .get("to_peer")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let sdp = env
            .payload
            .get("sdp")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        // The relay routes to us, but a misbehaving relay could address another
        // node; never act on an offer not addressed to this node.
        if to_peer != self.identity.node_id || from_peer.is_empty() || sdp.is_empty() {
            return Ok(());
        }

        // Verify the device's signature before creating a session. The Relay
        // forwards signaling blindly, so without this a compromised Relay could
        // open sessions as any paired device. Message shape matches the LAN
        // path: "{device}:{session}:{timestamp}:{blake3(payload)}".
        if let Err(e) = self.verify_relay_signaling(from_peer, env, sdp).await {
            eprintln!("[sync] rejecting webrtc_offer from {from_peer}: {e}");
            return Ok(());
        }

        // The WS payload carries no session id, so key one relay session per
        // device; the same device re-offering reuses it.
        let session_id = format!("relay-{from_peer}");
        let session = match self
            .webrtc_manager
            .get_or_create_session(&session_id, from_peer)
            .await
        {
            Ok(session) => session,
            Err(e) => {
                eprintln!("[sync] failed to create WebRTC session for {from_peer}: {e}");
                return Ok(());
            }
        };
        session.touch();

        let answer = match session.handle_offer(sdp).await {
            Ok(answer) => answer,
            Err(e) => {
                eprintln!("[sync] failed to handle WebRTC offer from {from_peer}: {e}");
                return Ok(());
            }
        };

        // Start forwarding this session's ICE candidates once. The task ends
        // when the session is dropped (broadcast closes); removing the id then
        // lets a later re-offer start a fresh forwarder.
        {
            let mut set = forwarders.lock().await;
            if set.insert(session_id.clone()) {
                let mut ice_rx = session.subscribe_ice();
                let tx = ice_tx.clone();
                let device = from_peer.to_string();
                let forwarders = Arc::clone(forwarders);
                let session_id = session_id.clone();
                tokio::spawn(async move {
                    while let Ok(candidate) = ice_rx.recv().await {
                        if tx.send((device.clone(), candidate)).is_err() {
                            break;
                        }
                    }
                    forwarders.lock().await.remove(&session_id);
                });
            }
        }

        let payload = serde_json::json!({
            "from_peer": self.identity.node_id,
            "to_peer": from_peer,
            "sdp": answer,
        });
        Self::send_envelope(write, "webrtc_answer", &payload).await
    }

    /// Path B: add an inbound ICE candidate to the device's live session.
    async fn handle_relay_ice_candidate(&self, env: &ProtocolEnvelope) -> anyhow::Result<()> {
        let from_peer = env
            .payload
            .get("from_peer")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let to_peer = env
            .payload
            .get("to_peer")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let candidate = env
            .payload
            .get("candidate")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if to_peer != self.identity.node_id || from_peer.is_empty() || candidate.is_empty() {
            return Ok(());
        }
        if let Err(e) = self.verify_relay_signaling(from_peer, env, candidate).await {
            eprintln!("[sync] rejecting webrtc_ice_candidate from {from_peer}: {e}");
            return Ok(());
        }
        let session_id = format!("relay-{from_peer}");
        if let Some(session) = self.webrtc_manager.get_session(&session_id).await {
            if session.device_id != from_peer {
                return Ok(());
            }
            session.touch();
            if let Err(e) = session.add_ice_candidate(candidate).await {
                eprintln!("[sync] failed to add ICE candidate from {from_peer}: {e}");
            }
        }
        Ok(())
    }

    /// True when `node_id` is a peer storage node this account trusts (seeded
    /// from the auth handshake). Path B only serves objects to trusted peers.
    async fn is_trusted_peer(&self, node_id: &str) -> bool {
        sqlx::query_scalar::<_, String>("SELECT node_id FROM trusted_nodes WHERE node_id = ?")
            .bind(node_id)
            .fetch_optional(&self.db)
            .await
            .ok()
            .flatten()
            .is_some()
    }

    /// Offload an outbound Path B repair to a task so the read loop keeps
    /// processing the signaling the task depends on. The peer's answer/ICE are
    /// routed to the task via the registry channel installed here.
    async fn spawn_outbound_repair(
        &self,
        to_peer: String,
        object_id: String,
        out_tx: mpsc::UnboundedSender<ProtocolEnvelope>,
        registry: Arc<tokio::sync::Mutex<HashMap<String, mpsc::UnboundedSender<OutboundSignal>>>>,
    ) {
        // The holder only knows the object hash; map it back to its
        // (file, version, shard) so the receiver's manifest check passes.
        let row: Option<(String, i64, i64)> = sqlx::query_as(
            "SELECT file_id, version_number, shard_index FROM shards WHERE object_id = ? LIMIT 1",
        )
        .bind(&object_id)
        .fetch_optional(&self.db)
        .await
        .ok()
        .flatten();
        let Some((file_id, version_number, shard_index)) = row else {
            eprintln!("[sync] peer requested unknown object {object_id}; ignoring");
            return;
        };

        let (signal_tx, signal_rx) = mpsc::unbounded_channel::<OutboundSignal>();
        registry.lock().await.insert(to_peer.clone(), signal_tx);

        let identity = Arc::clone(&self.identity);
        let store = self.object_store.clone();
        let registry_for_task = Arc::clone(&registry);
        let to = to_peer.clone();
        tokio::spawn(async move {
            let result = outbound_repair_task(
                identity,
                store,
                to.clone(),
                object_id,
                file_id,
                version_number,
                shard_index,
                out_tx,
                signal_rx,
            )
            .await;
            if let Err(e) = result {
                eprintln!("[sync] Path B repair to {to} failed: {e:#}");
            }
            registry_for_task.lock().await.remove(&to);
        });
    }

    /// Route an inbound answer/ICE envelope to the outbound repair task that
    /// invited `from_peer`. Returns false when no task is waiting (the caller
    /// then treats the message as an inbound-session candidate).
    async fn route_outbound_signal(
        &self,
        env: &ProtocolEnvelope,
        registry: &Arc<tokio::sync::Mutex<HashMap<String, mpsc::UnboundedSender<OutboundSignal>>>>,
        is_answer: bool,
    ) -> bool {
        let from = env
            .payload
            .get("from_peer")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if from.is_empty() {
            return false;
        }
        let signal = if is_answer {
            env.payload
                .get("sdp")
                .and_then(|v| v.as_str())
                .map(|s| OutboundSignal::Answer(s.to_string()))
        } else {
            env.payload
                .get("candidate")
                .and_then(|v| v.as_str())
                .map(|s| OutboundSignal::Ice(s.to_string()))
        };
        let Some(signal) = signal else {
            return false;
        };
        let map = registry.lock().await;
        match map.get(from) {
            Some(tx) => tx.send(signal).is_ok(),
            None => false,
        }
    }

    /// Serialize and send a protocol envelope under a finite deadline (#9).
    /// The conn-bounded write below is the one true choke point every outbound
    /// message flows through, so a wedged socket fails the session instead of
    /// hanging it.
    async fn send_json<W>(write: &mut W, env: &ProtocolEnvelope) -> anyhow::Result<()>
    where
        W: futures_util::Sink<Message> + Unpin,
        W::Error: std::error::Error + Send + Sync + 'static,
    {
        let msg = Message::Text(serde_json::to_string(env)?.into());
        tokio::time::timeout(WS_WRITE_TIMEOUT, write.send(msg))
            .await
            .map_err(|_| anyhow::anyhow!("websocket send timed out after {WS_WRITE_TIMEOUT:?}"))?
            .map_err(|e| anyhow::anyhow!("websocket send failed: {e}"))
    }

    /// Send a typed protocol envelope over the WebSocket writer.
    async fn send_envelope<W>(
        write: &mut W,
        msg_type: &str,
        payload: &serde_json::Value,
    ) -> anyhow::Result<()>
    where
        W: futures_util::Sink<Message> + Unpin,
        W::Error: std::error::Error + Send + Sync + 'static,
    {
        let env = ProtocolEnvelope::new(msg_type, payload.clone());
        Self::send_json(write, &env).await
    }

    /// Send a raw binary frame over the WebSocket writer under the same finite
    /// deadline as the text path (Design A: a shard's bytes answer a
    /// shard_fetch_request). `Message::Binary` is the one place outbound bytes
    /// ever travel outside a text envelope.
    async fn send_binary<W>(write: &mut W, bytes: Vec<u8>) -> anyhow::Result<()>
    where
        W: futures_util::Sink<Message> + Unpin,
        W::Error: std::error::Error + Send + Sync + 'static,
    {
        let msg = Message::Binary(bytes.into());
        tokio::time::timeout(WS_WRITE_TIMEOUT, write.send(msg))
            .await
            .map_err(|_| anyhow::anyhow!("websocket send timed out after {WS_WRITE_TIMEOUT:?}"))?
            .map_err(|e| anyhow::anyhow!("websocket send failed: {e}"))
    }

    /// This node's disk figures for the heartbeat as `(used, total)`, or `None`
    /// when the volume cannot be queried (see `report::disk_usage`). The Relay
    /// stamps these onto the node row so the Overview can show "used of total"
    /// without a direct browser→node connection.
    fn heartbeat_storage(&self) -> Option<(i64, i64)> {
        let (used, total) = crate::report::disk_usage(self.object_store.data_dir());
        (total > 0).then_some((used, total))
    }

    /// Send one liveness heartbeat (§13). Shared by the idle select loop and the
    /// snapshot stream, which can occupy the writer for a long rebuild.
    /// `storage` is present only for storage nodes and lets the Relay update the
    /// node's capacity columns alongside `last_seen_at`.
    async fn send_heartbeat<W>(
        write: &mut W,
        node_id: &str,
        storage: Option<(i64, i64)>,
    ) -> anyhow::Result<()>
    where
        W: futures_util::Sink<Message> + Unpin,
        W::Error: std::error::Error + Send + Sync + 'static,
    {
        let mut payload = serde_json::json!({
            "id": node_id,
            "timestamp": chrono::Utc::now().to_rfc3339(),
        });
        if let Some((used_bytes, total_bytes)) = storage {
            payload["storage"] = serde_json::json!({
                "used_bytes": used_bytes,
                "total_bytes": total_bytes,
            });
        }
        Self::send_envelope(write, "heartbeat", &payload).await
    }

    /// Send a `sync_hello` carrying this node's cursors so the Relay re-delivers
    /// any events the node has not applied. Sent at session start and
    /// periodically by the read loop; idempotent.
    async fn send_sync_hello<W>(&self, write: &mut W) -> anyhow::Result<()>
    where
        W: futures_util::Sink<Message> + Unpin,
        W::Error: std::error::Error + Send + Sync + 'static,
    {
        let hello = Self::build_sync_hello(&self.db, &self.identity.node_id).await?;
        let hello_env = ProtocolEnvelope::new("sync_hello", serde_json::to_value(hello)?);
        Self::send_json(write, &hello_env).await
    }

    /// Phase 10: consume a pending_notify — fetch the shard bytes from the
    /// Relay buffer, verify + store them, then ack "verified" or "failed".
    async fn handle_pending_notify<W>(
        &self,
        write: &mut W,
        n: PendingNotifyPayload,
    ) -> anyhow::Result<()>
    where
        W: futures_util::Sink<Message> + Unpin,
        W::Error: std::error::Error + Send + Sync + 'static,
    {
        let transfer_id = uuid::Uuid::new_v4().to_string();

        let ack = match self.fetch_verify_store(&n).await {
            Ok(_) => ShardAckPayload {
                file_id: n.file_id.clone(),
                version_number: n.version_number,
                shard_index: n.shard_index,
                status: "verified".to_string(),
                transfer_id: transfer_id.clone(),
                error_message: None,
            },
            Err(e) => {
                eprintln!(
                    "[sync] pending_notify failed for {}:{}:{}: {e}",
                    n.file_id, n.version_number, n.shard_index
                );
                ShardAckPayload {
                    file_id: n.file_id.clone(),
                    version_number: n.version_number,
                    shard_index: n.shard_index,
                    status: "failed".to_string(),
                    transfer_id: transfer_id.clone(),
                    error_message: Some(e.to_string()),
                }
            }
        };

        Self::send_envelope(write, "shard_ack", &serde_json::to_value(ack)?).await
    }

    /// Fetch a shard from the Relay buffer, verify its integrity digest and
    /// declared size, persist it content-addressed, and record the shard
    /// metadata (falling back to the pending landing zone when the
    /// file_versions row hasn't synced yet).
    async fn fetch_verify_store(&self, n: &PendingNotifyPayload) -> anyhow::Result<()> {
        // Reject an implausible declared size before any network I/O: a relay
        // (or MITM) must not be able to make us allocate arbitrarily. `size` is
        // i64 on the wire, so a negative value is also invalid.
        if n.size <= 0 || n.size as usize > crate::limits::MAX_SHARD_BYTES {
            anyhow::bail!(
                "relay declared shard size {} outside (0, {}]",
                n.size,
                crate::limits::MAX_SHARD_BYTES
            );
        }
        let resp = self
            .http_client
            .get(&self.http_fetch_url)
            // Pass the token as a properly-encoded query pair rather than
            // interpolating it into the URL (a `&`/`#` in the token would
            // otherwise alter the request).
            .query(&[("token", n.fetch_token.as_str())])
            .send()
            .await
            // `without_url` keeps the single-use fetch token out of the error
            // message, which is logged and echoed back to the Relay.
            .map_err(|e| anyhow::Error::new(e.without_url()))?;
        if !resp.status().is_success() {
            anyhow::bail!("relay /buffer/fetch returned {}", resp.status());
        }
        // Stream with a hard cap: a compromised relay could otherwise send an
        // unbounded (chunked) body and OOM the node before the hash check runs.
        let bytes = crate::limits::read_body_capped(resp, crate::limits::MAX_SHARD_BYTES).await?;

        // The Relay already verified this digest on upload, but the node never
        // trusts the wire, so recompute before persisting anything.
        let got = blake3::hash(&bytes).to_hex().to_string();
        if got != n.hash {
            anyhow::bail!("hash mismatch: expected {}, got {}", n.hash, got);
        }
        if bytes.len() as i64 != n.size {
            anyhow::bail!("size mismatch: expected {}, got {}", n.size, bytes.len());
        }

        // Content-addressed put returns the BLAKE3 hex of the bytes it stored;
        // it must equal the digest we verified.
        let object_id = self.object_store.put(&bytes).await?;
        if object_id != got {
            anyhow::bail!("object store addressed bytes as {object_id}, expected {got}");
        }

        self.record_shard_metadata(n, &object_id, bytes.len() as i64)
            .await
    }

    /// Record shard metadata into `shards` when the file_versions row exists,
    /// otherwise into `pending_shard_fetches` for a later drain (the version
    /// event may trail the shard on the wire).
    async fn record_shard_metadata(
        &self,
        n: &PendingNotifyPayload,
        object_id: &str,
        size: i64,
    ) -> anyhow::Result<()> {
        // A signed per-shard manifest, when present, is authoritative: refuse
        // bytes that do not match it rather than content-addressing whatever the
        // Relay supplied.
        let expected: Option<String> = sqlx::query_scalar(
            "SELECT shard_hash FROM file_version_shard_hashes \
             WHERE file_id = ? AND version_number = ? AND shard_index = ?",
        )
        .bind(&n.file_id)
        .bind(n.version_number)
        .bind(n.shard_index)
        .fetch_optional(&self.db)
        .await?;
        if let Some(expected) = expected
            && expected != object_id
        {
            anyhow::bail!(
                "relay shard for {}:{}:{} does not match the signed manifest \
                 (expected {expected}, got {object_id})",
                n.file_id,
                n.version_number,
                n.shard_index
            );
        }

        // The Relay is not trusted for shard identity: if this (file, version,
        // shard) slot is already filled, the bytes must be identical. A
        // differing relay-supplied object is rejected and surfaced (rather than
        // silently ignored and still acked "verified"), so an operator sees the
        // relay anomaly. Full protection for the *first* copy needs a signed
        // per-shard manifest on FILE_VERSION_ADDED (see fix.md #22).
        //
        // An identical re-delivery falls through so the idempotent inserts and
        // the pending→shards drain still run (the version row may have arrived
        // since the original fetch).
        if let Some(existing) =
            existing_shard_object(&self.db, &n.file_id, n.version_number, n.shard_index).await?
            && existing != object_id
        {
            anyhow::bail!(
                "relay shard conflict for {}:{}:{}: already stored object {existing}, \
                 relay supplied {object_id}; refusing to overwrite",
                n.file_id,
                n.version_number,
                n.shard_index
            );
        }

        let has_version: Option<i64> = sqlx::query_scalar(
            "SELECT 1 FROM file_versions WHERE file_id = ? AND version_number = ?",
        )
        .bind(&n.file_id)
        .bind(n.version_number)
        .fetch_optional(&self.db)
        .await?;

        if has_version.is_some() {
            sqlx::query(
                r#"
                INSERT INTO shards (file_id, version_number, shard_index, object_id, size_bytes)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(file_id, version_number, shard_index) DO NOTHING
                "#,
            )
            .bind(&n.file_id)
            .bind(n.version_number)
            .bind(n.shard_index)
            .bind(object_id)
            .bind(size)
            .execute(&self.db)
            .await?;
        } else {
            sqlx::query(
                r#"
                INSERT INTO pending_shard_fetches
                    (file_id, version_number, shard_index, object_id, size_bytes, fetched_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(file_id, version_number, shard_index) DO NOTHING
                "#,
            )
            .bind(&n.file_id)
            .bind(n.version_number)
            .bind(n.shard_index)
            .bind(object_id)
            .bind(size)
            .bind(chrono::Utc::now().to_rfc3339())
            .execute(&self.db)
            .await?;

            // The version row may have synced between the exists-check above
            // and this insert (delivery and event ingestion interleave on the
            // same session loop). Re-check before draining: drain's
            // INSERT...SELECT demands the FK target, so calling it while the
            // version is still absent would fail the whole fetch.
            let version_now: Option<i64> = sqlx::query_scalar(
                "SELECT 1 FROM file_versions WHERE file_id = ? AND version_number = ?",
            )
            .bind(&n.file_id)
            .bind(n.version_number)
            .fetch_optional(&self.db)
            .await?;
            if version_now.is_some() {
                drain_pending_fetches(&self.db, &n.file_id, n.version_number).await?;
            }
        }
        Ok(())
    }

    /// Streams a full snapshot to the Relay in response to REBUILD_REQUIRED:
    /// SNAPSHOT_BEGIN, then each homogeneous chunk (up to 1000 records), then
    /// SNAPSHOT_END with the final content hash.
    ///
    /// Two passes over one SQLite read transaction: the first computes the
    /// content hash and chunk count (needed in BEGIN), the second transmits the
    /// identical chunks. Holding the transaction makes the two passes observe
    /// the same rows — a concurrent write between them would otherwise make the
    /// Relay's reassembly hash check fail — while bounding memory to one chunk
    /// instead of materializing the whole snapshot. A heartbeat is sent between
    /// chunks so a long rebuild cannot make the Relay mark the node offline.
    async fn stream_snapshot<W>(&self, write: &mut W) -> anyhow::Result<()>
    where
        W: futures_util::Sink<Message> + Unpin + Send,
        W::Error: std::error::Error + Send + Sync + 'static,
    {
        // Sink for the hashing pass: folds each chunk into the running hash.
        struct HashSink<'a> {
            hasher: &'a mut blake3::Hasher,
            count: &'a mut i64,
        }

        #[async_trait::async_trait]
        impl super::snapshot::SnapshotSink for HashSink<'_> {
            async fn chunk(&mut self, chunk: SnapshotChunkPayload) -> anyhow::Result<()> {
                super::snapshot::hash_chunk(self.hasher, &chunk)?;
                *self.count += 1;
                Ok(())
            }
        }

        // Sink for the transmit pass: sends each chunk and paces heartbeats.
        struct SendSink<'a, W> {
            write: &'a mut W,
            node_id: &'a str,
            last_ping: std::time::Instant,
            /// Disk figures captured once for the interim heartbeats; a rebuild
            /// is short enough that re-stating per chunk would be wasteful.
            storage: Option<(i64, i64)>,
        }

        #[async_trait::async_trait]
        impl<W> super::snapshot::SnapshotSink for SendSink<'_, W>
        where
            W: futures_util::Sink<Message> + Unpin + Send,
            W::Error: std::error::Error + Send + Sync + 'static,
        {
            async fn chunk(&mut self, chunk: SnapshotChunkPayload) -> anyhow::Result<()> {
                let env = ProtocolEnvelope::new("snapshot_chunk", serde_json::to_value(chunk)?);
                SyncClient::send_json(&mut *self.write, &env).await?;
                if self.last_ping.elapsed() >= HEARTBEAT_INTERVAL {
                    SyncClient::send_heartbeat(&mut *self.write, self.node_id, self.storage)
                        .await?;
                    self.last_ping = std::time::Instant::now();
                }
                Ok(())
            }
        }

        let snapshot_id = uuid::Uuid::new_v4().to_string();
        let snapshot_sequence = super::snapshot::bump_snapshot_counter(&self.db).await?;

        let mut conn = self.db.acquire().await?;
        let mut tx = conn.begin().await?;

        // Pass 1: content hash + chunk count over a stable read snapshot.
        let mut hasher = blake3::Hasher::new();
        let mut total_chunks: i64 = 0;
        {
            let mut sink = HashSink {
                hasher: &mut hasher,
                count: &mut total_chunks,
            };
            super::snapshot::emit_chunks(&mut tx, &snapshot_id, &mut sink).await?;
        }
        let content_hash = hasher.finalize().to_hex().to_string();
        let cursors = super::snapshot::load_cursors_conn(&mut tx).await?;

        let signature = self.identity.sign(content_hash.as_bytes());
        let signature_hex = hex::encode(signature.to_bytes());
        let begin = SnapshotBeginPayload {
            snapshot_id: snapshot_id.clone(),
            node_id: self.identity.node_id.clone(),
            snapshot_sequence,
            total_chunks,
            content_hash: content_hash.clone(),
            signature: signature_hex.clone(),
            data_schema_version: super::snapshot::SNAPSHOT_DATA_SCHEMA_VERSION.to_string(),
            cursors,
        };
        let begin_env = ProtocolEnvelope::new("snapshot_begin", serde_json::to_value(begin)?);
        Self::send_json(write, &begin_env).await?;

        // Pass 2: transmit the same chunks (the read transaction pins the rows).
        {
            let mut sink = SendSink {
                write,
                node_id: &self.identity.node_id,
                last_ping: std::time::Instant::now(),
                storage: self.heartbeat_storage(),
            };
            super::snapshot::emit_chunks(&mut tx, &snapshot_id, &mut sink).await?;
        }

        let end = SnapshotEndPayload {
            snapshot_id,
            final_hash: content_hash,
            signature: signature_hex,
        };
        let end_env = ProtocolEnvelope::new("snapshot_end", serde_json::to_value(end)?);
        Self::send_json(write, &end_env).await?;

        tx.commit().await?;
        Ok(())
    }
}

/// Persist a Relay-pushed pairing token so `/nodus/pair` can redeem it locally.
///
/// Drops pushes aimed at a *different* node id, and rejects keys that fail to
/// decode as base64 (a malformed push is a programming error upstream, not a
/// reason to fail the whole sync session). Upserting on the token keeps the
/// row's expiry fresh if the Relay ever re-pushes a token.
async fn store_pairing_token(
    db: &SqlitePool,
    push: &PairingTokenPushPayload,
    local_node_id: &str,
) -> anyhow::Result<()> {
    use base64::Engine;

    // The Relay may push tokens for several nodes over the account's sockets;
    // drop any aimed at a different node id so this node never stores (or
    // accidentally redeems) another node's token. `local/server.rs` re-checks
    // at redemption, but not writing it at all is the stronger guarantee.
    if push.node_id != local_node_id {
        return Ok(());
    }

    let device_pubkey =
        match base64::engine::general_purpose::STANDARD.decode(&push.device_public_key) {
            Ok(bytes) if bytes.len() == 32 => bytes,
            _ => return Ok(()),
        };

    sqlx::query(
        "INSERT INTO pairing_sessions (token, device_public_key, node_id, issued_at, expires_at, account_id)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(token) DO UPDATE SET
             expires_at = excluded.expires_at,
             account_id = excluded.account_id",
    )
    .bind(&push.token)
    .bind(&device_pubkey)
    .bind(&push.node_id)
    .bind(chrono::Utc::now().to_rfc3339())
    .bind(&push.expires_at)
    .bind(&push.account_id)
    .execute(db)
    .await?;

    Ok(())
}

/// The object id already recorded for a shard slot, checking both the live
/// `shards` table and the `pending_shard_fetches` landing zone. Used to refuse
/// a relay-supplied shard that conflicts with one we already hold.
async fn existing_shard_object(
    db: &SqlitePool,
    file_id: &str,
    version_number: i64,
    shard_index: i64,
) -> anyhow::Result<Option<String>> {
    let existing: Option<String> = sqlx::query_scalar(
        "SELECT object_id FROM shards WHERE file_id = ? AND version_number = ? AND shard_index = ? \
         UNION \
         SELECT object_id FROM pending_shard_fetches WHERE file_id = ? AND version_number = ? AND shard_index = ? \
         LIMIT 1",
    )
    .bind(file_id)
    .bind(version_number)
    .bind(shard_index)
    .bind(file_id)
    .bind(version_number)
    .bind(shard_index)
    .fetch_optional(db)
    .await?;
    Ok(existing)
}

/// Purge a tombstoned entity's local data. Returns `false` without touching
/// anything when the id is empty, the type is unknown, or no matching
/// tombstone exists — so a compromised relay cannot use `purge_tombstone` to
/// delete a live file's shards. On `true`, the caller acks the Relay.
pub(crate) async fn purge_tombstoned_entity(
    db: &sqlx::SqlitePool,
    store: &crate::store::ObjectStore,
    entity_type: &str,
    entity_id: &str,
) -> anyhow::Result<bool> {
    if entity_id.is_empty() || !matches!(entity_type, "file" | "folder") {
        return Ok(false);
    }
    let has: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM tombstones WHERE entity_type = ? AND entity_id = ?",
    )
    .bind(entity_type)
    .bind(entity_id)
    .fetch_one(db)
    .await?;
    if has == 0 {
        return Ok(false);
    }
    if entity_type == "file" {
        crate::store::gc::purge_file(store, entity_id).await?;
    } else {
        crate::store::gc::purge_folder(store, entity_id).await?;
    }
    Ok(true)
}

/// True when an inbound envelope's `schema_version` shares this node's major
/// version (currently `1`). The wire strings are `"1.0.0"` for both the relay
/// and the node, independent of the package protocol version; a different major
/// means a surface we must not try to parse. An unparseable version is treated
/// as incompatible (fail closed).
fn schema_major_compatible(version: &str) -> bool {
    version
        .split('.')
        .next()
        .and_then(|major| major.parse::<u32>().ok())
        == Some(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A session manager for tests that construct a `SyncClient` but never open
    /// a WebRTC session.
    fn test_webrtc_manager(
        pool: &SqlitePool,
        store: Arc<ObjectStore>,
        identity: Arc<NodeIdentity>,
    ) -> Arc<crate::webrtc::WebRtcManager> {
        Arc::new(crate::webrtc::WebRtcManager::new(
            pool.clone(),
            store,
            identity,
            crate::telemetry::Telemetry::new(),
        ))
    }

    #[tokio::test]
    async fn relay_signaling_verifies_device_signature() {
        use ed25519_dalek::{Signer, SigningKey};

        let dir = tempdir().unwrap();
        let pool = db::open(dir.path()).await.unwrap();
        let store = Arc::new(
            ObjectStore::new(dir.path().join("objects"), pool.clone())
                .await
                .unwrap(),
        );
        let identity = Arc::new(identity::load_or_generate(dir.path()).unwrap());
        let client = SyncClient::new(
            "ws://127.0.0.1:8080/ws".to_string(),
            identity.clone(),
            pool.clone(),
            store.clone(),
            test_webrtc_manager(&pool, store, identity.clone()),
            100,
            None,
        );

        let signing = SigningKey::from_bytes(&[7u8; 32]);
        let public = signing.verifying_key().to_bytes();
        sqlx::query(
            "INSERT INTO devices (device_id, public_key_bytes, status, created_at) \
             VALUES ('dev-relay', ?, 'ACTIVE', 'now')",
        )
        .bind(public.to_vec())
        .execute(&pool)
        .await
        .unwrap();

        let sdp = "v=0-offer";
        let timestamp = chrono::Utc::now().timestamp_millis();
        let digest = blake3::hash(sdp.as_bytes()).to_hex().to_string();
        let message = format!("dev-relay:relay-dev-relay:{timestamp}:{digest}");
        let signature = hex::encode(signing.sign(message.as_bytes()).to_bytes());
        let env = ProtocolEnvelope::new(
            "webrtc_offer",
            serde_json::json!({
                "from_peer": "dev-relay",
                "to_peer": identity.node_id,
                "sdp": sdp,
                "timestamp": timestamp,
                "signature": signature,
            }),
        );

        // Valid signature over the exact payload verifies.
        assert!(
            client
                .verify_relay_signaling("dev-relay", &env, sdp)
                .await
                .is_ok()
        );
        // A swapped payload changes the digest, so the signature no longer binds.
        assert!(
            client
                .verify_relay_signaling("dev-relay", &env, "tampered-sdp")
                .await
                .is_err()
        );
        // An unpaired device is rejected regardless of the signature.
        assert!(
            client
                .verify_relay_signaling("dev-unknown", &env, sdp)
                .await
                .is_err()
        );
    }
    use crate::db;
    use crate::identity;
    use tempfile::tempdir;

    #[tokio::test]
    async fn test_sign_auth_challenge() {
        let dir = tempdir().unwrap();
        let id = identity::load_or_generate(dir.path()).unwrap();

        let challenge = NodeAuthChallengePayload {
            nonce: "test_nonce_abcdef1234567890".to_string(),
        };

        let resp = SyncClient::sign_auth_challenge(&id, &challenge);
        assert_eq!(resp.node_id, id.node_id);
        assert!(!resp.signature.is_empty());
    }

    #[tokio::test]
    async fn purge_tombstoned_entity_requires_a_matching_tombstone() {
        let dir = tempdir().unwrap();
        let pool = db::open(dir.path()).await.unwrap();
        let store = crate::store::ObjectStore::new(dir.path().to_path_buf(), pool.clone())
            .await
            .unwrap();

        // A live file with real data but no tombstone.
        let object_id = store.put(b"live shard").await.unwrap();
        sqlx::query(
            "INSERT INTO files (file_id, created_at, updated_at) VALUES ('f-live', 'now', 'now')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO file_versions (file_id, version_number, version_hash, shard_count, created_at) VALUES ('f-live', 1, 'h', 1, 'now')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO shards (file_id, version_number, shard_index, object_id, size_bytes) VALUES ('f-live', 1, 0, ?, 10)",
        )
        .bind(&object_id)
        .execute(&pool)
        .await
        .unwrap();

        // No tombstone and an unknown type: refuse, leaving live data intact.
        assert!(
            !purge_tombstoned_entity(&pool, &store, "file", "f-live")
                .await
                .unwrap()
        );
        assert!(
            !purge_tombstoned_entity(&pool, &store, "alien", "f-live")
                .await
                .unwrap()
        );
        assert!(store.exists(&object_id), "live data must survive");

        // With a tombstone present, the purge proceeds and frees the object.
        sqlx::query(
            "INSERT INTO tombstones (entity_type, entity_id, deleted_at) VALUES ('file', 'f-live', 'now')",
        )
        .execute(&pool)
        .await
        .unwrap();
        assert!(
            purge_tombstoned_entity(&pool, &store, "file", "f-live")
                .await
                .unwrap()
        );
        assert!(!store.exists(&object_id));
    }

    #[tokio::test]
    async fn store_pairing_token_ignores_other_nodes() {
        use base64::Engine;

        let dir = tempdir().unwrap();
        let pool = db::open(dir.path()).await.unwrap();

        let push = |node_id: &str, token: &str| PairingTokenPushPayload {
            node_id: node_id.to_string(),
            token: token.to_string(),
            device_public_key: base64::engine::general_purpose::STANDARD.encode([1u8; 32]),
            expires_at: (chrono::Utc::now() + chrono::Duration::minutes(15)).to_rfc3339(),
            account_id: "acct-1".to_string(),
        };

        // A token addressed to a different node must never be stored here.
        store_pairing_token(&pool, &push("other-node", "tok-other"), "my-node")
            .await
            .unwrap();
        store_pairing_token(&pool, &push("my-node", "tok-mine"), "my-node")
            .await
            .unwrap();

        let tokens: Vec<String> =
            sqlx::query_scalar("SELECT token FROM pairing_sessions ORDER BY token")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(tokens, vec!["tok-mine"]);
    }

    #[test]
    fn schema_major_compatibility() {
        assert!(schema_major_compatible("1.0.0"));
        assert!(schema_major_compatible("1.5"));
        assert!(!schema_major_compatible("2.0.0"));
        assert!(!schema_major_compatible(""));
        assert!(!schema_major_compatible("not-a-version"));
    }

    #[tokio::test]
    async fn test_build_sync_hello() {
        let dir = tempdir().unwrap();
        let pool = db::open(dir.path()).await.unwrap();

        sqlx::query(
            "INSERT INTO sync_cursors (peer_id, last_sequence_seen, updated_at) VALUES ('origin-1', 42, 'now')"
        )
        .execute(&pool)
        .await
        .unwrap();

        let hello = SyncClient::build_sync_hello(&pool, "my-node-id")
            .await
            .unwrap();
        assert_eq!(hello.node_id, "my-node-id");
        assert_eq!(hello.cursors.len(), 1);
        assert_eq!(hello.cursors[0].origin_id, "origin-1");
        assert_eq!(hello.cursors[0].sequence, 42);
    }

    #[test]
    fn test_relay_http_fetch_url_derivation() {
        assert_eq!(
            relay_http_fetch_url("ws://127.0.0.1:8080/ws"),
            "http://127.0.0.1:8080/buffer/fetch"
        );
        assert_eq!(
            relay_http_fetch_url("wss://relay.example.com/ws"),
            "https://relay.example.com/buffer/fetch"
        );
        // No trailing /ws path: just append the endpoint.
        assert_eq!(
            relay_http_fetch_url("ws://127.0.0.1:8080"),
            "http://127.0.0.1:8080/buffer/fetch"
        );
        // Query strings must not leak into the fetch endpoint.
        assert_eq!(
            relay_http_fetch_url("ws://127.0.0.1:8080/ws?token=abc"),
            "http://127.0.0.1:8080/buffer/fetch"
        );
        // A trailing slash on /ws must not break the derivation.
        assert_eq!(
            relay_http_fetch_url("ws://127.0.0.1:8080/ws/"),
            "http://127.0.0.1:8080/buffer/fetch"
        );
        // A non-/ws base path is preserved for proxied deployments.
        assert_eq!(
            relay_http_fetch_url("wss://relay.example.com/proxy/ws"),
            "https://relay.example.com/proxy/buffer/fetch"
        );
    }

    #[test]
    fn test_relay_http_base_accepts_public_origins() {
        // Operator-facing public origins pass through unchanged.
        assert_eq!(
            relay_http_base("https://nodus.example.com"),
            "https://nodus.example.com"
        );
        assert_eq!(
            relay_http_base("http://localhost:8080"),
            "http://localhost:8080"
        );
        // Legacy WS forms flip scheme and drop the /ws gateway segment.
        assert_eq!(
            relay_http_base("ws://127.0.0.1:8080/ws"),
            "http://127.0.0.1:8080"
        );
        assert_eq!(
            relay_http_base("wss://relay.example.com/ws"),
            "https://relay.example.com"
        );
        // A proxied base path is preserved; query/fragment are discarded.
        assert_eq!(
            relay_http_base("wss://relay.example.com/proxy/ws?token=abc"),
            "https://relay.example.com/proxy"
        );
        // Malformed input passes through.
        assert_eq!(relay_http_base("not a url"), "not a url");
    }

    #[test]
    fn test_is_node_not_paired_only_matches_marker() {
        assert!(is_node_not_paired(&anyhow::Error::new(NodeNotPaired)));
        assert!(!is_node_not_paired(&anyhow::anyhow!("relay unreachable")));
        // Wrapping in context preserves the marker through the chain.
        let wrapped = anyhow::Error::new(NodeNotPaired).context("session failed");
        assert!(is_node_not_paired(&wrapped));
    }

    #[test]
    fn test_is_node_not_active_only_matches_marker() {
        assert!(is_node_not_active(&anyhow::Error::new(NodeNotActive)));
        // The two markers are not interchangeable.
        assert!(!is_node_not_active(&anyhow::Error::new(NodeNotPaired)));
        assert!(!is_node_not_paired(&anyhow::Error::new(NodeNotActive)));
        assert!(!is_node_not_active(&anyhow::anyhow!("relay unreachable")));
    }

    #[test]
    fn test_relay_ws_url_normalization() {
        // Public HTTPS origin gains the /ws gateway path and wss scheme.
        assert_eq!(
            relay_ws_url("https://nodus.example.com"),
            "wss://nodus.example.com/ws"
        );
        // Public HTTP origin (dev relay) maps to ws.
        assert_eq!(
            relay_ws_url("http://localhost:8080"),
            "ws://localhost:8080/ws"
        );
        // Explicit WebSocket URLs (legacy NODUS_RELAY_URL) are used verbatim.
        assert_eq!(
            relay_ws_url("ws://127.0.0.1:8080/ws"),
            "ws://127.0.0.1:8080/ws"
        );
        assert_eq!(
            relay_ws_url("wss://relay.example.com/ws"),
            "wss://relay.example.com/ws"
        );
        // A base path is preserved as a prefix and still gains /ws, matching
        // the HTTP fetch derivation (/proxy/buffer/fetch).
        assert_eq!(
            relay_ws_url("https://relay.example.com/proxy"),
            "wss://relay.example.com/proxy/ws"
        );
        // An already-gateway-suffixed WS path is never double-suffixed.
        assert_eq!(
            relay_ws_url("https://relay.example.com/proxy/ws"),
            "wss://relay.example.com/proxy/ws"
        );
        // Malformed input passes through so it fails as a connection error.
        assert_eq!(relay_ws_url("not a url"), "not a url");
    }

    #[tokio::test]
    async fn test_record_shard_metadata_waits_for_version() {
        let dir = tempdir().unwrap();
        let pool = db::open(dir.path()).await.unwrap();
        let store = Arc::new(
            ObjectStore::new(dir.path().join("objects"), pool.clone())
                .await
                .unwrap(),
        );
        let identity = Arc::new(identity::load_or_generate(dir.path()).unwrap());
        let client = SyncClient::new(
            "ws://127.0.0.1:8080/ws".to_string(),
            identity.clone(),
            pool.clone(),
            store.clone(),
            test_webrtc_manager(&pool, store.clone(), identity.clone()),
            100,
            None,
        );

        let n = PendingNotifyPayload {
            file_id: "file-wait".to_string(),
            version_number: 1,
            shard_index: 0,
            buffer_id: "buf-1".to_string(),
            fetch_token: "tok-1".to_string(),
            from_device: "dev-1".to_string(),
            hash: "h".to_string(),
            size: 10,
        };

        // No file_versions row yet -> staged in the pending landing zone.
        client.record_shard_metadata(&n, "obj-1", 10).await.unwrap();
        let pending: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pending_shard_fetches WHERE file_id = 'file-wait'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(pending, 1);

        // Once the version metadata arrives, the same call targets shards directly.
        sqlx::query(
            "INSERT INTO storage_objects (object_id, size_bytes, status, created_at) VALUES ('obj-1', 10, 'STORED', 'now')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO files (file_id, created_at, updated_at) VALUES ('file-wait', 'now', 'now')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO file_versions (file_id, version_number, version_hash, shard_count, created_at) VALUES ('file-wait', 1, 'h', 1, 'now')",
        )
        .execute(&pool)
        .await
        .unwrap();
        client.record_shard_metadata(&n, "obj-1", 10).await.unwrap();

        let shards: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM shards WHERE file_id = 'file-wait' AND version_number = 1",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(shards, 1);
    }

    #[tokio::test]
    async fn rejects_conflicting_relay_shard() {
        let dir = tempdir().unwrap();
        let pool = db::open(dir.path()).await.unwrap();
        let store = Arc::new(
            ObjectStore::new(dir.path().join("objects"), pool.clone())
                .await
                .unwrap(),
        );
        let identity = Arc::new(identity::load_or_generate(dir.path()).unwrap());
        let client = SyncClient::new(
            "ws://127.0.0.1:8080/ws".to_string(),
            identity.clone(),
            pool.clone(),
            store.clone(),
            test_webrtc_manager(&pool, store.clone(), identity.clone()),
            100,
            None,
        );

        let n = PendingNotifyPayload {
            file_id: "file-conflict".to_string(),
            version_number: 1,
            shard_index: 0,
            buffer_id: "buf-1".to_string(),
            fetch_token: "tok-1".to_string(),
            from_device: "dev-1".to_string(),
            hash: "h".to_string(),
            size: 10,
        };

        sqlx::query("INSERT INTO storage_objects (object_id, size_bytes, status, created_at) VALUES ('obj-a', 1, 'STORED', 'now')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO files (file_id, created_at, updated_at) VALUES ('file-conflict', 'now', 'now')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO file_versions (file_id, version_number, version_hash, shard_count, created_at) VALUES ('file-conflict', 1, 'h', 1, 'now')")
            .execute(&pool)
            .await
            .unwrap();

        // First copy lands.
        client.record_shard_metadata(&n, "obj-a", 1).await.unwrap();

        // A later relay notify for the same slot with different bytes is a
        // conflict: surface it rather than silently keeping a different object
        // (or, worse, overwriting).
        let err = client
            .record_shard_metadata(&n, "obj-b", 1)
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("refusing to overwrite"), "unexpected: {err}");

        let stored: String = sqlx::query_scalar(
            "SELECT object_id FROM shards WHERE file_id = 'file-conflict' AND version_number = 1 AND shard_index = 0",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(stored, "obj-a");
    }

    #[tokio::test]
    async fn record_shard_metadata_enforces_signed_manifest() {
        let dir = tempdir().unwrap();
        let pool = db::open(dir.path()).await.unwrap();
        let store = Arc::new(
            ObjectStore::new(dir.path().join("objects"), pool.clone())
                .await
                .unwrap(),
        );
        let identity = Arc::new(identity::load_or_generate(dir.path()).unwrap());
        let client = SyncClient::new(
            "ws://127.0.0.1:8080/ws".to_string(),
            identity.clone(),
            pool.clone(),
            store.clone(),
            test_webrtc_manager(&pool, store.clone(), identity.clone()),
            100,
            None,
        );

        let n = PendingNotifyPayload {
            file_id: "file-manifest".to_string(),
            version_number: 1,
            shard_index: 0,
            buffer_id: "buf-1".to_string(),
            fetch_token: "tok-1".to_string(),
            from_device: "dev-1".to_string(),
            hash: "h".to_string(),
            size: 10,
        };
        sqlx::query(
            "INSERT INTO file_version_shard_hashes (file_id, version_number, shard_index, shard_hash) \
             VALUES ('file-manifest', 1, 0, ?)",
        )
        .bind("a".repeat(64))
        .execute(&pool)
        .await
        .unwrap();

        // Bytes matching the signed manifest are accepted (staged, since the
        // version row is absent).
        client
            .record_shard_metadata(&n, &"a".repeat(64), 10)
            .await
            .unwrap();

        // A different object id is refused.
        let err = client
            .record_shard_metadata(&n, &"b".repeat(64), 10)
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("signed manifest"), "unexpected: {err}");
    }

    #[tokio::test]
    async fn store_trusted_peers_upserts_skips_self_and_keeps_cache() {
        let dir = tempdir().unwrap();
        let pool = db::open(dir.path()).await.unwrap();

        let key = [9u8; 32];
        let peers = vec![
            // Self must never be stored as a peer.
            NodePeer {
                node_id: "self".to_string(),
                public_key: hex::encode([1u8; 32]),
            },
            NodePeer {
                node_id: "peer-a".to_string(),
                public_key: hex::encode(key),
            },
            // Malformed hex and wrong-length keys are skipped, not fatal.
            NodePeer {
                node_id: "peer-bad-hex".to_string(),
                public_key: "zz".to_string(),
            },
            NodePeer {
                node_id: "peer-short".to_string(),
                public_key: hex::encode([2u8; 16]),
            },
        ];
        store_trusted_peers(&pool, "self", &peers).await.unwrap();

        let rows: Vec<(String, Vec<u8>)> =
            sqlx::query_as("SELECT node_id, public_key_bytes FROM trusted_nodes ORDER BY node_id")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(rows.len(), 1, "only the valid non-self peer is stored");
        assert_eq!(rows[0].0, "peer-a");
        assert_eq!(rows[0].1, key.to_vec());

        // A re-auth with a rotated key refreshes the key but preserves the
        // path-cache columns that guide repair ordering.
        sqlx::query("UPDATE trusted_nodes SET last_successful_path = 'local_signaling'")
            .execute(&pool)
            .await
            .unwrap();
        let rotated = [5u8; 32];
        store_trusted_peers(
            &pool,
            "self",
            &[NodePeer {
                node_id: "peer-a".to_string(),
                public_key: hex::encode(rotated),
            }],
        )
        .await
        .unwrap();

        let (bytes, path): (Vec<u8>, Option<String>) =
            sqlx::query_as("SELECT public_key_bytes, last_successful_path FROM trusted_nodes WHERE node_id = 'peer-a'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(bytes, rotated.to_vec(), "key is refreshed");
        assert_eq!(path.as_deref(), Some("local_signaling"), "cache preserved");
    }
}
