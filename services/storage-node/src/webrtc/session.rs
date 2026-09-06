use std::collections::HashMap;
use std::sync::Arc;
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
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;

use crate::identity::NodeIdentity;
use crate::store::ObjectStore;

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

#[derive(Default)]
struct ChannelReceiveState {
    metadata: Option<ShardUploadPayload>,
    chunks: Vec<u8>,
}

pub struct WebRtcSession {
    #[allow(dead_code)]
    pub session_id: String,
    pub device_id: String,
    pub peer_connection: Arc<RTCPeerConnection>,
    pub ice_tx: broadcast::Sender<String>,
    pub created_at: Instant,
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

        peer_connection.on_data_channel(Box::new(move |dc: Arc<RTCDataChannel>| {
            let db = db_clone.clone();
            let store = store_clone.clone();
            let identity = identity_clone.clone();

            Box::pin(async move {
                let state = Arc::new(Mutex::new(ChannelReceiveState::default()));

                let state_clone = state.clone();
                let dc_clone = dc.clone();

                dc.on_message(Box::new(move |msg: DataChannelMessage| {
                    let state = state_clone.clone();
                    let dc = dc_clone.clone();
                    let db = db.clone();
                    let store = store.clone();
                    let identity = identity.clone();

                    Box::pin(async move {
                        if msg.is_string {
                            let text = match String::from_utf8(msg.data.to_vec()) {
                                Ok(t) => t,
                                Err(_) => return,
                            };

                            if text.contains("\"shard_done\"") {
                                // Shard transmission finished, verify and commit
                                let mut st = state.lock().await;
                                let metadata = match st.metadata.take() {
                                    Some(m) => m,
                                    None => return,
                                };
                                let chunks = std::mem::take(&mut st.chunks);
                                drop(st);

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
                                let size_bytes = chunks.len() as i64;
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
                            } else if let Ok(meta) = serde_json::from_str::<ShardUploadPayload>(&text) {
                                let mut st = state.lock().await;
                                st.metadata = Some(meta);
                                st.chunks.clear();

                                // Spawn timeout task to clear state if transmission stalls
                                let state_timeout = state.clone();
                                tokio::spawn(async move {
                                    tokio::time::sleep(Duration::from_secs(300)).await;
                                    let mut st = state_timeout.lock().await;
                                    if st.metadata.is_some() {
                                        st.metadata = None;
                                        st.chunks.clear();
                                    }
                                });
                            }
                        } else {
                            // Binary chunk received
                            let mut st = state.lock().await;
                            st.chunks.extend_from_slice(&msg.data);
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
            created_at: Instant::now(),
        })
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

/// WebRtcManager manages active WebRTC sessions and handles lifecycle/TTL.
#[derive(Clone)]
pub struct WebRtcManager {
    sessions: Arc<RwLock<HashMap<String, Arc<WebRtcSession>>>>,
    db: SqlitePool,
    store: Arc<ObjectStore>,
    identity: Arc<NodeIdentity>,
}

impl WebRtcManager {
    pub fn new(db: SqlitePool, store: Arc<ObjectStore>, identity: Arc<NodeIdentity>) -> Self {
        let manager = Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            db,
            store,
            identity,
        };

        // Spawn reaper task to clean up abandoned sessions after 5 minutes
        let sessions_clone = manager.sessions.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(60));
            loop {
                interval.tick().await;
                let mut lock = sessions_clone.write().await;
                lock.retain(|_, session| session.created_at.elapsed() < Duration::from_secs(300));
            }
        });

        manager
    }

    pub async fn get_or_create_session(
        &self,
        session_id: &str,
        device_id: &str,
    ) -> anyhow::Result<Arc<WebRtcSession>> {
        {
            let lock = self.sessions.read().await;
            if let Some(sess) = lock.get(session_id) {
                if sess.device_id != device_id {
                    bail!("device_id mismatch for existing session");
                }
                return Ok(sess.clone());
            }
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

        let mut lock = self.sessions.write().await;
        lock.insert(session_id.to_string(), session.clone());
        Ok(session)
    }

    pub async fn get_session(&self, session_id: &str) -> Option<Arc<WebRtcSession>> {
        let lock = self.sessions.read().await;
        lock.get(session_id).cloned()
    }
}
