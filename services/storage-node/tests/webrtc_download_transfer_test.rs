//! Live two-peer WebRTC download (shard fetch) test.
//!
//! The node's `WebRtcManager` is one peer; the `webrtc` crate is the other,
//! standing in for the browser/device. After the real SDP + ICE handshake, the
//! device sends a `shard_fetch` request and the node streams the stored
//! ciphertext back as [header][binary][done]. This proves the download direction
//! end-to-end — the upload counterpart is covered by
//! `webrtc_session_transfer_test.rs`.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tempfile::tempdir;
use tokio::sync::{Mutex, mpsc};

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
async fn test_live_webrtc_serves_a_stored_shard() {
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

    // Seed the shard the device will ask for: object bytes plus the metadata row
    // the node checks before serving. `pending_shard_fetches` has no FK to
    // file_versions, so it stands in for a shard whose version event has not
    // arrived yet — the same state the fetch authorization accepts.
    let file_id = "file-download";
    let payload = b"stored-shard-ciphertext-for-download".to_vec();
    let hash = store.put(&payload).await.unwrap();
    sqlx::query(
        "INSERT INTO pending_shard_fetches \
         (file_id, version_number, shard_index, object_id, size_bytes, fetched_at) \
         VALUES (?, 1, 0, ?, ?, ?)",
    )
    .bind(file_id)
    .bind(&hash)
    .bind(payload.len() as i64)
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(&db)
    .await
    .unwrap();

    let session = manager
        .get_or_create_session("sess-download", "dev-download")
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

    // Collect inbound frames: binary bytes into `received`, text markers into a
    // channel so the test can wait for the terminal `shard_data_done`.
    let received: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let (marker_tx, mut marker_rx) = mpsc::unbounded_channel::<serde_json::Value>();
    let dc = client
        .create_data_channel("nodus-shard", None)
        .await
        .unwrap();
    {
        let received = received.clone();
        dc.on_message(Box::new(move |msg: DataChannelMessage| {
            let received = received.clone();
            let marker_tx = marker_tx.clone();
            Box::pin(async move {
                if msg.is_string {
                    if let Ok(text) = String::from_utf8(msg.data.to_vec())
                        && let Ok(json) = serde_json::from_str::<serde_json::Value>(&text)
                    {
                        let _ = marker_tx.send(json);
                    }
                } else {
                    received.lock().await.extend_from_slice(&msg.data);
                }
            })
        }));
    }

    // ── handshake ────────────────────────────────────────────────────────────
    let offer = client.create_offer(None).await.unwrap();
    client.set_local_description(offer.clone()).await.unwrap();

    let answer_sdp = tokio::time::timeout(TIMEOUT, session.handle_offer(&offer.sdp))
        .await
        .expect("node did not answer the offer in time")
        .expect("node failed to handle the offer");

    client_ready.store(true, Ordering::SeqCst);
    for init in std::mem::take(&mut *client_pending.lock().await) {
        let json = serde_json::to_string(&init).unwrap_or_default();
        let _ = session.add_ice_candidate(&json).await;
    }

    client
        .set_remote_description(RTCSessionDescription::answer(answer_sdp).unwrap())
        .await
        .unwrap();

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

    // ── request the stored shard ─────────────────────────────────────────────
    let request = serde_json::json!({
        "shard_fetch": true,
        "file_id": file_id,
        "version_number": 1,
        "shard_index": 0,
        "hash": hash,
        "size": payload.len(),
        "transfer_id": "t-download",
    });
    dc.send_text(request.to_string()).await.unwrap();

    let mut saw_header = false;
    loop {
        let marker = tokio::time::timeout(TIMEOUT, marker_rx.recv())
            .await
            .expect("timed out waiting for a shard-data marker")
            .expect("marker channel closed");
        if marker["shard_data"] == true {
            saw_header = true;
            assert_eq!(marker["hash"], hash);
        }
        if marker["shard_data_done"] == true {
            break;
        }
        if marker["shard_data_error"] == true {
            panic!("node rejected the fetch: {marker}");
        }
    }

    assert!(saw_header, "node never sent the shard_data header");
    assert_eq!(
        received.lock().await.as_slice(),
        payload.as_slice(),
        "node streamed the wrong bytes"
    );

    // The device has no key envelope for this file on the node, so the fetch is
    // allowed but audited (option b: do not block a download whose envelope has
    // not synced yet), exactly once despite the request.
    let audit: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM security_events WHERE event_type = 'shard_fetch_without_envelope'",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(audit, 1, "missing envelope should be audited exactly once");
}
