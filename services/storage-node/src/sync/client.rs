use futures_util::{SinkExt, StreamExt};
use sqlx::{Row, SqlitePool};
use std::sync::Arc;
use std::time::Duration;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;
use url::Url;

use super::engine::{apply_incoming_batch, drain_pending_fetches};
use super::outbox::{drain_unsynced_events, mark_events_synced, sweep_synced_outbox};
use super::snapshot::is_rebuild_required_for;
use super::types::{
    BatchAckPayload, EventBatchPayload, NodeAuthChallengePayload, NodeAuthResponsePayload,
    NodeAuthResultPayload, PairingTokenPushPayload, PendingNotifyPayload, ProtocolEnvelope,
    RegisterPayload, ShardAckPayload, SyncCursor, SyncHelloPayload, SyncStatusPayload,
};
use crate::identity::NodeIdentity;
use crate::store::ObjectStore;

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

pub struct SyncClient {
    pub relay_url: String,
    pub identity: Arc<NodeIdentity>,
    pub db: SqlitePool,
    pub batch_size: usize,
    pub object_store: Arc<ObjectStore>,
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
        batch_size: usize,
        on_connected: Option<Arc<dyn Fn() + Send + Sync>>,
    ) -> Self {
        Self {
            http_fetch_url: relay_http_fetch_url(&relay_url),
            relay_url,
            identity,
            db,
            object_store,
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
    pub async fn run_sync_session(&self) -> anyhow::Result<()> {
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
                } else if env.msg_type == "node_auth_result" {
                    let result: NodeAuthResultPayload = serde_json::from_value(env.payload)?;
                    if result.status == "ok" {
                        authenticated = true;
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

        // 2. Send SYNC_HELLO
        let hello = Self::build_sync_hello(&self.db, &self.identity.node_id).await?;
        let hello_env = ProtocolEnvelope::new("sync_hello", serde_json::to_value(hello)?);
        Self::send_json(&mut write, &hello_env).await?;

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
        let mut heartbeat = tokio::time::interval(std::time::Duration::from_secs(30));
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut outbox_flush = tokio::time::interval(OUTBOX_FLUSH_INTERVAL);
        outbox_flush.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut outbox_sweep = tokio::time::interval(OUTBOX_SWEEP_INTERVAL);
        outbox_sweep.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
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
                        let _status: SyncStatusPayload = serde_json::from_value(env.payload)?;
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
                    _ => {}
                }
            }
                }
                _ = heartbeat.tick() => {
                    // Liveness ping (§13): the Relay keys the node's
                    // online/offline state off this envelope, and it writes
                    // `last_seen_at` at most once per minute. Payload matches
                    // the protocol's HeartbeatPayloadSchema (id + RFC3339 ts).
                    Self::send_envelope(&mut write, "heartbeat", &serde_json::json!({
                        "id": self.identity.node_id,
                        "timestamp": chrono::Utc::now().to_rfc3339(),
                    }))
                    .await?;
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
    async fn stream_snapshot<W>(&self, write: &mut W) -> anyhow::Result<()>
    where
        W: futures_util::Sink<Message> + Unpin,
        W::Error: std::error::Error + Send + Sync + 'static,
    {
        let (begin, chunks, end) =
            super::snapshot::build_snapshot(&self.db, &self.identity).await?;

        let begin_env = ProtocolEnvelope::new("snapshot_begin", serde_json::to_value(begin)?);
        Self::send_json(write, &begin_env).await?;

        for chunk in chunks {
            let chunk_env = ProtocolEnvelope::new("snapshot_chunk", serde_json::to_value(chunk)?);
            Self::send_json(write, &chunk_env).await?;
        }

        let end_env = ProtocolEnvelope::new("snapshot_end", serde_json::to_value(end)?);
        Self::send_json(write, &end_env).await?;

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
        let store = ObjectStore::new(dir.path().join("objects"), pool.clone())
            .await
            .unwrap();
        let client = SyncClient::new(
            "ws://127.0.0.1:8080/ws".to_string(),
            Arc::new(identity::load_or_generate(dir.path()).unwrap()),
            pool.clone(),
            Arc::new(store),
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
        let store = ObjectStore::new(dir.path().join("objects"), pool.clone())
            .await
            .unwrap();
        let client = SyncClient::new(
            "ws://127.0.0.1:8080/ws".to_string(),
            Arc::new(identity::load_or_generate(dir.path()).unwrap()),
            pool.clone(),
            Arc::new(store),
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
        let store = ObjectStore::new(dir.path().join("objects"), pool.clone())
            .await
            .unwrap();
        let client = SyncClient::new(
            "ws://127.0.0.1:8080/ws".to_string(),
            Arc::new(identity::load_or_generate(dir.path()).unwrap()),
            pool.clone(),
            Arc::new(store),
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
}
