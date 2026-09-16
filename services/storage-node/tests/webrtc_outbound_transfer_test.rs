//! Live outbound (Path B) transfer test.
//!
//! `OutboundSession` (the holder node's initiator) connects to the node's own
//! `WebRtcSession` (the repairing node's answerer) over a real SDP + ICE
//! handshake on loopback and streams one shard. This proves the Path B
//! dataplane — the sender framing matches what the receiver stores — without a
//! Relay. The relay-signaled offer/answer/ICE plumbing is exercised separately
//! by the sync-client signaling tests.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tempfile::tempdir;
use tokio::sync::Mutex;

use storage_node::db;
use storage_node::identity;
use storage_node::store::ObjectStore;
use storage_node::webrtc::OutboundSession;
use storage_node::webrtc::WebRtcManager;
use storage_node::webrtc::session::ShardUploadPayload;

const TIMEOUT: Duration = Duration::from_secs(30);

#[tokio::test]
async fn test_outbound_session_streams_a_shard_into_answerer() {
    let dir = tempdir().unwrap();
    let db = db::open(dir.path()).await.unwrap();
    let identity = Arc::new(identity::load_or_generate(dir.path()).unwrap());
    let store = Arc::new(
        ObjectStore::new(dir.path().to_path_buf(), db.clone())
            .await
            .unwrap(),
    );
    let telemetry = storage_node::telemetry::Telemetry::new();
    let manager = Arc::new(WebRtcManager::new(
        db.clone(),
        store.clone(),
        identity.clone(),
        telemetry,
    ));

    // Answerer = the repairing node's inbound session.
    let answerer = manager
        .get_or_create_session("sess-outbound", "peer-node")
        .await
        .unwrap();
    answerer.touch();

    // Initiator = the holder node.
    let outbound = Arc::new(OutboundSession::new().await.unwrap());

    // Each side's local candidates are buffered until the other side has set a
    // remote description, then drained.
    let outbound_pending: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let outbound_ready = Arc::new(AtomicBool::new(false));
    {
        let mut rx = answerer.subscribe_ice();
        let outbound = Arc::clone(&outbound);
        let pending = Arc::clone(&outbound_pending);
        let ready = Arc::clone(&outbound_ready);
        tokio::spawn(async move {
            while let Ok(text) = rx.recv().await {
                if ready.load(Ordering::SeqCst) {
                    let _ = outbound.add_ice_candidate(&text).await;
                } else {
                    pending.lock().await.push(text);
                }
            }
        });
    }

    let answerer_pending: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let answerer_ready = Arc::new(AtomicBool::new(false));
    {
        let mut rx = outbound.subscribe_ice();
        let answerer = answerer.clone();
        let pending = Arc::clone(&answerer_pending);
        let ready = Arc::clone(&answerer_ready);
        tokio::spawn(async move {
            while let Ok(text) = rx.recv().await {
                if ready.load(Ordering::SeqCst) {
                    let _ = answerer.add_ice_candidate(&text).await;
                } else {
                    pending.lock().await.push(text);
                }
            }
        });
    }

    // ── handshake ────────────────────────────────────────────────────────────
    let offer_sdp = tokio::time::timeout(TIMEOUT, outbound.create_offer())
        .await
        .expect("offer timed out")
        .expect("offer creation failed");

    let answer_sdp = tokio::time::timeout(TIMEOUT, answerer.handle_offer(&offer_sdp))
        .await
        .expect("answerer did not answer in time")
        .expect("answerer failed to handle the offer");

    // The initiator now has a remote description: flush the answerer candidates.
    outbound_ready.store(true, Ordering::SeqCst);
    for text in std::mem::take(&mut *outbound_pending.lock().await) {
        let _ = outbound.add_ice_candidate(&text).await;
    }

    outbound.set_answer(&answer_sdp).await.unwrap();

    // The answerer has a remote description: flush the initiator candidates.
    answerer_ready.store(true, Ordering::SeqCst);
    for text in std::mem::take(&mut *answerer_pending.lock().await) {
        let _ = answerer.add_ice_candidate(&text).await;
    }

    // ── one shard ────────────────────────────────────────────────────────────
    let payload = b"outbound-path-b-shard".to_vec();
    let hash = blake3::hash(&payload).to_hex().to_string();
    let meta = ShardUploadPayload {
        file_id: "file-path-b".to_string(),
        version_number: 1,
        shard_index: 0,
        hash: hash.clone(),
        size: payload.len() as i64,
        transfer_id: "t-path-b".to_string(),
        target_node: Some(identity.node_id.clone()),
        source_device: Some("peer-node".to_string()),
    };

    let ack = tokio::time::timeout(TIMEOUT, outbound.send_shard(&meta, &payload))
        .await
        .expect("send_shard timed out")
        .expect("send_shard failed");

    assert_eq!(ack.status, "verified", "unexpected ack: {ack:?}");
    assert!(
        store.exists(&hash),
        "answerer did not write the shard to its object store"
    );

    outbound.close().await;
}
