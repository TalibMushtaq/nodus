//! Live two-peer WebRTC transfer test.
//!
//! The node's `WebRtcManager` is one peer; the `webrtc` crate is the other,
//! standing in for the browser/device. They complete a real SDP + ICE
//! handshake over loopback and stream TWO shards over ONE data channel. That
//! proves two things the unit tests cannot: the transport actually moves bytes
//! end-to-end, and a session can carry more than one shard (the property the
//! browser's persistent-session reuse depends on).
//!
//! Signaling here is in-process (the offer is passed straight to
//! `session.handle_offer`); the relay-signaled Path B wiring is covered by the
//! web adapter test and the node's `relay_signaling_verifies_device_signature`
//! test. The transport exercised below is shared by Path A and Path B.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tempfile::tempdir;
use tokio::sync::Mutex;

use storage_node::db;
use storage_node::identity;
use storage_node::store::ObjectStore;
use storage_node::webrtc::WebRtcManager;
use webrtc::api::APIBuilder;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::data_channel::data_channel_state::RTCDataChannelState;
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;

const TIMEOUT: Duration = Duration::from_secs(30);

#[tokio::test]
async fn test_live_webrtc_session_transfers_two_shards() {
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

    let session = manager
        .get_or_create_session("sess-live", "dev-live")
        .await
        .unwrap();
    session.touch();

    // ── client peer (stands in for the browser) ──────────────────────────────
    let api = APIBuilder::new().build();
    let client = Arc::new(
        api.new_peer_connection(RTCConfiguration::default())
            .await
            .unwrap(),
    );

    // Candidates can be produced before the *other* peer has set its remote
    // description; buffer each side's candidates until that side is ready.
    let client_pending: Arc<Mutex<Vec<RTCIceCandidateInit>>> = Arc::new(Mutex::new(Vec::new()));
    let client_ready = Arc::new(AtomicBool::new(false));
    {
        let session = session.clone();
        let pending = client_pending.clone();
        let ready = client_ready.clone();
        client.on_ice_candidate(Box::new(move |candidate| {
            let session = session.clone();
            let pending = pending.clone();
            let ready = ready.clone();
            Box::pin(async move {
                let Some(candidate) = candidate else { return };
                let Ok(init) = candidate.to_json() else {
                    return;
                };
                if ready.load(Ordering::SeqCst) {
                    let json = serde_json::to_string(&init).unwrap_or_default();
                    let _ = session.add_ice_candidate(&json).await;
                } else {
                    pending.lock().await.push(init);
                }
            })
        }));
    }

    let node_pending: Arc<Mutex<Vec<RTCIceCandidateInit>>> = Arc::new(Mutex::new(Vec::new()));
    let node_ready = Arc::new(AtomicBool::new(false));
    {
        let mut rx = session.subscribe_ice();
        let client = client.clone();
        let pending = node_pending.clone();
        let ready = node_ready.clone();
        tokio::spawn(async move {
            while let Ok(text) = rx.recv().await {
                if let Ok(init) = serde_json::from_str::<RTCIceCandidateInit>(&text) {
                    if ready.load(Ordering::SeqCst) {
                        let _ = client.add_ice_candidate(init).await;
                    } else {
                        pending.lock().await.push(init);
                    }
                }
            }
        });
    }

    // Data channel + ack collection.
    let dc = client
        .create_data_channel("nodus-shard", None)
        .await
        .unwrap();
    let (ack_tx, mut ack_rx) = tokio::sync::mpsc::unbounded_channel::<serde_json::Value>();
    dc.on_message(Box::new(move |msg: DataChannelMessage| {
        let ack_tx = ack_tx.clone();
        Box::pin(async move {
            if !msg.is_string {
                return;
            }
            if let Ok(text) = String::from_utf8(msg.data.to_vec()) {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                    let _ = ack_tx.send(json);
                }
            }
        })
    }));

    // ── handshake ────────────────────────────────────────────────────────────
    let offer = client.create_offer(None).await.unwrap();
    client.set_local_description(offer.clone()).await.unwrap();

    let answer_sdp = tokio::time::timeout(TIMEOUT, session.handle_offer(&offer.sdp))
        .await
        .expect("node did not answer the offer in time")
        .expect("node failed to handle the offer");

    // Now the node has a remote description: flush the client's candidates.
    client_ready.store(true, Ordering::SeqCst);
    for init in std::mem::take(&mut *client_pending.lock().await) {
        let json = serde_json::to_string(&init).unwrap_or_default();
        let _ = session.add_ice_candidate(&json).await;
    }

    client
        .set_remote_description(RTCSessionDescription::answer(answer_sdp).unwrap())
        .await
        .unwrap();

    // Now the client has a remote description: flush the node's candidates.
    node_ready.store(true, Ordering::SeqCst);
    for init in std::mem::take(&mut *node_pending.lock().await) {
        let _ = client.add_ice_candidate(init).await;
    }

    tokio::time::timeout(TIMEOUT, async {
        while dc.ready_state() != RTCDataChannelState::Open {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("data channel never opened");

    // ── two shards over ONE channel ──────────────────────────────────────────
    for (index, payload) in [
        (0i64, b"first-shard-ciphertext".to_vec()),
        (1i64, b"second-shard-ciphertext".to_vec()),
    ] {
        let hash = blake3::hash(&payload).to_hex().to_string();
        let meta = serde_json::json!({
            "file_id": "file-live",
            "version_number": 1,
            "shard_index": index,
            "hash": hash,
            "size": payload.len(),
            "transfer_id": "t-live",
            "target_node": identity.node_id,
            "source_device": "dev-live",
        });
        dc.send_text(meta.to_string()).await.unwrap();
        dc.send(&bytes::Bytes::from(payload)).await.unwrap();
        dc.send_text(serde_json::json!({ "shard_done": true }).to_string())
            .await
            .unwrap();

        let ack = tokio::time::timeout(TIMEOUT, ack_rx.recv())
            .await
            .expect("timed out waiting for the shard ack")
            .expect("ack channel closed");
        assert_eq!(
            ack["status"], "verified",
            "shard {index} not verified: {ack}"
        );
        assert!(
            store.exists(&hash),
            "shard {index} bytes were not written to the object store"
        );
    }
}
