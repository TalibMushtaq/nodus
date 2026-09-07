use rand::Rng;

/// Exponential backoff with jitter.
///
/// `delay = base_ms * 2^attempt + random(0, jitter_ms)`
///
/// Identical formula and shape to the TS side (see spec §"Backoff & Retry").
pub fn backoff_delay(attempt: u32, base_ms: u64, jitter_ms: u64) -> u64 {
    let exponential = base_ms * 2u64.saturating_pow(attempt);
    let jitter = rand::thread_rng().gen_range(0..=jitter_ms);
    exponential + jitter
}

/// Sleep for the calculated backoff delay.
pub async fn sleep_backoff(attempt: u32, base_ms: u64, jitter_ms: u64) {
    let ms = backoff_delay(attempt, base_ms, jitter_ms);
    tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_delay_grows_exponentially() {
        let d0 = backoff_delay(0, 500, 0);
        let d1 = backoff_delay(1, 500, 0);
        let d2 = backoff_delay(2, 500, 0);
        assert_eq!(d0, 500);
        assert_eq!(d1, 1000);
        assert_eq!(d2, 2000);
    }

    #[test]
    fn backoff_delay_jitter_is_non_negative() {
        for _ in 0..100 {
            let d = backoff_delay(0, 500, 300);
            assert!(d >= 500);
            assert!(d <= 800);
        }
    }
}
