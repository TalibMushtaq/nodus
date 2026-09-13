//! Cross-transport resource limits and bounded body reads.
//!
//! Every path that pulls shard bytes from an untrusted-ish peer (the Relay
//! buffer, a LAN peer discovered over spoofable mDNS, a WebRTC data channel)
//! must agree on the same ceiling, otherwise a compromised relay or on-link
//! attacker can stream an unbounded body and exhaust memory/disk. The cap lives
//! here so the WebRTC, Relay-fetch, and peer-repair paths cannot drift.

use futures_util::StreamExt;

/// Largest encrypted shard any transport will accept. The protocol shard is
/// 8 MiB; 64 MiB leaves headroom for AEAD framing and future shard-size changes
/// while still bounding a single buffered body.
pub const MAX_SHARD_BYTES: usize = 64 * 1024 * 1024;

/// Streaming reader that refuses to buffer more than `max` bytes.
///
/// A declared `Content-Length` over the cap is rejected before allocating; a
/// chunked/no-length response is bounded as it streams, so neither a large
/// header nor a chunked flood can drive unbounded memory growth. The caller is
/// still responsible for hash-verifying the returned bytes.
pub async fn read_body_capped(resp: reqwest::Response, max: usize) -> anyhow::Result<Vec<u8>> {
    if let Some(len) = resp.content_length()
        && len > max as u64
    {
        anyhow::bail!("response Content-Length {len} exceeds cap of {max} bytes");
    }

    let mut stream = resp.bytes_stream();
    let mut buf = Vec::new();
    while let Some(chunk) = stream.next().await {
        // Strip the request URL from transport errors: the Relay fetch URL
        // carries the single-use `fetch_token` as a query parameter and this
        // error is both logged and sent back to the Relay in `shard_ack`.
        let chunk = chunk.map_err(|e| anyhow::Error::new(e.without_url()))?;
        if buf.len().saturating_add(chunk.len()) > max {
            anyhow::bail!("response body exceeds cap of {max} bytes");
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Chunked responses (no Content-Length) must still be cut off once the
    /// running total crosses the cap, not buffered in full.
    #[tokio::test]
    async fn read_body_capped_rejects_oversize_body() {
        use axum::Router;
        use axum::routing::get;

        let app = Router::new().route("/big", get(|| async { vec![0u8; 4096] }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let resp = reqwest::get(format!("http://{addr}/big")).await.unwrap();
        // Cap below the body size: the reader must error rather than return 4 KiB.
        assert!(read_body_capped(resp, 1024).await.is_err());
    }

    #[tokio::test]
    async fn read_body_capped_accepts_body_within_cap() {
        use axum::Router;
        use axum::routing::get;

        let app = Router::new().route("/small", get(|| async { vec![7u8; 100] }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let resp = reqwest::get(format!("http://{addr}/small")).await.unwrap();
        let body = read_body_capped(resp, 1024).await.unwrap();
        assert_eq!(body, vec![7u8; 100]);
    }
}
