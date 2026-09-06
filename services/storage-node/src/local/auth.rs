//! Local challenge-response state and Ed25519 signature verification.
//!
//! The node's local HTTP listener authenticates clients to *this device* using
//! the device's Ed25519 public key (stored in `devices` after pairing). The
//! nonce store here enforces the single-use + TTL guarantees documented in
//! `docs/security/local-endpoints.md` — a nonce can never be replayed, even if
//! the client tries.

use std::collections::{HashMap, VecDeque};
use std::net::IpAddr;
use std::time::{Duration, Instant};

use anyhow::Context;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use tokio::sync::Mutex;

/// How long a challenge nonce remains valid before it must be discarded.
/// Mirrors the 30s window documented for `POST /nodus/challenge`.
pub const NONCE_TTL: Duration = Duration::from_secs(30);

/// Max /nodus/challenge requests allowed per IP within the rate window.
pub const CHALLENGE_RATE_LIMIT: usize = 10;
/// Sliding window for the challenge endpoint rate limiter.
pub const CHALLENGE_RATE_WINDOW: Duration = Duration::from_secs(10);
/// Hard cap on outstanding unconsumed nonces across all clients.
pub const NONCE_OUTSTANDING_CAP: usize = 500;

/// In-memory single-use nonce registry. Held behind a tokio mutex because the
/// challenge endpoint and every concurrent auth attempt share it; contention
/// is negligible at LAN scale.
pub struct NonceStore {
    inner: Mutex<HashMap<String, Instant>>,
    ttl: Duration,
    max_outstanding: usize,
}

impl Default for NonceStore {
    fn default() -> Self {
        Self::new(NONCE_TTL)
    }
}

impl NonceStore {
    pub fn new(ttl: Duration) -> Self {
        Self::with_cap(ttl, NONCE_OUTSTANDING_CAP)
    }

    pub fn with_cap(ttl: Duration, max_outstanding: usize) -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            ttl,
            max_outstanding,
        }
    }

    /// Issue a fresh 32-byte random nonce, hex-encoded, and remember it.
    /// Evicts expired nonces and enforces the outstanding cap.
    pub async fn issue(&self) -> Option<String> {
        let mut guard = self.inner.lock().await;
        let now = Instant::now();
        guard.retain(|_, issued_at| now.duration_since(*issued_at) < self.ttl);
        if guard.len() >= self.max_outstanding {
            return None;
        }
        let nonce = hex::encode(rand::random::<[u8; 32]>());
        guard.insert(nonce.clone(), now);
        Some(nonce)
    }

    /// Redeem a nonce. Returns `true` only for a known, unexpired nonce, which
    /// is then removed so a second use fails. Expired and unknown nonces are
    /// rejected without side effects.
    pub async fn consume(&self, nonce: &str) -> bool {
        let mut guard = self.inner.lock().await;
        match guard.get(nonce) {
            Some(issued_at) if issued_at.elapsed() < self.ttl => {
                guard.remove(nonce);
                true
            }
            _ => false,
        }
    }
}

/// Simple in-memory sliding-window rate limiter per IP address.
pub struct RateLimiter {
    window: Duration,
    max_per_window: usize,
    hits: Mutex<HashMap<IpAddr, VecDeque<Instant>>>,
}

impl RateLimiter {
    pub fn new(window: Duration, max_per_window: usize) -> Self {
        Self {
            window,
            max_per_window,
            hits: Mutex::new(HashMap::new()),
        }
    }

    /// Returns `true` if this IP is allowed to proceed, `false` if rate-limited.
    pub async fn check_and_record(&self, ip: IpAddr) -> bool {
        let mut guard = self.hits.lock().await;
        let now = Instant::now();
        let entry = guard.entry(ip).or_default();
        while entry.front().is_some_and(|t| now.duration_since(*t) >= self.window) {
            entry.pop_front();
        }
        if entry.len() >= self.max_per_window {
            return false;
        }
        entry.push_back(now);
        true
    }
}

/// Verify a hex-encoded Ed25519 signature over `message` against a raw
/// 32-byte public key.
pub fn verify_signature(
    public_key_bytes: &[u8],
    message: &[u8],
    signature_hex: &str,
) -> anyhow::Result<()> {
    let key_bytes: [u8; 32] = public_key_bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("device public key must be 32 bytes"))?;
    let key = VerifyingKey::from_bytes(&key_bytes)
        .map_err(|e| anyhow::anyhow!("invalid device public key: {e}"))?;

    let sig_bytes: [u8; 64] = hex::decode(signature_hex)
        .context("signature must be hex-encoded")?
        .try_into()
        .map_err(|_| anyhow::anyhow!("ed25519 signature must be 64 bytes"))?;
    let signature = Signature::from_bytes(&sig_bytes);

    // The nonce's exact bytes are what the client signed; hex is merely the
    // on-wire representation, so verification operates on the raw bytes.
    key.verify(message, &signature)
        .context("signature verification failed")
}

/// Derive the short `pk_fp` advertised in mDNS/TXT and returned in the
/// discovery advertisement: the first 8 bytes of a BLAKE3 hash of the public
/// key, hex-encoded.
pub fn public_key_fingerprint(public_key_bytes: &[u8]) -> String {
    blake3::hash(public_key_bytes).to_hex()[..16].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn sample_key() -> SigningKey {
        SigningKey::from_bytes(&[7u8; 32])
    }

    #[tokio::test]
    async fn nonce_is_single_use() {
        let store = NonceStore::new(Duration::from_secs(30));
        let nonce = store.issue().await.expect("should issue nonce");
        assert!(store.consume(&nonce).await, "first use should succeed");
        assert!(!store.consume(&nonce).await, "second use must fail");
    }

    #[tokio::test]
    async fn nonce_ttl_expiry_rejected() {
        let store = NonceStore::new(Duration::ZERO);
        let nonce = store.issue().await.expect("should issue nonce");
        assert!(
            !store.consume(&nonce).await,
            "an already-expired nonce must be rejected"
        );
    }

    #[tokio::test]
    async fn nonce_cap_enforced() {
        let store = NonceStore::with_cap(Duration::from_secs(30), 2);
        let n1 = store.issue().await;
        let n2 = store.issue().await;
        let n3 = store.issue().await;
        assert!(n1.is_some());
        assert!(n2.is_some());
        assert!(n3.is_none(), "cap of 2 must reject third issue");

        // Consuming one frees up a slot
        assert!(store.consume(&n1.unwrap()).await);
        let n4 = store.issue().await;
        assert!(n4.is_some(), "after consume, capacity is available");
    }

    #[tokio::test]
    async fn rate_limiter_blocks_after_limit() {
        let rl = RateLimiter::new(Duration::from_secs(10), 3);
        let ip: IpAddr = "127.0.0.1".parse().unwrap();
        assert!(rl.check_and_record(ip).await);
        assert!(rl.check_and_record(ip).await);
        assert!(rl.check_and_record(ip).await);
        assert!(!rl.check_and_record(ip).await, "4th request must be blocked");

        let other_ip: IpAddr = "192.168.1.1".parse().unwrap();
        assert!(rl.check_and_record(other_ip).await, "other IP is unaffected");
    }

    #[tokio::test]
    async fn unknown_nonce_rejected() {
        let store = NonceStore::new(Duration::from_secs(30));
        assert!(!store.consume(&"deadbeef".to_string()).await);
    }

    #[test]
    fn verify_signature_roundtrip() {
        let signing = sample_key();
        let verifying = signing.verifying_key();
        let msg = b"the challenge nonce bytes";
        let sig = signing.sign(msg);
        assert!(verify_signature(&verifying.to_bytes(), msg, &hex::encode(sig.to_bytes())).is_ok());
        // A different message must fail verification.
        assert!(
            verify_signature(
                &verifying.to_bytes(),
                b"other",
                &hex::encode(sig.to_bytes())
            )
            .is_err()
        );
    }

    #[test]
    fn fingerprint_is_16_hex_chars() {
        assert_eq!(public_key_fingerprint(&[1u8; 32]).len(), 16);
    }
}
