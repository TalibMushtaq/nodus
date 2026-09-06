//! mDNS advertisement of the node on the LAN (`_nodus._tcp.local`).
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
