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
use axum::extract::State;
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

use super::auth::{NonceStore, verify_signature};

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
    pub nonces: Arc<NonceStore>,
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

#[derive(Serialize)]
struct LocalError {
    error: String,
    message: String,
}

/// Pairing-token row shape returned by the Relay's `/pairing/sessions/verify`.
#[derive(Deserialize)]
struct RelayVerify {
    valid: bool,
    account_id: Option<String>,
    device_public_key: Option<String>,
}

/// Build the router with all Phase 11 handlers wired in.
fn make_router(state: LocalState) -> Router {
    Router::new()
        .route("/nodus/discovery", get(discovery))
        .route("/nodus/challenge", post(challenge))
        .route("/nodus/auth", post(auth))
        .route("/nodus/pair", post(pair))
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
    relay_url: Option<&str>,
) -> anyhow::Result<tokio::task::JoinHandle<()>> {
    let relay_http_base = relay_url.map(|u| {
        // Same ws→http derivation the sync client already uses for
        // /buffer/fetch; reuse it to stay consistent about base-path handling.
        relay_http_fetch_url(u)
            .trim_end_matches("/buffer/fetch")
            .to_string()
    });

    let state = LocalState {
        identity,
        db,
        nonces: Arc::new(NonceStore::default()),
        relay_http_base,
        http: reqwest::Client::new(),
    };

    let addr: SocketAddr = ([0, 0, 0, 0], LOCAL_PORT).into();
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("binding local listener on {addr}"))?;
    let app = make_router(state);

    let handle = tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
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

async fn challenge(State(state): State<LocalState>) -> Result<Json<Challenge>, LocalError> {
    let nonce = state.nonces.issue().await;
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

    let row = sqlx::query_as::<_, (Vec<u8>, String, String, Option<String>, String)>(
        "SELECT device_public_key, node_id, issued_at, consumed_at, expires_at
         FROM pairing_sessions WHERE token = ?",
    )
    .bind(&req.token)
    .fetch_optional(&state.db)
    .await
    .map_err(internal_err)?;

    if let Some((bound_key, node_id, _issued_at, consumed_at, expires_at)) = row {
        // Local fast path: the Relay already pushed this token to us over WS.
        redeem_from_local(
            &state,
            &req,
            &pubkey_bytes,
            &bound_key,
            &node_id,
            &consumed_at,
            &expires_at,
        )
        .await
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

/// Redeem a token already stored by the Relay's WS push (`pairing_token_push`).
/// `bound_key` is the raw 32-byte public key the Relay bound the token to
/// (stored as the table's BLOB) — compared directly against the presented key.
async fn redeem_from_local(
    state: &LocalState,
    req: &PairRequest,
    pubkey_bytes: &[u8],
    bound_key: &[u8],
    node_id: &str,
    consumed_at: &Option<String>,
    expires_at: &str,
) -> Result<Json<PairConfirm>, LocalError> {
    if node_id != state.identity.node_id {
        return Err(LocalError {
            error: "wrong_node".into(),
            message: "this token was issued for a different node".into(),
        });
    }
    if consumed_at.is_some() {
        return Err(LocalError {
            error: "token_consumed".into(),
            message: "this pairing token was already used".into(),
        });
    }
    // Expiry is a flat comparison against the timeline the Relay used; an
    // unparseable timestamp is treated as expired (fail closed).
    let expired = chrono::DateTime::parse_from_rfc3339(expires_at)
        .map(|t| t.timestamp() < chrono::Utc::now().timestamp())
        .unwrap_or(true);
    if expired {
        return Err(LocalError {
            error: "token_expired".into(),
            message: "this pairing token has expired".into(),
        });
    }

    if bound_key != pubkey_bytes {
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

    store_device(state, req, pubkey_bytes, "local_push").await
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
        (StatusCode::BAD_REQUEST, Json(self)).into_response()
    }
}
