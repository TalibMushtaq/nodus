use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, StatusCode};
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
    let webrtc_manager = Arc::new(WebRtcManager::new(
        db.clone(),
        store.clone(),
        identity.clone(),
    ));
    let nonces = Arc::new(NonceStore::default());
    let challenge_limiter = Arc::new(RateLimiter::new(Duration::from_secs(10), 100));

    // Register a trusted device in database
    sqlx::query(
        "INSERT INTO devices (device_id, public_key_bytes, status, created_at)
         VALUES ('dev-trusted-1', X'0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20', 'ACTIVE', 'now')",
    )
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

    // 1. Post Offer to /nodus/webrtc/offer
    let offer_body = serde_json::json!({
        "session_id": "sess-test-01",
        "device_id": "dev-trusted-1",
        "sdp": offer.sdp,
    });

    let req = Request::builder()
        .uri("/nodus/webrtc/offer")
        .method("POST")
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(&offer_body).unwrap()))
        .unwrap();

    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(json["session_id"], "sess-test-01");
    let answer_sdp = json["sdp"].as_str().unwrap();
    assert!(answer_sdp.contains("v=0"));

    // 2. Post ICE candidate to /nodus/webrtc/ice
    let ice_body = serde_json::json!({
        "session_id": "sess-test-01",
        "device_id": "dev-trusted-1",
        "candidate": "candidate:1 1 UDP 2130706431 127.0.0.1 50000 typ host",
    });

    let req_ice = Request::builder()
        .uri("/nodus/webrtc/ice")
        .method("POST")
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(&ice_body).unwrap()))
        .unwrap();

    let resp_ice = app.clone().oneshot(req_ice).await.unwrap();
    assert_eq!(resp_ice.status(), StatusCode::OK);

    // 3. Test unauthorized device rejected
    let unauth_body = serde_json::json!({
        "session_id": "sess-test-02",
        "device_id": "dev-unknown-attacker",
        "sdp": offer.sdp,
    });

    let req_unauth = Request::builder()
        .uri("/nodus/webrtc/offer")
        .method("POST")
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(&unauth_body).unwrap()))
        .unwrap();

    let resp_unauth = app.oneshot(req_unauth).await.unwrap();
    assert_eq!(resp_unauth.status(), StatusCode::UNAUTHORIZED);
}
