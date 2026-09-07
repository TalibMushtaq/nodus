use std::env;

/// Default transfer manager configuration.
/// All values are configurable via environment variables.
#[derive(Clone)]
pub struct TransferConfig {
    pub max_concurrency: usize,
    pub local_discovery_timeout_ms: u64,
    pub webrtc_negotiation_timeout_ms: u64,
    pub relay_signaling_timeout_ms: u64,
    pub backoff_base_ms: u64,
    pub backoff_jitter_ms: u64,
    pub max_retries_per_stage: usize,
}

impl Default for TransferConfig {
    fn default() -> Self {
        Self {
            max_concurrency: env::var("NODUS_TM_MAX_CONCURRENCY")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(4),
            local_discovery_timeout_ms: env::var("NODUS_TM_LOCAL_DISCOVERY_TIMEOUT_MS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(2000),
            webrtc_negotiation_timeout_ms: env::var("NODUS_TM_WEBRTC_TIMEOUT_MS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(4000),
            relay_signaling_timeout_ms: env::var("NODUS_TM_RELAY_TIMEOUT_MS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(3000),
            backoff_base_ms: env::var("NODUS_TM_BACKOFF_BASE_MS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(500),
            backoff_jitter_ms: env::var("NODUS_TM_BACKOFF_JITTER_MS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(300),
            max_retries_per_stage: env::var("NODUS_TM_MAX_RETRIES_PER_STAGE")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(2),
        }
    }
}
