use futures_util::{SinkExt, StreamExt};
use sqlx::{Row, SqlitePool};
use std::sync::Arc;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

use super::engine::apply_incoming_batch;
use super::outbox::{drain_unsynced_events, mark_events_synced};
use super::snapshot::is_rebuild_required_for;
use super::types::{
    BatchAckPayload, EventBatchPayload, NodeAuthChallengePayload, NodeAuthResponsePayload,
    NodeAuthResultPayload, ProtocolEnvelope, SyncCursor, SyncHelloPayload, SyncStatusPayload,
};
use crate::identity::NodeIdentity;

pub struct SyncClient {
    pub relay_url: String,
    pub identity: Arc<NodeIdentity>,
    pub db: SqlitePool,
    pub batch_size: usize,
}

impl SyncClient {
    pub fn new(
        relay_url: String,
        identity: Arc<NodeIdentity>,
        db: SqlitePool,
        batch_size: usize,
    ) -> Self {
        Self {
            relay_url,
            identity,
            db,
            batch_size,
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
                    "rebuild_required" => {
                        if is_rebuild_required_for(&env.payload, &self.identity.node_id).is_some() {
                            self.stream_snapshot(&mut write).await?;
                        }
                    }
                    _ => {}
                }
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
}
