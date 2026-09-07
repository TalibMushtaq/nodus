use std::sync::Arc;

use super::cache::SqlitePathCache;
use super::config::TransferConfig;
use super::executor::{execute_transfer, PathAttempt};
use super::types::{ShardTransferRequest, TransferResult};
use tokio::sync::Semaphore;

/// Bounded concurrency pool for per-shard transfers.
///
/// Each transfer runs its own independent fallback state machine.
/// Excess transfers are queued FIFO and picked up as slots free.
pub struct ConcurrencyPool {
    semaphore: Arc<Semaphore>,
    config: TransferConfig,
    cache: SqlitePathCache,
    attempter: Arc<dyn PathAttempt>,
}

impl ConcurrencyPool {
    pub fn new(
        config: TransferConfig,
        cache: SqlitePathCache,
        attempter: Arc<dyn PathAttempt>,
    ) -> Self {
        Self {
            semaphore: Arc::new(Semaphore::new(config.max_concurrency)),
            config,
            cache,
            attempter,
        }
    }

    /// Submit a shard transfer. Returns a receiver that resolves when complete.
    pub fn submit(
        &self,
        request: ShardTransferRequest,
    ) -> tokio::sync::oneshot::Receiver<TransferResult> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let sem = self.semaphore.clone();
        let config = TransferConfig {
            max_concurrency: self.config.max_concurrency,
            local_discovery_timeout_ms: self.config.local_discovery_timeout_ms,
            webrtc_negotiation_timeout_ms: self.config.webrtc_negotiation_timeout_ms,
            relay_signaling_timeout_ms: self.config.relay_signaling_timeout_ms,
            backoff_base_ms: self.config.backoff_base_ms,
            backoff_jitter_ms: self.config.backoff_jitter_ms,
            max_retries_per_stage: self.config.max_retries_per_stage,
        };
        let cache = SqlitePathCache::new(self.cache.pool().clone());
        let attempter = self.attempter.clone();

        tokio::spawn(async move {
            let _permit = sem.acquire().await.expect("semaphore closed");
            let result = execute_transfer(&request, &config, &cache, attempter.as_ref()).await;
            let _ = tx.send(result);
        });

        rx
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transfer::types::{ShardTransferRequest, TransferPath};
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn fast_config(max_concurrency: usize) -> TransferConfig {
        TransferConfig {
            max_concurrency,
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
            data: vec![1],
            hash: "hash".into(),
            target_node: "node-1".into(),
            source_device: None,
        }
    }

    struct CountingAttempter {
        running: AtomicUsize,
        peak: AtomicUsize,
    }

    #[async_trait::async_trait]
    impl PathAttempt for CountingAttempter {
        async fn attempt(&self, request: &ShardTransferRequest, path: TransferPath) -> TransferResult {
            let now = self.running.fetch_add(1, Ordering::SeqCst) + 1;
            self.peak.fetch_max(now, Ordering::SeqCst);
            // Yield so concurrent transfers overlap; bounded by the semaphore.
            tokio::task::yield_now().await;
            self.running.fetch_sub(1, Ordering::SeqCst);
            TransferResult {
                path,
                duration_ms: 1,
                transfer_id: request.transfer_id.clone(),
                bytes_transferred: 1,
                success: true,
                error: None,
            }
        }
    }

    #[tokio::test]
    async fn never_exceeds_max_concurrency() {
        let dir = tempfile::tempdir().unwrap();
        let cache = SqlitePathCache::new(crate::db::open(dir.path()).await.unwrap());
        let attempter = Arc::new(CountingAttempter {
            running: AtomicUsize::new(0),
            peak: AtomicUsize::new(0),
        });
        let pool = ConcurrencyPool::new(fast_config(2), cache, attempter.clone());

        let mut receivers = Vec::new();
        for i in 0..8 {
            receivers.push(pool.submit(request(i)));
        }
        for rx in receivers {
            assert!(rx.await.unwrap().success);
        }

        assert!(attempter.peak.load(Ordering::SeqCst) <= 2, "peak was {}", attempter.peak.load(Ordering::SeqCst));
    }
}
