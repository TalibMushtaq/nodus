//! Local HTTP listener for discovery, pairing and challenge-response auth.
//!
//! Serves the Phase 11 endpooints on the same port advertised over mDNS:
//! - `GET  /nodus/discovery` — node advertisement (`LocalDiscoveryAdvertisement`)
//! - `POST /nodus/challenge` — issue a single-use nonce
//! - `POST /nodus/auth`      — Ed25519 challenge-response against `devices`
//! - `POST /nodus/pair`      — redeem a Relay-issued pairing token
//!
//! The listener is intentionally *plain HTTP* with permissive CORS (design
//! decision B in the Phase 11 spec): local-network exposure is acceptable
//! because authentication is the challenge-response handshake itself, not
//! transport security. See docs/security/local-endpoints.md for the accepted
//! risks (DNS rebinding, on-link sniffing of pairing tokens).
//!
//! All handlers respond in the `LocalError` JSON shape `{ error, message }`
//! from `packages/protocol/src/messages/lib` (mirrored below), so web/mobile
//! clients get a uniform error contract.

use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::Context;
use axum::extract::{ConnectInfo, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use serde::{Deserialize, Serialize};
use sqlx::sqlite::SqlitePool;
use tower_http::cors::CorsLayer;

use crate::identity::NodeIdentity;
use crate::sync::client::relay_http_fetch_url;

use super::auth::{NonceStore, RateLimiter, verify_signature};

/// Schema version reported in the discovery advertisement. Keep in sync with
/// `CURRENT_SCHEMA_VERSION` in packages/protocol.
pub const SCHEMA_VERSION: &str = "1.0";

/// Local listener port. Advertised in mDNS and used for the pairing QR URL.
pub const LOCAL_PORT: u16 = 9378;

/// HTTP base on which startup failures are the caller's problem: the server
/// returns bind results to the caller via this shared struct.
#[derive(Clone)]
pub struct LocalState {
    pub identity: Arc<NodeIdentity>,
    pub db: SqlitePool,
    #[allow(dead_code)]
    pub store: Arc<crate::store::ObjectStore>,
    pub webrtc_manager: Arc<crate::webrtc::WebRtcManager>,
    pub nonces: Arc<NonceStore>,
    pub challenge_limiter: Arc<RateLimiter>,
    /// Derived Relay HTTP base (ws→http, /ws dropped), reused for the
    /// `/pairing/sessions/verify` fallback. `None` disables the fallback.
    pub relay_http_base: Option<String>,
    pub http: reqwest::Client,
}

// ── Wire shapes (mirror packages/protocol HTTP-only schemas) ──────────────

#[derive(Serialize)]
struct DiscoveryAdvertisement {
    node_id: String,
    public_key: String,
    schema_version: &'static str,
    pk_fp: String,
}

#[derive(Serialize)]
struct Challenge {
    nonce: String,
    ttl_seconds: u64,
}

#[derive(Deserialize)]
struct AuthRequest {
    device_id: String,
    /// The issued nonce whose bytes were signed — single-use.
    nonce: String,
    /// Ed25519 signature over the nonce bytes, hex-encoded.
    signature: String,
}

#[derive(Serialize)]
struct AuthResult {
    status: &'static str,
    node_id: String,
}

#[derive(Deserialize)]
struct PairRequest {
    node_id: String,
    /// Relay-issued pairing token.
    token: String,
    /// Raw Ed25519 pubkey bytes this device will be stored under (base64).
    device_public_key: String,
    device_id: String,
}

#[derive(Serialize)]
struct PairConfirm {
    node_id: String,
    account_id: String,
    device_id: String,
    device_public_key: String,
}

#[derive(Serialize, Deserialize)]
pub struct LocalError {
    pub error: String,
    pub message: String,
}

/// Pairing-token row shape returned by the Relay's `/pairing/sessions/verify`.
#[derive(Deserialize)]
struct RelayVerify {
    valid: bool,
    account_id: Option<String>,
    device_public_key: Option<String>,
    node_id: Option<String>,
}

/// Build the router with all Phase 11 handlers wired in.
pub fn make_router(state: LocalState) -> Router {
    Router::new()
        .route("/nodus/discovery", get(discovery))
        .route("/nodus/challenge", post(challenge))
        .route("/nodus/auth", post(auth))
        .route("/nodus/pair", post(pair))
        .route(
            "/nodus/webrtc/offer",
            post(crate::webrtc::handler::handle_offer),
        )
        .route(
            "/nodus/webrtc/ice",
            post(crate::webrtc::handler::handle_ice_candidate),
        )
        .route(
            "/nodus/webrtc/ice-candidates",
            get(crate::webrtc::handler::stream_ice_candidates),
        )
        // Permissive CORS: the web client (a *browser* origin) must be able to
        // read /nodus/discovery and POST /nodus/*. mDNS TXT is spoofable and
        // the node has no notion of allowed origins in v1, so allow all — the
        // challenge-response handshake is the actual access control.
        .layer(CorsLayer::permissive())
        .with_state(state)
}

/// Bind the local listener and return the socket + task handle.
///
/// `relay_url` is the node's configured Relay WS URL; when set (the normal
/// case) the server derives the Relay HTTP base for the verify fallback.
pub async fn spawn(
    identity: Arc<NodeIdentity>,
    db: SqlitePool,
    store: Arc<crate::store::ObjectStore>,
    relay_url: Option<&str>,
) -> anyhow::Result<tokio::task::JoinHandle<()>> {
    let relay_http_base = relay_url.map(|u| {
        // Same ws→http derivation the sync client already uses for
        // /buffer/fetch; reuse it to stay consistent about base-path handling.
        relay_http_fetch_url(u)
            .trim_end_matches("/buffer/fetch")
            .to_string()
    });

    let webrtc_manager = Arc::new(crate::webrtc::WebRtcManager::new(
        db.clone(),
        store.clone(),
        identity.clone(),
    ));

    let state = LocalState {
        identity,
        db,
        store,
        webrtc_manager,
        nonces: Arc::new(NonceStore::default()),
        challenge_limiter: Arc::new(RateLimiter::new(
            super::auth::CHALLENGE_RATE_WINDOW,
            super::auth::CHALLENGE_RATE_LIMIT,
        )),
        relay_http_base,
        http: reqwest::Client::new(),
    };

    let addr: SocketAddr = ([0, 0, 0, 0], LOCAL_PORT).into();
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("binding local listener on {addr}"))?;
    let app = make_router(state);

    let handle = tokio::spawn(async move {
        if let Err(e) = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        {
            eprintln!("local http server error: {e}");
        }
    });
    Ok(handle)
}

// ── Handlers ─────────────────────────────────────────────────────────────

async fn discovery(
    State(state): State<LocalState>,
) -> Result<Json<DiscoveryAdvertisement>, LocalError> {
    let resp = DiscoveryAdvertisement {
        node_id: state.identity.node_id.clone(),
        public_key: hex::encode(state.identity.public_key.as_bytes()),
        schema_version: SCHEMA_VERSION,
        pk_fp: super::auth::public_key_fingerprint(state.identity.public_key.as_bytes()),
    };
    Ok(Json(resp))
}

async fn challenge(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<LocalState>,
) -> Result<Json<Challenge>, LocalError> {
    if !state.challenge_limiter.check_and_record(addr.ip()).await {
        return Err(LocalError {
            error: "rate_limited".into(),
            message: "too many challenge requests; try again shortly".into(),
        });
    }
    let nonce = state.nonces.issue().await.ok_or_else(|| LocalError {
        error: "overloaded".into(),
        message: "challenge store is at capacity; retry in 30s".into(),
    })?;
    Ok(Json(Challenge {
        nonce,
        ttl_seconds: super::auth::NONCE_TTL.as_secs(),
    }))
}

async fn auth(
    State(state): State<LocalState>,
    Json(req): Json<AuthRequest>,
) -> Result<Json<AuthResult>, LocalError> {
    // Single-use: an attempted auth with an unissued/non-recent nonce fails
    // closed, even if the signature were valid.
    if !state.nonces.consume(&req.nonce).await {
        return Err(LocalError {
            error: "invalid_nonce".into(),
            message: "challenge nonce was not issued, is expired, or already used".into(),
        });
    }

    let row = sqlx::query_as::<_, (Vec<u8>, String)>(
        "SELECT public_key_bytes, status FROM devices WHERE device_id = ?",
    )
    .bind(&req.device_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| LocalError {
        error: "internal".into(),
        message: format!("auth lookup failed: {e}"),
    })?;

    let Some((pubkey, status)) = row else {
        return Err(LocalError {
            error: "unknown_device".into(),
            message: "this device has not been paired with this node".into(),
        });
    };

    if status != "ACTIVE" {
        return Err(LocalError {
            error: "device_revoked".into(),
            message: "this device was revoked on this node".into(),
        });
    }

    // The client signs the exact nonce bytes (hex on the wire). Verify before
    // touching any mutable state.
    let nonce_bytes = req.nonce.as_bytes();
    if let Err(e) = verify_signature(&pubkey, nonce_bytes, &req.signature) {
        return Err(LocalError {
            error: "bad_signature".into(),
            message: format!("signature verification failed: {e}"),
        });
    }

    sqlx::query("UPDATE devices SET last_authenticated_at = ? WHERE device_id = ?")
        .bind(now_iso())
        .bind(&req.device_id)
        .execute(&state.db)
        .await
        .map_err(|e| LocalError {
            error: "internal".into(),
            message: format!("updating device record failed: {e}"),
        })?;

    Ok(Json(AuthResult {
        status: "ok",
        node_id: state.identity.node_id.clone(),
    }))
}

// ── Pairing ──────────────────────────────────────────────────────────────

async fn pair(
    State(state): State<LocalState>,
    Json(req): Json<PairRequest>,
) -> Result<Json<PairConfirm>, LocalError> {
    // The token must belong to *this* node — a cut-and-pasted token aimed at
    // another node must not be accidentally redeemed here.
    if req.node_id != state.identity.node_id {
        return Err(LocalError {
            error: "wrong_node".into(),
            message: "this token was issued for a different node".into(),
        });
    }

    let pubkey_bytes = decode_pubkey(&req.device_public_key)?;

    let row = sqlx::query_as::<_, (Vec<u8>, String, String, Option<String>, String, String)>(
        "SELECT device_public_key, node_id, issued_at, consumed_at, expires_at, account_id
         FROM pairing_sessions WHERE token = ?",
    )
    .bind(&req.token)
    .fetch_optional(&state.db)
    .await
    .map_err(internal_err)?;

    if let Some((bound_key, node_id, _issued_at, consumed_at, expires_at, account_id)) = row {
        // Local fast path: the Relay already pushed this token to us over WS.
        let session = LocalSessionRow {
            bound_key: &bound_key,
            node_id: &node_id,
            consumed_at: &consumed_at,
            expires_at: &expires_at,
            account_id: &account_id,
        };
        redeem_from_local(&state, &req, &pubkey_bytes, session).await
    } else {
        // Fallback: consult the Relay. Only possible while the node has Relay
        // connectivity — a fully offline node rejects pairing with a clear error.
        let Some(base) = state.relay_http_base.clone() else {
            return Err(LocalError {
                error: "pairing_unavailable".into(),
                message: "token not found locally and no Relay connection is configured".into(),
            });
        };

        let verify_url = format!("{base}/pairing/sessions/verify");
        let resp = state
            .http
            .post(&verify_url)
            .json(&serde_json::json!({ "token": req.token }))
            .send()
            .await
            .map_err(|e| LocalError {
                error: "relay_unreachable".into(),
                message: format!("relay verification failed: {e}"),
            })?;

        let status = resp.status();
        let relay: RelayVerify = resp.json().await.map_err(|e| LocalError {
            error: "relay_error".into(),
            message: format!("relay verification response was invalid: {e}"),
        })?;

        if !relay.valid || status != StatusCode::OK {
            return Err(LocalError {
                error: "token_invalid".into(),
                message: "the Relay rejected this pairing token".into(),
            });
        }

        // Defence-in-depth: confirm the Relay's response is for *this* node.
        if relay
            .node_id
            .as_deref()
            .is_some_and(|id| id != state.identity.node_id)
        {
            return Err(LocalError {
                error: "wrong_node".into(),
                message: "relay verified token for a different node".into(),
            });
        }

        let bound_key = relay.device_public_key.ok_or_else(|| LocalError {
            error: "token_invalid".into(),
            message: "relay response did not include the bound device key".into(),
        })?;

        // The token was bound to one specific device public key at issuance —
        // the device presenting it must match, or the token is unusable.
        let bound_raw = base64_decode(&bound_key)?;
        if bound_raw != pubkey_bytes {
            return Err(LocalError {
                error: "key_mismatch".into(),
                message: "this token is bound to a different device key".into(),
            });
        }

        let account_id = relay.account_id.unwrap_or_else(|| "offline".into());
        store_device(&state, &req, &pubkey_bytes, &account_id).await
    }
}

struct LocalSessionRow<'a> {
    bound_key: &'a [u8],
    node_id: &'a str,
    consumed_at: &'a Option<String>,
    expires_at: &'a str,
    account_id: &'a str,
}

/// Redeem a token already stored by the Relay's WS push (`pairing_token_push`).
/// `bound_key` is the raw 32-byte public key the Relay bound the token to
/// (stored as the table's BLOB) — compared directly against the presented key.
async fn redeem_from_local(
    state: &LocalState,
    req: &PairRequest,
    pubkey_bytes: &[u8],
    session: LocalSessionRow<'_>,
) -> Result<Json<PairConfirm>, LocalError> {
    if session.node_id != state.identity.node_id {
        return Err(LocalError {
            error: "wrong_node".into(),
            message: "this token was issued for a different node".into(),
        });
    }
    if session.consumed_at.is_some() {
        return Err(LocalError {
            error: "token_consumed".into(),
            message: "this pairing token was already used".into(),
        });
    }
    // Expiry is a flat comparison against the timeline the Relay used; an
    // unparseable timestamp is treated as expired (fail closed).
    let expired = chrono::DateTime::parse_from_rfc3339(session.expires_at)
        .map(|t| t.timestamp() < chrono::Utc::now().timestamp())
        .unwrap_or(true);
    if expired {
        return Err(LocalError {
            error: "token_expired".into(),
            message: "this pairing token has expired".into(),
        });
    }

    if session.bound_key != pubkey_bytes {
        return Err(LocalError {
            error: "key_mismatch".into(),
            message: "this token is bound to a different device key".into(),
        });
    }

    // Mark consumed *before* storing the device so a crash mid-pair cannot
    // leave a token reusable.
    sqlx::query("UPDATE pairing_sessions SET consumed_at = ? WHERE token = ?")
        .bind(now_iso())
        .bind(&req.token)
        .execute(&state.db)
        .await
        .map_err(internal_err)?;

    store_device(state, req, pubkey_bytes, session.account_id).await
}

/// Insert (or re-activate) the device in the `devices` table. Idempotent on the
/// device_id: re-pairing with a newer key updates the stored public key, which
/// is the intended rotate-a-key path.
async fn store_device(
    state: &LocalState,
    req: &PairRequest,
    pubkey_bytes: &[u8],
    account_id: &str,
) -> Result<Json<PairConfirm>, LocalError> {
    let device_pubkey_hex = hex::encode(pubkey_bytes);
    let now = now_iso();

    sqlx::query(
        "INSERT INTO devices (device_id, public_key_bytes, status, created_at, paired_at)
         VALUES (?, ?, 'ACTIVE', ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET
            public_key_bytes = excluded.public_key_bytes,
            status = 'ACTIVE',
            paired_at = excluded.paired_at,
            revoked_at = NULL",
    )
    .bind(&req.device_id)
    .bind(pubkey_bytes)
    .bind(&now)
    .bind(&now)
    .execute(&state.db)
    .await
    .map_err(internal_err)?;

    Ok(Json(PairConfirm {
        node_id: state.identity.node_id.clone(),
        account_id: account_id.to_string(),
        device_id: req.device_id.clone(),
        device_public_key: device_pubkey_hex,
    }))
}

// ── Helpers ──────────────────────────────────────────────────────────────

/// The `device_public_key` field on the wire is base64 (mirrors the Relay's
/// own payload encoding). Decode and validate length.
fn decode_pubkey(b64: &str) -> Result<Vec<u8>, LocalError> {
    let raw = base64_decode(b64)?;
    if raw.len() != 32 {
        return Err(LocalError {
            error: "invalid_key".into(),
            message: "device public key must be 32 bytes".into(),
        });
    }
    Ok(raw)
}

fn base64_decode(s: &str) -> Result<Vec<u8>, LocalError> {
    base64::engine::general_purpose::STANDARD
        .decode(s)
        .map_err(|_| LocalError {
            error: "invalid_key".into(),
            message: "value is not valid base64".into(),
        })
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn internal_err(e: sqlx::Error) -> LocalError {
    LocalError {
        error: "internal".into(),
        message: format!("database error: {e}"),
    }
}

impl IntoResponse for LocalError {
    fn into_response(self) -> axum::response::Response {
        let status = match self.error.as_str() {
            "rate_limited" | "overloaded" => StatusCode::TOO_MANY_REQUESTS,
            _ => StatusCode::BAD_REQUEST,
        };
        (status, Json(self)).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use ed25519_dalek::{Signer, SigningKey};
    use http_body_util::BodyExt;
    use std::time::Duration;
    use tempfile::tempdir;
    use tower::ServiceExt;

    use crate::db;
    use crate::identity;

    async fn setup_test_server() -> (Router, SqlitePool, Arc<NodeIdentity>, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let db = db::open(dir.path()).await.unwrap();
        let identity = Arc::new(identity::load_or_generate(dir.path()).unwrap());
        let store = Arc::new(
            crate::store::ObjectStore::new(dir.path().to_path_buf(), db.clone())
                .await
                .unwrap(),
        );
        let webrtc_manager = Arc::new(crate::webrtc::WebRtcManager::new(
            db.clone(),
            store.clone(),
            identity.clone(),
        ));
        let nonces = Arc::new(NonceStore::default());
        let challenge_limiter = Arc::new(RateLimiter::new(
            Duration::from_secs(10),
            super::super::auth::CHALLENGE_RATE_LIMIT,
        ));
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
        (make_router(state), db, identity, dir)
    }

    #[tokio::test]
    async fn test_discovery_endpoint() {
        let (app, _db, identity, _dir) = setup_test_server().await;

        let req = Request::builder()
            .uri("/nodus/discovery")
            .method("GET")
            .body(Body::empty())
            .unwrap();

        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        let body_bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body_bytes).unwrap();
        assert_eq!(json["node_id"], identity.node_id);
        assert_eq!(json["schema_version"], "1.0");
        assert!(json["pk_fp"].as_str().unwrap().len() == 16);
    }

    #[tokio::test]
    async fn test_challenge_endpoint_and_rate_limiting() {
        let (app, _db, _id, _dir) = setup_test_server().await;
        let client_addr: SocketAddr = "192.168.1.50:54321".parse().unwrap();

        // 10 successful requests allowed
        for _ in 0..10 {
            let mut req = Request::builder()
                .uri("/nodus/challenge")
                .method("POST")
                .body(Body::empty())
                .unwrap();
            req.extensions_mut().insert(ConnectInfo(client_addr));

            let resp = app.clone().oneshot(req).await.unwrap();
            assert_eq!(resp.status(), StatusCode::OK);
            let bytes = resp.into_body().collect().await.unwrap().to_bytes();
            let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert!(!json["nonce"].as_str().unwrap().is_empty());
            assert_eq!(json["ttl_seconds"], 30);
        }

        // 11th request from the same IP must be rate limited (429)
        let mut req = Request::builder()
            .uri("/nodus/challenge")
            .method("POST")
            .body(Body::empty())
            .unwrap();
        req.extensions_mut().insert(ConnectInfo(client_addr));
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::TOO_MANY_REQUESTS);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["error"], "rate_limited");

        // Different IP is unaffected
        let mut req2 = Request::builder()
            .uri("/nodus/challenge")
            .method("POST")
            .body(Body::empty())
            .unwrap();
        req2.extensions_mut().insert(ConnectInfo(
            "192.168.1.51:54321".parse::<SocketAddr>().unwrap(),
        ));
        let resp2 = app.oneshot(req2).await.unwrap();
        assert_eq!(resp2.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_auth_challenge_response_flow() {
        let (app, db, identity, _dir) = setup_test_server().await;
        let client_addr: SocketAddr = "127.0.0.1:50000".parse().unwrap();

        let device_key = SigningKey::from_bytes(&[42u8; 32]);
        let device_pubkey = device_key.verifying_key().to_bytes();
        let device_id = "device-test-1";

        // Seed the device in DB as ACTIVE
        sqlx::query(
            "INSERT INTO devices (device_id, public_key_bytes, status, created_at, paired_at)
             VALUES (?, ?, 'ACTIVE', 'now', 'now')",
        )
        .bind(device_id)
        .bind(&device_pubkey[..])
        .execute(&db)
        .await
        .unwrap();

        // 1. Get challenge
        let mut req = Request::builder()
            .uri("/nodus/challenge")
            .method("POST")
            .body(Body::empty())
            .unwrap();
        req.extensions_mut().insert(ConnectInfo(client_addr));
        let resp = app.clone().oneshot(req).await.unwrap();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let nonce = json["nonce"].as_str().unwrap().to_string();

        // 2. Sign nonce
        let sig = device_key.sign(nonce.as_bytes());
        let sig_hex = hex::encode(sig.to_bytes());

        // 3. Authenticate
        let auth_body = serde_json::json!({
            "device_id": device_id,
            "nonce": nonce,
            "signature": sig_hex,
        });
        let req = Request::builder()
            .uri("/nodus/auth")
            .method("POST")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&auth_body).unwrap()))
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["status"], "ok");
        assert_eq!(json["node_id"], identity.node_id);

        // 4. Replay of same nonce must fail (single-use)
        let req = Request::builder()
            .uri("/nodus/auth")
            .method("POST")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&auth_body).unwrap()))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["error"], "invalid_nonce");
    }

    #[tokio::test]
    async fn test_pair_fast_path_success_and_replay_rejection() {
        let (app, db, identity, _dir) = setup_test_server().await;

        let device_key = SigningKey::from_bytes(&[99u8; 32]);
        let device_pubkey = device_key.verifying_key().to_bytes();
        let device_pubkey_b64 = base64::engine::general_purpose::STANDARD.encode(device_pubkey);
        let token = "test-pairing-token-uuid-1234";
        let account_id = "acct-test-pairing-user";
        let device_id = "device-to-pair-1";
        let expires_at = (chrono::Utc::now() + chrono::Duration::minutes(15)).to_rfc3339();

        // Seed pairing_sessions row as pushed from Relay
        sqlx::query(
            "INSERT INTO pairing_sessions (token, device_public_key, node_id, issued_at, expires_at, account_id)
             VALUES (?, ?, ?, 'now', ?, ?)"
        )
        .bind(token)
        .bind(&device_pubkey[..])
        .bind(&identity.node_id)
        .bind(&expires_at)
        .bind(account_id)
        .execute(&db)
        .await
        .unwrap();

        // 1. Redeem token locally
        let pair_body = serde_json::json!({
            "node_id": identity.node_id,
            "token": token,
            "device_public_key": device_pubkey_b64,
            "device_id": device_id,
        });
        let req = Request::builder()
            .uri("/nodus/pair")
            .method("POST")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&pair_body).unwrap()))
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["node_id"], identity.node_id);
        assert_eq!(json["account_id"], account_id);
        assert_eq!(json["device_id"], device_id);
        assert_eq!(json["device_public_key"], hex::encode(device_pubkey));

        // Verify DB row is updated in devices table
        let row: (Vec<u8>, String) =
            sqlx::query_as("SELECT public_key_bytes, status FROM devices WHERE device_id = ?")
                .bind(device_id)
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(row.0, device_pubkey);
        assert_eq!(row.1, "ACTIVE");

        // Verify pairing_sessions is marked consumed
        let consumed_at: Option<String> =
            sqlx::query_scalar("SELECT consumed_at FROM pairing_sessions WHERE token = ?")
                .bind(token)
                .fetch_one(&db)
                .await
                .unwrap();
        assert!(consumed_at.is_some());

        // 2. Second use must be rejected (token_consumed)
        let req2 = Request::builder()
            .uri("/nodus/pair")
            .method("POST")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&pair_body).unwrap()))
            .unwrap();
        let resp2 = app.oneshot(req2).await.unwrap();
        assert_eq!(resp2.status(), StatusCode::BAD_REQUEST);
        let bytes = resp2.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["error"], "token_consumed");
    }

    #[tokio::test]
    async fn test_pair_fast_path_expired_token_rejected() {
        let (app, db, identity, _dir) = setup_test_server().await;

        let device_key = SigningKey::from_bytes(&[88u8; 32]);
        let device_pubkey = device_key.verifying_key().to_bytes();
        let device_pubkey_b64 = base64::engine::general_purpose::STANDARD.encode(device_pubkey);
        let token = "test-expired-token";
        let expired_at = (chrono::Utc::now() - chrono::Duration::minutes(5)).to_rfc3339();

        sqlx::query(
            "INSERT INTO pairing_sessions (token, device_public_key, node_id, issued_at, expires_at, account_id)
             VALUES (?, ?, ?, 'now', ?, 'acct-1')"
        )
        .bind(token)
        .bind(&device_pubkey[..])
        .bind(&identity.node_id)
        .bind(&expired_at)
        .execute(&db)
        .await
        .unwrap();

        let pair_body = serde_json::json!({
            "node_id": identity.node_id,
            "token": token,
            "device_public_key": device_pubkey_b64,
            "device_id": "dev-expired",
        });
        let req = Request::builder()
            .uri("/nodus/pair")
            .method("POST")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&pair_body).unwrap()))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["error"], "token_expired");
    }

    #[tokio::test]
    async fn test_pair_fast_path_key_mismatch_rejected() {
        let (app, db, identity, _dir) = setup_test_server().await;

        let bound_key = SigningKey::from_bytes(&[1u8; 32])
            .verifying_key()
            .to_bytes();
        let other_key = SigningKey::from_bytes(&[2u8; 32])
            .verifying_key()
            .to_bytes();
        let other_key_b64 = base64::engine::general_purpose::STANDARD.encode(other_key);
        let token = "test-bound-key-token";
        let expires_at = (chrono::Utc::now() + chrono::Duration::minutes(15)).to_rfc3339();

        sqlx::query(
            "INSERT INTO pairing_sessions (token, device_public_key, node_id, issued_at, expires_at, account_id)
             VALUES (?, ?, ?, 'now', ?, 'acct-1')"
        )
        .bind(token)
        .bind(&bound_key[..])
        .bind(&identity.node_id)
        .bind(&expires_at)
        .execute(&db)
        .await
        .unwrap();

        let pair_body = serde_json::json!({
            "node_id": identity.node_id,
            "token": token,
            "device_public_key": other_key_b64,
            "device_id": "dev-mismatch",
        });
        let req = Request::builder()
            .uri("/nodus/pair")
            .method("POST")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&pair_body).unwrap()))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["error"], "key_mismatch");
    }

    #[tokio::test]
    async fn test_pair_wrong_node_rejected() {
        let (app, _db, _identity, _dir) = setup_test_server().await;

        let pair_body = serde_json::json!({
            "node_id": "alien-node-id",
            "token": "any-token",
            "device_public_key": base64::engine::general_purpose::STANDARD.encode([1u8; 32]),
            "device_id": "dev-wrong",
        });
        let req = Request::builder()
            .uri("/nodus/pair")
            .method("POST")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&pair_body).unwrap()))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["error"], "wrong_node");
    }
}
