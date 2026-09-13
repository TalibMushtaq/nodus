use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use ed25519_dalek::{Signer, SigningKey};
use http_body_util::BodyExt;
use tempfile::tempdir;
use tower::ServiceExt;

use storage_node::db;
use storage_node::identity;
use storage_node::local::auth::{NonceStore, RateLimiter};
use storage_node::local::server::{LocalState, make_router};
use storage_node::store::ObjectStore;
use storage_node::webrtc::WebRtcManager;
use webrtc::api::APIBuilder;
use webrtc::peer_connection::configuration::RTCConfiguration;

/// Signed `POST` request: every WebRTC signaling call must prove device
/// possession with a fresh signature over `"{device_id}:{session_id}:{timestamp}"`.
fn signed_post(
    path: &str,
    body: serde_json::Value,
    device_id: &str,
    session_id: &str,
    key: &SigningKey,
) -> Request<Body> {
    let timestamp = chrono::Utc::now().timestamp_millis();
    let message = format!("{device_id}:{session_id}:{timestamp}");
    let signature = hex::encode(key.sign(message.as_bytes()).to_bytes());
    Request::builder()
        .uri(path)
        .method("POST")
        .header("content-type", "application/json")
        .header("x-nodus-device-id", device_id)
        .header("x-nodus-timestamp", timestamp.to_string())
        .header("x-nodus-signature", signature)
        .body(Body::from(serde_json::to_vec(&body).unwrap()))
        .unwrap()
}

#[tokio::test]
async fn test_webrtc_offer_and_ice_endpoint_roundtrip() {
    let dir = tempdir().unwrap();
    let db = db::open(dir.path()).await.unwrap();
    let identity = Arc::new(identity::load_or_generate(dir.path()).unwrap());
    let store = Arc::new(
        ObjectStore::new(dir.path().to_path_buf(), db.clone())
            .await
            .unwrap(),
    );
    let telemetry = storage_node::telemetry::Telemetry::new();
    let webrtc_manager = Arc::new(WebRtcManager::new(
        db.clone(),
        store.clone(),
        identity.clone(),
        telemetry.clone(),
    ));
    let nonces = Arc::new(NonceStore::default());
    let challenge_limiter = Arc::new(RateLimiter::new(Duration::from_secs(10), 100));

    // Register a trusted device with the key the requests below sign with.
    let device_key = SigningKey::from_bytes(&[42u8; 32]);
    let device_pubkey = device_key.verifying_key().to_bytes();
    sqlx::query(
        "INSERT INTO devices (device_id, public_key_bytes, status, created_at)
         VALUES ('dev-trusted-1', ?, 'ACTIVE', 'now')",
    )
    .bind(&device_pubkey[..])
    .execute(&db)
    .await
    .unwrap();

    let state = LocalState {
        identity: identity.clone(),
        db: db.clone(),
        store,
        webrtc_manager,
        nonces,
        challenge_limiter,
        relay_http_base: None,
        http: reqwest::Client::new(),
        telemetry,
    };

    let app = make_router(state);

    // Create a real WebRTC client offer using webrtc crate
    let api = APIBuilder::new().build();
    let client_pc = api
        .new_peer_connection(RTCConfiguration::default())
        .await
        .unwrap();
    let _dc = client_pc
        .create_data_channel("nodus-shard-0", None)
        .await
        .unwrap();
    let offer = client_pc.create_offer(None).await.unwrap();
    client_pc
        .set_local_description(offer.clone())
        .await
        .unwrap();

    // 1. Post a SIGNED Offer to /nodus/webrtc/offer
    let offer_body = serde_json::json!({
        "session_id": "sess-test-01",
        "device_id": "dev-trusted-1",
        "sdp": offer.sdp,
    });

    let req = signed_post(
        "/nodus/webrtc/offer",
        offer_body,
        "dev-trusted-1",
        "sess-test-01",
        &device_key,
    );
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(json["session_id"], "sess-test-01");
    let answer_sdp = json["sdp"].as_str().unwrap();
    assert!(answer_sdp.contains("v=0"));

    // 2. Post a SIGNED ICE candidate to /nodus/webrtc/ice
    let ice_body = serde_json::json!({
        "session_id": "sess-test-01",
        "device_id": "dev-trusted-1",
        "candidate": "candidate:1 1 UDP 2130706431 127.0.0.1 50000 typ host",
    });

    let req_ice = signed_post(
        "/nodus/webrtc/ice",
        ice_body,
        "dev-trusted-1",
        "sess-test-01",
        &device_key,
    );
    let resp_ice = app.clone().oneshot(req_ice).await.unwrap();
    assert_eq!(resp_ice.status(), StatusCode::OK);

    // 3. An unsigned offer is rejected outright (previously accepted).
    let unsigned_body = serde_json::json!({
        "session_id": "sess-test-01",
        "device_id": "dev-trusted-1",
        "sdp": offer.sdp,
    });
    let unsigned = Request::builder()
        .uri("/nodus/webrtc/offer")
        .method("POST")
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(&unsigned_body).unwrap()))
        .unwrap();
    let resp_unsigned = app.clone().oneshot(unsigned).await.unwrap();
    assert_eq!(resp_unsigned.status(), StatusCode::UNAUTHORIZED);

    // 4. Unknown device even with a valid signature is rejected.
    let stranger_key = SigningKey::from_bytes(&[77u8; 32]);
    let stranger_body = serde_json::json!({
        "session_id": "sess-test-02",
        "device_id": "dev-unknown-attacker",
        "sdp": offer.sdp,
    });
    let req_unauth = signed_post(
        "/nodus/webrtc/offer",
        stranger_body,
        "dev-unknown-attacker",
        "sess-test-02",
        &stranger_key,
    );
    let resp_unauth = app.oneshot(req_unauth).await.unwrap();
    assert_eq!(resp_unauth.status(), StatusCode::UNAUTHORIZED);
}
