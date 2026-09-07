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
        file_id: &str,
        version_number: i64,
        shard_index: i64,
    ) -> tokio::sync::oneshot::Receiver<TransferResult> {
        self.pool.submit(ShardTransferRequest {
            transfer_id: uuid::Uuid::new_v4().to_string(),
            file_id: file_id.to_string(),
            version_number,
            shard_index,
            data: Vec::new(), // Populated by the attempter
            hash: String::new(),
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
            let _ = self.pool.submit(request);
        }
    }
}
