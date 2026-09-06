use futures_util::{SinkExt, StreamExt};
use sqlx::{Row, SqlitePool};
use std::sync::Arc;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;
use url::Url;

use super::engine::{apply_incoming_batch, drain_pending_fetches};
use super::outbox::{drain_unsynced_events, mark_events_synced};
use super::snapshot::is_rebuild_required_for;
use super::types::{
    BatchAckPayload, EventBatchPayload, NodeAuthChallengePayload, NodeAuthResponsePayload,
    NodeAuthResultPayload, PairingTokenPushPayload, PendingNotifyPayload, ProtocolEnvelope,
    RegisterPayload, ShardAckPayload, SyncCursor, SyncHelloPayload, SyncStatusPayload,
};
use crate::identity::NodeIdentity;
use crate::store::ObjectStore;

/// Derive the Relay's HTTP fetch endpoint from its WebSocket URL. The scheme
/// flips ws→http (wss→https) and the trailing /ws path segment is replaced by
/// /buffer/fetch (a plain host/port keeps the endpoint). Parsed once at
/// construction so the fetch URL is stable for the lifetime of the client
/// rather than string-mangled per request. URL parsing (rather than raw string
/// surgery) also drops stray query strings / trailing slashes that would
/// otherwise corrupt the endpoint.
pub fn relay_http_fetch_url(relay_url: &str) -> String {
    let mut url = match Url::parse(relay_url) {
        Ok(u) => u,
        // Degenerate config: keep the raw value so the node still attempts a
        // fetch instead of failing to boot over a malformed URL.
        Err(_) => return relay_url.to_string(),
    };
    let _ = url.set_scheme(if url.scheme() == "wss" {
        "https"
    } else {
        "http"
    });
    url.set_query(None);
    url.set_fragment(None);

    // Preserve any non-/ws base path (e.g. a proxied deployment) and only swap
    // the trailing ws segment for the fetch endpoint.
    let trimmed = url.path().trim_end_matches('/');
    let base = match trimmed.strip_suffix("/ws") {
        Some(dir) => dir.trim_end_matches('/'),
        None => trimmed,
    };
    url.set_path(&format!("{base}/buffer/fetch"));
    url.to_string()
}

pub struct SyncClient {
    pub relay_url: String,
    pub identity: Arc<NodeIdentity>,
    pub db: SqlitePool,
    pub batch_size: usize,
    pub object_store: Arc<ObjectStore>,
    pub http_fetch_url: String,
    pub http_client: reqwest::Client,
}

impl SyncClient {
    pub fn new(
        relay_url: String,
        identity: Arc<NodeIdentity>,
        db: SqlitePool,
        object_store: Arc<ObjectStore>,
        batch_size: usize,
    ) -> Self {
        Self {
            http_fetch_url: relay_http_fetch_url(&relay_url),
            relay_url,
            identity,
            db,
            object_store,
            batch_size,
            http_client: reqwest::Client::new(),
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
        let (ws_stream, _) = connect_async(&self.relay_url).await?;
        let (mut write, mut read) = ws_stream.split();

        // 1. Wait for auth challenge
        let mut authenticated = false;
        while let Some(msg_res) = read.next().await {
            let msg = msg_res?;
            if let Message::Text(text) = msg {
                let env: ProtocolEnvelope = serde_json::from_str(&text)?;
                if env.msg_type == "node_auth_challenge" {
                    let challenge: NodeAuthChallengePayload = serde_json::from_value(env.payload)?;
                    let resp = Self::sign_auth_challenge(&self.identity, &challenge);
                    let resp_env =
                        ProtocolEnvelope::new("node_auth_response", serde_json::to_value(resp)?);
                    write
                        .send(Message::Text(serde_json::to_string(&resp_env)?.into()))
                        .await?;
                } else if env.msg_type == "node_auth_result" {
                    let result: NodeAuthResultPayload = serde_json::from_value(env.payload)?;
                    if result.status == "ok" {
                        authenticated = true;
                        break;
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
        write
            .send(Message::Text(serde_json::to_string(&hello_env)?.into()))
            .await?;

        // 2b. Register with the Relay. The Relay only scans for RELAY_BUFFERED
        // shards after a `register` envelope, so this is what triggers
        // pending_notify delivery for shards uploaded while we were offline.
        let reg = RegisterPayload {
            account_id: None,
            device_id: None,
            node_id: self.identity.node_id.clone(),
            public_key: hex::encode(self.identity.public_key.to_bytes()),
            capabilities: vec!["node".to_string()],
        };
        let reg_env = ProtocolEnvelope::new("register", serde_json::to_value(&reg)?);
        write
            .send(Message::Text(serde_json::to_string(&reg_env)?.into()))
            .await?;

        // 3. Drain local outbox
        let unsynced = drain_unsynced_events(&self.db, self.batch_size as i64).await?;
        if !unsynced.is_empty() {
            let batch = EventBatchPayload { events: unsynced };
            let batch_env = ProtocolEnvelope::new("event_batch", serde_json::to_value(batch)?);
            write
                .send(Message::Text(serde_json::to_string(&batch_env)?.into()))
                .await?;
        }

        // 4. Read loop for incoming batches, SYNC_STATUS, and ACKs
        while let Some(msg_res) = read.next().await {
            let msg = msg_res?;
            if let Message::Text(text) = msg {
                let env: ProtocolEnvelope = serde_json::from_str(&text)?;
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
                        let ack_env =
                            ProtocolEnvelope::new("batch_ack", serde_json::to_value(ack)?);
                        write
                            .send(Message::Text(serde_json::to_string(&ack_env)?.into()))
                            .await?;
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
                        store_pairing_token(&self.db, &push).await?;
                    }
                    _ => {}
                }
            }
        }

        Ok(())
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
        write
            .send(Message::Text(serde_json::to_string(&env)?.into()))
            .await?;
        Ok(())
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
        let url = format!("{}?token={}", self.http_fetch_url, n.fetch_token);
        let resp = self.http_client.get(&url).send().await?;
        if !resp.status().is_success() {
            anyhow::bail!("relay /buffer/fetch returned {}", resp.status());
        }
        let bytes = resp.bytes().await?;

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
        write
            .send(Message::Text(serde_json::to_string(&begin_env)?.into()))
            .await?;

        for chunk in chunks {
            let chunk_env = ProtocolEnvelope::new("snapshot_chunk", serde_json::to_value(chunk)?);
            write
                .send(Message::Text(serde_json::to_string(&chunk_env)?.into()))
                .await?;
        }

        let end_env = ProtocolEnvelope::new("snapshot_end", serde_json::to_value(end)?);
        write
            .send(Message::Text(serde_json::to_string(&end_env)?.into()))
            .await?;

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
) -> anyhow::Result<()> {
    use base64::Engine;

    let device_pubkey =
        match base64::engine::general_purpose::STANDARD.decode(&push.device_public_key) {
            Ok(bytes) if bytes.len() == 32 => bytes,
            _ => return Ok(()),
        };

    sqlx::query(
        "INSERT INTO pairing_sessions (token, device_public_key, node_id, issued_at, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(token) DO UPDATE SET expires_at = excluded.expires_at",
    )
    .bind(&push.token)
    .bind(&device_pubkey)
    .bind(&push.node_id)
    .bind(chrono::Utc::now().to_rfc3339())
    .bind(&push.expires_at)
    .execute(db)
    .await?;

    Ok(())
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
}
