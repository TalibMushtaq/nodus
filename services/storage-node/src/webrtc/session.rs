use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Context, bail};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tokio::sync::{Mutex, RwLock, broadcast};
use webrtc::api::APIBuilder;
use webrtc::data_channel::RTCDataChannel;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;

use crate::identity::NodeIdentity;
use crate::limits::MAX_SHARD_BYTES;
use crate::store::ObjectStore;

/// If a shard transmission stalls (no frames at all) this long, the partially
/// received state is dropped so a wedged channel can't pin memory or poison the
/// next transmission on the same channel.
const CHANNEL_STALL_TIMEOUT: Duration = Duration::from_secs(300);

/// Maximum concurrent WebRTC sessions across all devices. Bounds the aggregate
/// memory/fd cost of a device that opens many sessions (each session is a live
/// peer connection plus per-channel buffers).
const MAX_SESSIONS: usize = 64;
/// Maximum concurrent sessions for a single paired device, so one compromised
/// device cannot monopolise the global budget.
const MAX_SESSIONS_PER_DEVICE: usize = 8;
/// Maximum data channels one peer connection may open. Each channel buffers up
/// to `MAX_SHARD_BYTES`, so without this a single authenticated device could
/// drive N × 64 MiB by opening channels in a loop.
const MAX_CHANNELS_PER_CONNECTION: usize = 16;
/// Absolute session lifetime, applied even to `Connected` sessions so a device
/// cannot hold a live session (and its memory) forever.
const MAX_SESSION_LIFETIME: Duration = Duration::from_secs(24 * 3600);

/// Unused WebRTC sessions are reaped after this much wall time *without* an
/// active peer connection. Sessions with live traffic (`touch`) or an active
/// `Connected` transport are never pruned, regardless of how long they live.
const SESSION_IDLE_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShardUploadPayload {
    pub file_id: String,
    pub version_number: i64,
    pub shard_index: i64,
    pub hash: String,
    pub size: i64,
    pub transfer_id: String,
    pub target_node: Option<String>,
    pub source_device: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShardAckPayload {
    pub file_id: String,
    pub version_number: i64,
    pub shard_index: i64,
    pub status: String, // "verified" | "failed"
    pub transfer_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}

/// Per-data-channel receive state for one inbound shard upload.
///
/// Kept behind a tokio mutex because the message handler and the staleness
/// watcher touch it concurrently. All capacity decisions live here so the
/// buffering rules are unit-testable without a live peer connection.
struct ChannelReceiveState {
    metadata: Option<ShardUploadPayload>,
    chunks: Vec<u8>,
    last_activity: Instant,
}

impl Default for ChannelReceiveState {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug)]
enum ShardReject {
    /// Binary arrived before the channel advertised metadata.
    MissingMetadata,
    /// Declared size or accumulated bytes exceed the hard cap.
    TooLarge,
    /// Metadata carried an invalid size or non-hex hash.
    InvalidMetadata,
}

impl ChannelReceiveState {
    fn new() -> Self {
        Self {
            metadata: None,
            chunks: Vec::new(),
            last_activity: Instant::now(),
        }
    }

    /// Store channel metadata after validating the *declared* size against the
    /// cap. Any incoming shard that can't possibly fit is rejected here so we
    /// never start buffering something we will refuse anyway.
    fn on_metadata(&mut self, meta: ShardUploadPayload) -> Result<(), ShardReject> {
        if meta.size < 0 || meta.size as usize > MAX_SHARD_BYTES {
            return Err(ShardReject::TooLarge);
        }
        let hash_ok = meta.hash.len() == 64
            && meta
                .hash
                .bytes()
                .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
        if !hash_ok {
            return Err(ShardReject::InvalidMetadata);
        }
        self.chunks.clear();
        self.metadata = Some(meta);
        self.last_activity = Instant::now();
        Ok(())
    }

    /// Append a binary chunk only if the running total stays within the cap.
    /// The check happens *before* `extend_from_slice`, so memory growth is
    /// bounded even for a peer that lies about the declared size.
    fn on_binary(&mut self, data: &[u8]) -> Result<(), ShardReject> {
        if self.metadata.is_none() {
            return Err(ShardReject::MissingMetadata);
        }
        if self.chunks.len().saturating_add(data.len()) > MAX_SHARD_BYTES {
            return Err(ShardReject::TooLarge);
        }
        self.chunks.extend_from_slice(data);
        self.last_activity = Instant::now();
        Ok(())
    }

    /// True when a transmission is mid-flight and has seen no frames recently.
    fn is_stalled(&self, now: Instant) -> bool {
        self.metadata.is_some() && now.duration_since(self.last_activity) > CHANNEL_STALL_TIMEOUT
    }

    /// Consume the completed transmission, if one is in flight.
    fn take_done(&mut self) -> Option<(ShardUploadPayload, Vec<u8>)> {
        let meta = self.metadata.take()?;
        Some((meta, std::mem::take(&mut self.chunks)))
    }

    fn clear(&mut self) {
        self.metadata = None;
        self.chunks.clear();
    }
}

/// True only when a data-channel text frame is the explicit end-of-shard
/// signal. Parses the JSON and requires boolean `shard_done: true`; a substring
/// check would let a crafted `file_id` end the transfer prematurely.
fn is_shard_done(text: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|v| v.get("shard_done").and_then(|b| b.as_bool()))
        .unwrap_or(false)
}

pub struct WebRtcSession {
    #[allow(dead_code)]
    pub session_id: String,
    pub device_id: String,
    pub peer_connection: Arc<RTCPeerConnection>,
    pub ice_tx: broadcast::Sender<String>,
    /// Monotonic millis of the last observed activity (signaling or channel
    /// traffic). The manager's reaper uses this to distinguish an idle session
    /// from an actively transferring one.
    pub last_active_ms: Arc<AtomicU64>,
    /// Wall-clock creation time (millis). The reaper applies
    /// `MAX_SESSION_LIFETIME` regardless of activity so a `Connected` session
    /// cannot be held open forever.
    pub created_at_ms: u64,
}

impl WebRtcSession {
    pub async fn new(
        session_id: String,
        device_id: String,
        db: SqlitePool,
        store: Arc<ObjectStore>,
        identity: Arc<NodeIdentity>,
    ) -> anyhow::Result<Self> {
        let api = APIBuilder::new().build();
        let config = RTCConfiguration {
            ice_servers: vec![RTCIceServer {
                urls: vec!["stun:stun.l.google.com:19302".to_string()],
                ..Default::default()
            }],
            ..Default::default()
        };

        let peer_connection = Arc::new(
            api.new_peer_connection(config)
                .await
                .context("creating WebRTC peer connection")?,
        );

        let (ice_tx, _) = broadcast::channel(64);
        let channel_count = Arc::new(AtomicUsize::new(0));
        let created_at_ms = now_millis();

        // Setup local ICE candidate listener
        let ice_tx_clone = ice_tx.clone();
        peer_connection.on_ice_candidate(Box::new(move |candidate| {
            let tx = ice_tx_clone.clone();
            Box::pin(async move {
                if let Some(Ok(json_str)) = candidate.map(|c| c.to_json()) {
                    let serialized = serde_json::to_string(&json_str).unwrap_or_default();
                    let _ = tx.send(serialized);
                }
            })
        }));

        // Setup DataChannel listener
        let db_clone = db.clone();
        let store_clone = store.clone();
        let identity_clone = identity.clone();
        let last_active = Arc::new(AtomicU64::new(now_millis()));
        let channel_last_active = last_active.clone();
        let channel_count_cb = channel_count.clone();

        peer_connection.on_data_channel(Box::new(move |dc: Arc<RTCDataChannel>| {
            let db = db_clone.clone();
            let store = store_clone.clone();
            let identity = identity_clone.clone();
            let session_last_active = channel_last_active.clone();
            let channels = channel_count_cb.clone();

            Box::pin(async move {
                // Bound channels per connection: each may buffer a full shard,
                // so an authenticated device must not be able to open channels
                // in a loop and multiply its memory budget.
                if channels.fetch_add(1, Ordering::SeqCst) + 1 > MAX_CHANNELS_PER_CONNECTION {
                    channels.fetch_sub(1, Ordering::SeqCst);
                    eprintln!(
                        "[webrtc] rejecting data channel: per-connection limit of \
                         {MAX_CHANNELS_PER_CONNECTION} reached"
                    );
                    let _ = dc.close().await;
                    return;
                }
                let channels_on_close = channels.clone();
                let state = Arc::new(Mutex::new(ChannelReceiveState::new()));

                // ONE staleness watcher per channel (not per frame): flips the
                // shared state back to idle when a transmission stalls. It exits
                // once the data channel reports close. `last_activity` moves with
                // the traffic, so a slow-but-live transfer is never cleared.
                let watcher_state = state.clone();
                let dc_watcher = dc.clone();
                tokio::spawn(async move {
                    let mut tick = tokio::time::interval(Duration::from_secs(30));
                    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                    loop {
                        tick.tick().await;
                        if dc_watcher.ready_state() == (webrtc::data_channel::data_channel_state::RTCDataChannelState::Closed)
                        {
                            // Release the slot so a closed channel does not
                            // permanently consume the per-connection budget.
                            channels_on_close.fetch_sub(1, Ordering::SeqCst);
                            return;
                        }
                        let mut st = watcher_state.lock().await;
                        if st.is_stalled(Instant::now()) {
                            eprintln!("[webrtc] clearing stalled shard transfer on channel");
                            st.clear();
                        }
                    }
                });

                let state_clone = state.clone();
                let dc_clone = dc.clone();

                dc.on_message(Box::new(move |msg: DataChannelMessage| {
                    let state = state_clone.clone();
                    let dc = dc_clone.clone();
                    let db = db.clone();
                    let store = store.clone();
                    let identity = identity.clone();
                    let session_last_active = session_last_active.clone();

                    Box::pin(async move {
                        // Any traffic counts as session activity (#4: a long
                        // running, actively transferring session must outlive
                        // a naive created-at TTL).
                        session_last_active.store(now_millis(), Ordering::Relaxed);

                        if msg.is_string {
                            let text = match String::from_utf8(msg.data.to_vec()) {
                                Ok(t) => t,
                                Err(_) => return,
                            };

                            // Parse the frame and check an explicit boolean:
                            // substring matching would let a crafted `file_id`
                            // containing "shard_done" end the transfer early.
                            if is_shard_done(&text) {
                                // Shard transmission finished, verify and commit
                                let mut st = state.lock().await;
                                let Some((metadata, chunks)) = st.take_done() else {
                                    return;
                                };
                                let size_bytes = chunks.len() as i64;

                                let actual_hash = blake3::hash(&chunks).to_hex().to_string();
                                if actual_hash != metadata.hash {
                                    let ack = ShardAckPayload {
                                        file_id: metadata.file_id,
                                        version_number: metadata.version_number,
                                        shard_index: metadata.shard_index,
                                        status: "failed".into(),
                                        transfer_id: metadata.transfer_id,
                                        error_message: Some(format!(
                                            "Hash mismatch: got {}, expected {}",
                                            actual_hash, metadata.hash
                                        )),
                                    };
                                    if let Ok(ack_json) = serde_json::to_string(&ack) {
                                        let _ = dc.send_text(ack_json).await;
                                    }
                                    return;
                                }

                                // 1. Save shard bytes to ObjectStore
                                if let Err(e) = store.put(&chunks).await {
                                    eprintln!("[webrtc] error saving object: {e}");
                                    let ack = ShardAckPayload {
                                        file_id: metadata.file_id,
                                        version_number: metadata.version_number,
                                        shard_index: metadata.shard_index,
                                        status: "failed".into(),
                                        transfer_id: metadata.transfer_id,
                                        error_message: Some(format!("Object store error: {e}")),
                                    };
                                    if let Ok(ack_json) = serde_json::to_string(&ack) {
                                        let _ = dc.send_text(ack_json).await;
                                    }
                                    return;
                                }

                                // 2 & 3. Commit metadata to SQLite shards table and sync_outbox atomically
                                let now = chrono::Utc::now().to_rfc3339();
                                let event_id = uuid::Uuid::new_v4().to_string();
                                let outbox_payload = serde_json::json!({
                                    "file_id": metadata.file_id,
                                    "version_number": metadata.version_number,
                                    "shard_index": metadata.shard_index,
                                    "hash": actual_hash,
                                    "size_bytes": size_bytes,
                                });

                                let save_res = async {
                                    let mut tx = db.begin().await?;

                                    // The file_versions row may not have synced
                                    // yet (shard bytes can arrive before the
                                    // version event). Staging in
                                    // pending_shard_fetches keeps the object
                                    // reachable instead of failing the shards FK
                                    // and orphaning it; the engine's
                                    // drain_pending_fetches moves it into
                                    // `shards` when the version event arrives.
                                    let version_exists: i64 = sqlx::query_scalar(
                                        "SELECT COUNT(*) FROM file_versions WHERE file_id = ? AND version_number = ?",
                                    )
                                    .bind(&metadata.file_id)
                                    .bind(metadata.version_number)
                                    .fetch_one(&mut *tx)
                                    .await?;

                                    if version_exists > 0 {
                                        sqlx::query(
                                            r#"
                                            INSERT INTO shards (file_id, version_number, shard_index, object_id, size_bytes)
                                            VALUES (?, ?, ?, ?, ?)
                                            ON CONFLICT(file_id, version_number, shard_index) DO UPDATE SET
                                                object_id = excluded.object_id,
                                                size_bytes = excluded.size_bytes
                                            "#,
                                        )
                                        .bind(&metadata.file_id)
                                        .bind(metadata.version_number)
                                        .bind(metadata.shard_index)
                                        .bind(&actual_hash)
                                        .bind(size_bytes)
                                        .execute(&mut *tx)
                                        .await?;
                                    } else {
                                        sqlx::query(
                                            r#"
                                            INSERT INTO pending_shard_fetches (file_id, version_number, shard_index, object_id, size_bytes, fetched_at)
                                            VALUES (?, ?, ?, ?, ?, ?)
                                            ON CONFLICT(file_id, version_number, shard_index) DO UPDATE SET
                                                object_id = excluded.object_id,
                                                size_bytes = excluded.size_bytes,
                                                fetched_at = excluded.fetched_at
                                            "#,
                                        )
                                        .bind(&metadata.file_id)
                                        .bind(metadata.version_number)
                                        .bind(metadata.shard_index)
                                        .bind(&actual_hash)
                                        .bind(size_bytes)
                                        .bind(&now)
                                        .execute(&mut *tx)
                                        .await?;
                                    }

                                    sqlx::query(
                                        r#"
                                        INSERT INTO sync_outbox (event_id, origin_id, origin_sequence, event_type, payload, created_at, synced)
                                        VALUES (?, ?, (SELECT COALESCE(MAX(origin_sequence), 0) + 1 FROM sync_outbox WHERE origin_id = ?), 'FILE_SHARD_STORED', ?, ?, 0)
                                        "#,
                                    )
                                    .bind(&event_id)
                                    .bind(&identity.node_id)
                                    .bind(&identity.node_id)
                                    .bind(outbox_payload.to_string())
                                    .bind(&now)
                                    .execute(&mut *tx)
                                    .await?;

                                    tx.commit().await?;
                                    Ok::<(), sqlx::Error>(())
                                }.await;

                                if let Err(e) = save_res {
                                    eprintln!("[webrtc] database error saving shard record: {e}");
                                    let ack = ShardAckPayload {
                                        file_id: metadata.file_id,
                                        version_number: metadata.version_number,
                                        shard_index: metadata.shard_index,
                                        status: "failed".into(),
                                        transfer_id: metadata.transfer_id,
                                        error_message: Some(format!("Database error: {e}")),
                                    };
                                    if let Ok(ack_json) = serde_json::to_string(&ack) {
                                        let _ = dc.send_text(ack_json).await;
                                    }
                                    return;
                                }

                                // 4. Send verified ShardAckPayload back over DataChannel
                                let ack = ShardAckPayload {
                                    file_id: metadata.file_id,
                                    version_number: metadata.version_number,
                                    shard_index: metadata.shard_index,
                                    status: "verified".into(),
                                    transfer_id: metadata.transfer_id,
                                    error_message: None,
                                };
                                if let Ok(ack_json) = serde_json::to_string(&ack) {
                                    let _ = dc.send_text(ack_json).await;
                                }
                            } else if let Ok(meta) =
                                serde_json::from_str::<ShardUploadPayload>(&text)
                            {
                                // Metadata frame for a new transmission. A
                                // rejected frame clears stale state so the next
                                // attempt starts clean.
                                let mut st = state.lock().await;
                                match st.on_metadata(meta.clone()) {
                                    Ok(()) => {}
                                    Err(_) => {
                                        st.clear();
                                        // Fields parsed far enough for an ack:
                                        // the sender sees the failure and aborts.
                                        let ack = ShardAckPayload {
                                            file_id: meta.file_id,
                                            version_number: meta.version_number,
                                            shard_index: meta.shard_index,
                                            status: "failed".into(),
                                            transfer_id: meta.transfer_id,
                                            error_message: Some(
                                                "shard rejected: exceeds size cap or invalid metadata".into(),
                                            ),
                                        };
                                        if let Ok(ack_json) = serde_json::to_string(&ack) {
                                            let _ = dc.send_text(ack_json).await;
                                        }
                                    }
                                }
                            }
                        } else {
                            // Binary chunk received
                            let mut st = state.lock().await;
                            if st.on_binary(&msg.data).is_err() {
                                // Garbage before metadata or a cap violation:
                                // drop the transmission rather than buffer it.
                                st.clear();
                            }
                        }
                    })
                }));
            })
        }));

        Ok(Self {
            session_id,
            device_id,
            peer_connection,
            ice_tx,
            last_active_ms: last_active,
            created_at_ms,
        })
    }

    /// Record activity so the reaper never prunes a live session.
    pub fn touch(&self) {
        self.last_active_ms.store(now_millis(), Ordering::Relaxed);
    }

    pub async fn handle_offer(&self, sdp: &str) -> anyhow::Result<String> {
        let offer = RTCSessionDescription::offer(sdp.to_string())
            .map_err(|e| anyhow::anyhow!("invalid sdp offer: {e}"))?;

        self.peer_connection
            .set_remote_description(offer)
            .await
            .context("setting remote sdp description")?;

        let answer = self
            .peer_connection
            .create_answer(None)
            .await
            .context("creating sdp answer")?;

        self.peer_connection
            .set_local_description(answer.clone())
            .await
            .context("setting local sdp description")?;

        Ok(answer.sdp)
    }

    pub async fn add_ice_candidate(&self, candidate_str: &str) -> anyhow::Result<()> {
        let init: RTCIceCandidateInit = if let Ok(json_cand) = serde_json::from_str(candidate_str) {
            json_cand
        } else {
            RTCIceCandidateInit {
                candidate: candidate_str.to_string(),
                ..Default::default()
            }
        };

        self.peer_connection
            .add_ice_candidate(init)
            .await
            .context("adding remote ice candidate")?;

        Ok(())
    }

    pub fn subscribe_ice(&self) -> broadcast::Receiver<String> {
        self.ice_tx.subscribe()
    }
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Decide whether a session should be pruned by the reaper.
///
/// A session stays alive while it has been active recently (`last_active_ms`
/// within `SESSION_IDLE_TIMEOUT`) *or* while its peer connection is live
/// (`Connected`). A never-gathered or failed session goes stale on its own once
/// activity stops. Independently, `MAX_SESSION_LIFETIME` bounds even a
/// connected session's total age, so a device cannot pin memory/fds forever.
fn should_prune(created_ms: u64, last_active_ms: u64, now_ms: u64, connected: bool) -> bool {
    let idle = now_ms.saturating_sub(last_active_ms) > SESSION_IDLE_TIMEOUT.as_millis() as u64
        && !connected;
    let too_old = now_ms.saturating_sub(created_ms) > MAX_SESSION_LIFETIME.as_millis() as u64;
    idle || too_old
}

/// WebRtcManager manages active WebRTC sessions and handles lifecycle/TTL.
#[derive(Clone)]
pub struct WebRtcManager {
    sessions: Arc<RwLock<HashMap<String, Arc<WebRtcSession>>>>,
    db: SqlitePool,
    store: Arc<ObjectStore>,
    identity: Arc<NodeIdentity>,
    /// Shell telemetry: publishes the live direct-session count so `status`
    /// reports client↔node direct (internet) connectivity without polling.
    telemetry: crate::telemetry::Telemetry,
}

impl WebRtcManager {
    pub fn new(
        db: SqlitePool,
        store: Arc<ObjectStore>,
        identity: Arc<NodeIdentity>,
        telemetry: crate::telemetry::Telemetry,
    ) -> Self {
        let manager = Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            db,
            store,
            identity,
            telemetry,
        };

        // Reaper: prune sessions once they are idle AND no longer connected.
        // `created_at` is deliberately not used — a session that is actively
        // transferring buckets of shards must not be torn down on a fixed TTL.
        let sessions_clone = manager.sessions.clone();
        let telemetry_clone = manager.telemetry.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(60));
            loop {
                interval.tick().await;
                let mut lock = sessions_clone.write().await;
                let before = lock.len();
                let now = now_millis();
                lock.retain(|_, session| {
                    let active = session.last_active_ms.load(Ordering::Relaxed);
                    let connected = session.peer_connection.connection_state()
                        == RTCPeerConnectionState::Connected;
                    !should_prune(session.created_at_ms, active, now, connected)
                });
                // Publishing on every tick also heals a count drift if a
                // session ever ends without an explicit prune.
                telemetry_clone.set_direct_active(lock.len() as u32);
                if lock.len() != before {
                    eprintln!("[webrtc] pruned {} idle session(s)", before - lock.len());
                }
            }
        });

        manager
    }

    /// Return the live session for `session_id`, creating it exactly once.
    ///
    /// Single-flight by construction: the check, create, and insert all happen
    /// while holding the map's write lock, so concurrent callers serialize and
    /// every one of them observes the same `Arc`. Creation is local-only (peer
    /// connection + closures), so the brief write-lock hold is acceptable.
    pub async fn get_or_create_session(
        &self,
        session_id: &str,
        device_id: &str,
    ) -> anyhow::Result<Arc<WebRtcSession>> {
        let mut lock = self.sessions.write().await;
        if let Some(sess) = lock.get(session_id) {
            if sess.device_id != device_id {
                bail!("device_id mismatch for existing session");
            }
            // Reuse the live connection; only a Failed transport warrants a
            // replacement (the client's next offer would fail on a dead one).
            if sess.peer_connection.connection_state() != RTCPeerConnectionState::Failed {
                return Ok(sess.clone());
            }
            lock.remove(session_id);
        }

        // Cap creation: global and per-device. Both bounds are necessary — a
        // global cap alone lets one device starve others, and a per-device cap
        // alone does not bound the total. The whole check runs under the map's
        // write lock, so concurrent offers cannot both slip past the limit.
        if lock.len() >= MAX_SESSIONS {
            bail!("WebRTC session limit reached ({MAX_SESSIONS} concurrent sessions)");
        }
        let device_sessions = lock.values().filter(|s| s.device_id == device_id).count();
        if device_sessions >= MAX_SESSIONS_PER_DEVICE {
            bail!(
                "per-device WebRTC session limit reached \
                 ({MAX_SESSIONS_PER_DEVICE} concurrent sessions)"
            );
        }

        let session = Arc::new(
            WebRtcSession::new(
                session_id.to_string(),
                device_id.to_string(),
                self.db.clone(),
                self.store.clone(),
                self.identity.clone(),
            )
            .await?,
        );

        // First client for this session id: record it as a direct (internet)
        // connection in shell telemetry and refresh the live count.
        self.telemetry.direct_session_started();
        lock.insert(session_id.to_string(), session.clone());
        self.telemetry.set_direct_active(lock.len() as u32);
        Ok(session)
    }

    pub async fn get_session(&self, session_id: &str) -> Option<Arc<WebRtcSession>> {
        let lock = self.sessions.read().await;
        lock.get(session_id).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(size: i64) -> ShardUploadPayload {
        ShardUploadPayload {
            file_id: "f1".into(),
            version_number: 1,
            shard_index: 0,
            hash: blake3::hash(b"x").to_hex().to_string(),
            size,
            transfer_id: "t1".into(),
            target_node: None,
            source_device: None,
        }
    }

    #[test]
    fn binary_before_metadata_is_rejected() {
        let mut st = ChannelReceiveState::new();
        assert!(matches!(
            st.on_binary(b"0001020304").unwrap_err(),
            ShardReject::MissingMetadata
        ));
    }

    #[test]
    fn declared_size_over_cap_rejected_at_metadata() {
        let mut st = ChannelReceiveState::new();
        assert!(matches!(
            st.on_metadata(meta((MAX_SHARD_BYTES + 1) as i64))
                .unwrap_err(),
            ShardReject::TooLarge
        ));
        assert!(
            st.metadata.is_none(),
            "rejected metadata must not be stored"
        );
    }

    #[test]
    fn invalid_hash_rejected() {
        let mut st = ChannelReceiveState::new();
        let mut m = meta(1);
        m.hash = "..not-hex..".into();
        assert!(matches!(
            st.on_metadata(m).unwrap_err(),
            ShardReject::InvalidMetadata
        ));
    }

    #[test]
    fn chunk_cap_is_enforced_before_append() {
        let mut st = ChannelReceiveState::new();
        st.on_metadata(meta(MAX_SHARD_BYTES as i64)).unwrap();
        let bulk = vec![0u8; MAX_SHARD_BYTES];
        assert!(st.on_binary(&bulk).is_ok());
        assert_eq!(st.chunks.len(), MAX_SHARD_BYTES);
        // One more byte must be refused without growing the buffer.
        assert!(matches!(
            st.on_binary(&[1]).unwrap_err(),
            ShardReject::TooLarge
        ));
        assert_eq!(st.chunks.len(), MAX_SHARD_BYTES);
    }

    #[test]
    fn done_consumes_and_resets_state() {
        let mut st = ChannelReceiveState::new();
        st.on_metadata(meta(2)).unwrap();
        st.on_binary(b"ab").unwrap();
        let (m, chunks) = st.take_done().unwrap();
        assert_eq!(m.file_id, "f1");
        assert_eq!(chunks, b"ab");
        assert!(st.take_done().is_none(), "second take is empty");
    }

    #[test]
    fn shard_done_requires_explicit_boolean() {
        assert!(is_shard_done(r#"{"shard_done":true}"#));
        // The substring alone (e.g. inside a crafted file_id or as a string
        // value) must not be accepted.
        assert!(!is_shard_done(r#"{"file_id":"shard_done","size":1}"#));
        assert!(!is_shard_done(r#"{"shard_done":"true"}"#));
        assert!(!is_shard_done("not json"));
    }

    #[test]
    fn stall_is_only_detected_mid_transmission() {
        let mut st = ChannelReceiveState::new();
        // No metadata yet: not stalled.
        assert!(!st.is_stalled(Instant::now() + Duration::from_secs(3600)));
        st.on_metadata(meta(1)).unwrap();
        let future = Instant::now() + CHANNEL_STALL_TIMEOUT + Duration::from_secs(1);
        assert!(st.is_stalled(future));
        // Recent binary traffic resets the stall window.
        let mut st2 = ChannelReceiveState::new();
        st2.on_metadata(meta(1)).unwrap();
        st2.on_binary(b"z").unwrap();
        assert!(!st2.is_stalled(Instant::now() + Duration::from_secs(1)));
    }

    #[test]
    fn reaper_only_prunes_idle_and_disconnected() {
        let now = now_millis();
        let idle_past = now - SESSION_IDLE_TIMEOUT.as_millis() as u64 - 1;
        let created = now - 1000;
        // Idle + not connected -> prune.
        assert!(should_prune(created, idle_past, now, false));
        // Idle but the transport is still connected -> keep (long transfers).
        assert!(!should_prune(created, idle_past, now, true));
        // Recently active -> keep regardless of connection state.
        assert!(!should_prune(now, now, now, false));
    }

    #[test]
    fn reaper_prunes_connected_session_past_absolute_lifetime() {
        // Even a connected, recently-active session is reaped once it exceeds
        // MAX_SESSION_LIFETIME, so a device cannot pin memory/fds forever.
        let now = now_millis();
        let too_old = now - MAX_SESSION_LIFETIME.as_millis() as u64 - 1;
        assert!(should_prune(too_old, now, now, true));
    }

    #[tokio::test]
    async fn get_or_create_is_single_flight() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::db::open(dir.path()).await.unwrap();
        let store = Arc::new(
            ObjectStore::new(dir.path().to_path_buf(), db.clone())
                .await
                .unwrap(),
        );
        let identity = Arc::new(crate::identity::load_or_generate(dir.path()).unwrap());
        let manager = WebRtcManager::new(
            db.clone(),
            store,
            identity,
            crate::telemetry::Telemetry::new(),
        );

        // 8 concurrent callers for the same session id must all end up holding
        // the same Arc — exactly one peer connection is ever created.
        let mut handles = Vec::new();
        for _ in 0..8 {
            let m = manager.clone();
            handles.push(tokio::spawn(async move {
                m.get_or_create_session("sess-single-flight", "dev-1")
                    .await
                    .expect("session creation succeeds")
            }));
        }
        let mut sessions = Vec::new();
        for h in handles {
            sessions.push(h.await.unwrap());
        }
        for s in &sessions[1..] {
            assert!(
                Arc::ptr_eq(&sessions[0], s),
                "concurrent get_or_create must return the same Arc"
            );
        }
        let stored = manager.get_session("sess-single-flight").await.unwrap();
        assert_eq!(stored.device_id, "dev-1");
    }
}
