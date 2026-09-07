use std::sync::Arc;

use super::cache::SqlitePathCache;
use super::config::TransferConfig;
use super::executor::PathAttempt;
use super::pool::ConcurrencyPool;
use super::queue::MemoryLocalQueue;
use super::types::{ShardTransferRequest, TransferResult};

/// High-level transfer manager — the public entry point for shard transfers.
pub struct TransferManager {
    pool: ConcurrencyPool,
    queue: MemoryLocalQueue,
}

impl TransferManager {
    pub fn new(
        config: TransferConfig,
        cache: SqlitePathCache,
        attempter: Arc<dyn PathAttempt>,
    ) -> Self {
        Self {
            pool: ConcurrencyPool::new(config, cache, attempter),
            queue: MemoryLocalQueue::new(),
        }
    }

    /// Submit a shard transfer. Returns a receiver that resolves when complete.
    pub fn fetch_shard(
        &self,
        from_node: &str,
        object_id: &str,
    ) -> tokio::sync::oneshot::Receiver<TransferResult> {
        let file_id = "";
        self.pool.submit(ShardTransferRequest {
            transfer_id: uuid::Uuid::new_v4().to_string(),
            file_id: file_id.to_string(),
            version_number: 0,
            shard_index: 0,
            // fetch: `data` is the response field; for the outgoing request
            // the peer supplies the shard bytes, so it stays empty.
            data: Vec::new(),
            // `object_id` is the expected BLAKE3 hash the repair loop
            // restores bytes under; carried through so the result can verify.
            hash: object_id.to_string(),
            object_id: object_id.to_string(),
            target_node: from_node.to_string(),
            source_device: None,
        })
    }

    /// Submit a shard push to a remote node.
    pub fn push_shard(
        &self,
        to_node: &str,
        request: ShardTransferRequest,
    ) -> tokio::sync::oneshot::Receiver<TransferResult> {
        self.pool.submit(ShardTransferRequest {
            target_node: to_node.to_string(),
            ..request
        })
    }

    /// Enqueue a failed transfer for Path D retry.
    pub async fn enqueue(&self, request: ShardTransferRequest) {
        self.queue.enqueue(request).await;
    }

    /// Process the local queue — called when connectivity is restored.
    pub async fn drain_queue(&self) {
        while let Some(request) = self.queue.dequeue().await {
            // Fire-and-forget: pool.submit starts the transfer via tokio::spawn
            // and returns only the completion notification, which we discard.
            std::mem::drop(self.pool.submit(request));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transfer::executor::PathAttempt;
    use crate::transfer::types::{TransferPath, TransferResult};

    fn fast_config() -> TransferConfig {
        TransferConfig {
            max_concurrency: 4,
            local_discovery_timeout_ms: 2000,
            webrtc_negotiation_timeout_ms: 4000,
            relay_signaling_timeout_ms: 3000,
            backoff_base_ms: 0,
            backoff_jitter_ms: 0,
            max_retries_per_stage: 1,
        }
    }

    fn request(i: usize) -> ShardTransferRequest {
        ShardTransferRequest {
            transfer_id: format!("t{i}"),
            file_id: "f1".into(),
            version_number: 1,
            shard_index: i as i64,
            data: vec![1, 2, 3],
            hash: "hash".into(),
            object_id: "hash".into(),
            target_node: "node-1".into(),
            source_device: None,
        }
    }

    /// Succeeds on the first path; records every attempted path.
    struct RecordingAttempter {
        seen: std::sync::Mutex<Vec<TransferPath>>,
    }

    #[async_trait::async_trait]
    impl PathAttempt for RecordingAttempter {
        async fn attempt(
            &self,
            request: &ShardTransferRequest,
            path: TransferPath,
        ) -> TransferResult {
            self.seen.lock().unwrap().push(path);
            TransferResult {
                path,
                duration_ms: 0,
                transfer_id: request.transfer_id.clone(),
                bytes_transferred: request.data.len(),
                success: true,
                error: None,
                data: request.data.clone(),
                object_id: request.object_id.clone(),
            }
        }
    }

    #[tokio::test]
    async fn drain_queue_resubmits_enqueued_transfers_into_pool() {
        let dir = tempfile::tempdir().unwrap();
        let cache = SqlitePathCache::new(crate::db::open(dir.path()).await.unwrap());
        let attempter = Arc::new(RecordingAttempter {
            seen: std::sync::Mutex::new(Vec::new()),
        });
        let manager = TransferManager::new(fast_config(), cache, attempter.clone());

        manager.enqueue(request(1)).await;
        manager.drain_queue().await;

        // drain_queue resubmits through the pool's spawned task (no backoff
        // sleeps in fast_config), so the first path is attempted immediately.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
        loop {
            if !attempter.seen.lock().unwrap().is_empty() {
                break;
            }
            if std::time::Instant::now() >= deadline {
                panic!("drained transfer never reached the attempter");
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert_eq!(
            *attempter.seen.lock().unwrap(),
            vec![TransferPath::LocalSignaling]
        );
    }
}
