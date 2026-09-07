use super::backoff::sleep_backoff;
use super::cache::SqlitePathCache;
use super::config::TransferConfig;
use super::types::{ShardTransferRequest, TransferPath, TransferResult};

/// Ordered fallback chain — same as TS side.
const FALLBACK_CHAIN: &[TransferPath] = &[
    TransferPath::LocalSignaling,
    TransferPath::RelaySignaling,
    TransferPath::BufferRelay,
    TransferPath::LocalQueue,
];

/// Paths whose success should be cached.
const CACHABLE_PATHS: &[TransferPath] =
    &[TransferPath::LocalSignaling, TransferPath::RelaySignaling];

/// Attempt a single transfer path. Injected by the manager.
/// The caller provides the actual WebRTC/relay/buffer logic.
#[async_trait::async_trait]
pub trait PathAttempt: Send + Sync {
    async fn attempt(&self, request: &ShardTransferRequest, path: TransferPath) -> TransferResult;
}

/// Execute the full fallback chain for a single shard transfer.
///
/// Returns on first success or after all paths are exhausted.
pub async fn execute_transfer(
    request: &ShardTransferRequest,
    config: &TransferConfig,
    cache: &SqlitePathCache,
    attempter: &dyn PathAttempt,
) -> TransferResult {
    let node_id = &request.target_node;

    // Check path cache — if a known-good path exists, try it first
    let cached = cache.get(node_id).await.unwrap_or(None);

    let mut chain: Vec<TransferPath> = if let Some(cached_path) = cached {
        let mut v = vec![cached_path];
        for &p in FALLBACK_CHAIN {
            if p != cached_path {
                v.push(p);
            }
        }
        v
    } else {
        FALLBACK_CHAIN.to_vec()
    };

    let mut last_result: Option<TransferResult> = None;

    for path in chain.drain(..) {
        for attempt in 0..=config.max_retries_per_stage {
            if attempt > 0 {
                sleep_backoff(
                    (attempt - 1) as u32,
                    config.backoff_base_ms,
                    config.backoff_jitter_ms,
                )
                .await;
            }

            let result = attempter.attempt(request, path).await;

            if result.success {
                // Cache successful high-quality paths
                if CACHABLE_PATHS.contains(&path) {
                    let _ = cache.set(node_id, path).await;
                }
                return result;
            }

            // If the cached path failed, evict immediately and don't retry it
            if cached == Some(path) {
                let _ = cache.evict(node_id).await;
                break; // Fall through to next path
            }

            last_result = Some(result);
        }
    }

    last_result.unwrap_or(TransferResult {
        path: TransferPath::LocalQueue,
        duration_ms: 0,
        transfer_id: request.transfer_id.clone(),
        bytes_transferred: 0,
        success: false,
        error: Some("all paths exhausted".to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transfer::types::ShardTransferRequest;

    /// No-op backoff so tests don't sleep.
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

    fn request(node: &str) -> ShardTransferRequest {
        ShardTransferRequest {
            transfer_id: "t1".into(),
            file_id: "f1".into(),
            version_number: 1,
            shard_index: 0,
            data: vec![1, 2, 3],
            hash: "hash".into(),
            target_node: node.to_string(),
            source_device: None,
        }
    }

    /// Records the paths it was asked to attempt, and succeeds only on a
    /// configurable set.
    struct RecordingAttempter {
        seen: std::sync::Mutex<Vec<TransferPath>>,
        succeed_on: Vec<TransferPath>,
    }

    #[async_trait::async_trait]
    impl PathAttempt for RecordingAttempter {
        async fn attempt(
            &self,
            request: &ShardTransferRequest,
            path: TransferPath,
        ) -> TransferResult {
            self.seen.lock().unwrap().push(path);
            let ok = self.succeed_on.contains(&path);
            TransferResult {
                path,
                duration_ms: 1,
                transfer_id: request.transfer_id.clone(),
                bytes_transferred: if ok { request.data.len() } else { 0 },
                success: ok,
                error: if ok { None } else { Some("down".into()) },
            }
        }
    }

    async fn test_db(data_dir: &std::path::Path) -> SqlitePathCache {
        SqlitePathCache::new(crate::db::open(data_dir).await.unwrap())
    }

    #[tokio::test]
    async fn attempts_cached_path_first() {
        let dir = tempfile::tempdir().unwrap();
        let cache = test_db(dir.path()).await;
        // Seed the path cache with a prior success on relay signaling.
        sqlx::query("INSERT INTO trusted_nodes (node_id, public_key_bytes, created_at, last_successful_path) VALUES (?, ?, ?, ?)")
            .bind("node-1")
            .bind(vec![0u8; 32])
            .bind(chrono::Utc::now().to_rfc3339())
            .bind("relay_signaling")
            .execute(cache.pool())
            .await
            .unwrap();

        let attempter = RecordingAttempter {
            seen: std::sync::Mutex::new(Vec::new()),
            succeed_on: vec![TransferPath::RelaySignaling],
        };

        let result = execute_transfer(&request("node-1"), &fast_config(), &cache, &attempter).await;

        assert!(result.success);
        assert_eq!(
            *attempter.seen.lock().unwrap(),
            vec![TransferPath::RelaySignaling]
        );
    }

    #[tokio::test]
    async fn falls_through_to_relay_when_local_fails() {
        let dir = tempfile::tempdir().unwrap();
        let cache = test_db(dir.path()).await;
        // Cache writes are an UPDATE on an existing trusted_nodes row.
        sqlx::query(
            "INSERT INTO trusted_nodes (node_id, public_key_bytes, created_at) VALUES (?, ?, ?)",
        )
        .bind("node-2")
        .bind(vec![0u8; 32])
        .bind(chrono::Utc::now().to_rfc3339())
        .execute(cache.pool())
        .await
        .unwrap();
        let attempter = RecordingAttempter {
            seen: std::sync::Mutex::new(Vec::new()),
            succeed_on: vec![TransferPath::RelaySignaling],
        };

        let result = execute_transfer(&request("node-2"), &fast_config(), &cache, &attempter).await;

        assert!(result.success);
        assert_eq!(result.path, TransferPath::RelaySignaling);
        // local_signaling was attempted max_retries_per_stage+1 times, then relay succeeds.
        let seen = attempter.seen.lock().unwrap().clone();
        assert_eq!(
            seen,
            vec![
                TransferPath::LocalSignaling,
                TransferPath::LocalSignaling,
                TransferPath::RelaySignaling
            ]
        );

        // The relay success is a cachable path — the cache is written.
        assert_eq!(
            cache.get("node-2").await.unwrap(),
            Some(TransferPath::RelaySignaling)
        );
    }

    #[tokio::test]
    async fn cached_path_failure_evicts_without_retry() {
        let dir = tempfile::tempdir().unwrap();
        let cache = test_db(dir.path()).await;
        sqlx::query("INSERT INTO trusted_nodes (node_id, public_key_bytes, created_at, last_successful_path) VALUES (?, ?, ?, ?)")
            .bind("node-3")
            .bind(vec![0u8; 32])
            .bind(chrono::Utc::now().to_rfc3339())
            .bind("local_signaling")
            .execute(cache.pool())
            .await
            .unwrap();

        // Everything fails; cached local_signaling must be attempted once only.
        let attempter = RecordingAttempter {
            seen: std::sync::Mutex::new(Vec::new()),
            succeed_on: vec![],
        };

        let result = execute_transfer(&request("node-3"), &fast_config(), &cache, &attempter).await;

        assert!(!result.success);
        assert_eq!(
            attempter
                .seen
                .lock()
                .unwrap()
                .iter()
                .filter(|p| **p == TransferPath::LocalSignaling)
                .count(),
            1
        );
        // The failed cached path is evicted immediately.
        assert_eq!(cache.get("node-3").await.unwrap(), None);
    }

    #[tokio::test]
    async fn reports_last_failure_when_everything_is_down() {
        let dir = tempfile::tempdir().unwrap();
        let cache = test_db(dir.path()).await;
        let attempter = RecordingAttempter {
            seen: std::sync::Mutex::new(Vec::new()),
            succeed_on: vec![],
        };

        let result = execute_transfer(&request("node-4"), &fast_config(), &cache, &attempter).await;

        assert!(!result.success);
        assert_eq!(result.error.as_deref(), Some("down"));
    }
}
