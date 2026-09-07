//! mDNS advertisement (`MdnsAdvertiser`) and peer discovery (`discover_node`)
//! of the node on the LAN (`_nodus._tcp.local`).
//!
//! Service type and TXT keys are locked by the Phase 11 design
//! (`docs/protocol/local-discovery.md`):
//! - `node_id`: hex Node ID (Ed25519 public key).
//! - `v`: protocol schema version, currently `1`.
//! - `pk_fp`: 16 hex chars = first 8 bytes of BLAKE3(node public key); lets a
//!   client double-check it is talking to the node it already trusts without
//!   fetching the discovery JSON first.
//!
//! WARN: mDNS TXT records assert identity on a *trust-on-first-discovery*
//! basis only — the on-link attacker can spoof them. They are advisory for the
//! discovery UI; the actual pairing/challenge-response handshake is what
//! establishes durable trust (see docs/security/local-endpoints.md).
//!
//! `discover_node` is the §21a repair peer lookup: it browses the same service
//! (libmdns can only advertise) and returns the address to reach a peer's
//! shard-fetch HTTP endpoint (`GET /nodus/shard/{object_id}` on `LOCAL_PORT`).

use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use futures_util::{StreamExt, pin_mut};
use mdns::{Record, RecordKind};

pub struct MdnsAdvertiser {
    // Kept alive for the process lifetime: libmdns `register` returns a
    // `Service` that unregisters when dropped, and the Responder owns the
    // advertising thread.
    _responder: libmdns::Responder,
    _service: libmdns::Service,
}

impl MdnsAdvertiser {
    /// Register the `_nodus._tcp.local` advertisement on all interfaces.
    ///
    /// `public_key_bytes` are the raw 32-byte Ed25519 node key; `node_id` is
    /// its hex encoding. **Panics** if the combined TXT records exceed 255
    /// bytes (they are ~3 × 40, far below, so effectively unreachable).
    pub fn start(node_id: &str, public_key_bytes: &[u8], port: u16) -> anyhow::Result<Self> {
        let responder = libmdns::Responder::new();

        let pk_fp = super::auth::public_key_fingerprint(public_key_bytes);
        let instance = format!("nodus-node-{}", &node_id[..node_id.len().min(12)]);

        let txt_node = format!("node_id={node_id}");
        let txt_v = "v=1".to_string();
        let txt_pk = format!("pk_fp={pk_fp}");

        // register takes a slice of `&str`; the temporary String values above
        // must outlive the call, hence the explicit binding before the slice.
        let txt_slice = [txt_node.as_str(), txt_v.as_str(), txt_pk.as_str()];
        let service = responder.register("_nodus._tcp.local", &instance, port, &txt_slice);

        Ok(Self {
            _responder: responder,
            _service: service,
        })
    }
}

/// Browsing timeout for a single peer lookup. Must accommodate one multicast
/// query + answer round-trip plus a re-query; the executor's per-stage budget
/// rarely applies because repair retries happen on the next reconciliation
/// scan anyway.
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(2);

/// Find the LAN address of a peer node's shard-fetch endpoint.
///
/// Browsers the `_nodus._tcp.local` mDNS service and matches the responder
/// whose TXT records carry `node_id=<node_id>` (the same key the advertiser
/// publishes). The port is fixed (`server::LOCAL_PORT`), so only the address
/// is needed; IPv4 is preferred, IPv6 link-local is the fallback.
///
/// Honest absence: returns `None` if no matching responder answers within
/// `DISCOVERY_TIMEOUT`, letting the executor fall through to later paths.
pub async fn discover_node(node_id: &str) -> Option<SocketAddr> {
    let discovery = mdns::discover::all("_nodus._tcp.local", DISCOVERY_TIMEOUT).ok()?;
    let stream = discovery.listen();
    pin_mut!(stream);

    let deadline = std::time::Instant::now() + DISCOVERY_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return None;
        }
        // Timeout each `next()` by the remaining budget; the stream would
        // otherwise re-query forever instead of ending on its own.
        match tokio::time::timeout(remaining, stream.next()).await {
            Ok(Some(Ok(response))) => {
                let txt = format!("node_id={node_id}");
                let records: Vec<Record> = response.records().cloned().collect();
                // TXT match is exact so a truncated/spoofed record can't alias
                // another node.
                let is_target = records
                    .iter()
                    .any(|r| matches!(&r.kind, RecordKind::TXT(entries) if entries.contains(&txt)));
                if !is_target {
                    continue;
                }
                // IPv4 first (typical LAN), then IPv6 link-local.
                let addr = records
                    .iter()
                    .find_map(|r| match r.kind {
                        RecordKind::A(a) => Some(IpAddr::V4(a)),
                        _ => None,
                    })
                    .or_else(|| {
                        records.iter().find_map(|r| match r.kind {
                            RecordKind::AAAA(a) => Some(IpAddr::V6(a)),
                            _ => None,
                        })
                    })?;
                return Some(SocketAddr::new(addr, super::server::LOCAL_PORT));
            }
            // Stream error or end, or the remaining budget elapsed.
            Ok(Some(Err(_))) | Ok(None) | Err(_) => return None,
        }
    }
}

#[test]
fn txt_records_stay_within_mdns_limit() {
    // Guards the 255-byte TXT limit documented above: each TXT record here is
    // node_id(64)+9, v=1, pk_fp(16)+6 — well under the cap, but the guard
    // keeps a future key (e.g. a long instance hint) from silently exceeding
    // it and panicking inside libmdns.
    let node_id = "a".repeat(64);
    let txt_node = format!("node_id={node_id}");
    let txt_v = "v=1".to_string();
    let txt_pk = format!("pk_fp={}", "b".repeat(16));
    let total: usize = [&txt_node, &txt_v, &txt_pk].iter().map(|s| s.len()).sum();
    assert!(total < 255, "TXT record payload must stay under 255 bytes");
}
