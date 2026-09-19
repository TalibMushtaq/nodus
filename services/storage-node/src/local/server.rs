//! Local HTTP listener for discovery, pairing and challenge-response auth.
//!
//! Serves the Phase 11 endpooints on the same port advertised over mDNS:
//! - `GET  /nodus/discovery` — node advertisement (`LocalDiscoveryAdvertisement`)
//! - `POST /nodus/challenge` — issue a single-use nonce
//! - `POST /nodus/auth`      — Ed25519 challenge-response against `devices`
//! - `POST /nodus/pair`      — redeem a Relay-issued pairing token
//! - `GET  /nodus/shard/{object_id}` — authenticated node→node shard fetch (§21a repair)
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
use axum::extract::{ConnectInfo, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use serde::{Deserialize, Serialize};
use sqlx::sqlite::{SqliteConnection, SqlitePool};
use tower_http::cors::CorsLayer;

use crate::identity::NodeIdentity;

use super::auth::{NonceStore, RateLimiter, verify_signature};

/// Schema version reported in the discovery advertisement. Keep in sync with
/// `CURRENT_SCHEMA_VERSION` in packages/protocol.
pub const SCHEMA_VERSION: &str = "1.0";

/// Local listener port. Advertised in mDNS and used for the pairing QR URL.
pub const LOCAL_PORT: u16 = 9378;

/// How far in the past/future a node shard-fetch request timestamp may be.
/// Binds the signed message to a wall-clock moment so captured signatures
/// can't be replayed blindly; 60s mirrors the challenge nonce window.
const NODE_AUTH_FRESHNESS_MS: i64 = 60_000;

/// HTTP base on which startup failures are the caller's problem: the server
/// returns bind results to the caller via this shared struct.
#[derive(Clone)]
pub struct LocalState {
    pub identity: Arc<NodeIdentity>,
    pub db: SqlitePool,
    pub store: Arc<crate::store::ObjectStore>,
    pub webrtc_manager: Arc<crate::webrtc::WebRtcManager>,
    pub nonces: Arc<NonceStore>,
    pub challenge_limiter: Arc<RateLimiter>,
    /// Separate limiter for `/nodus/webrtc/offer`: each accepted offer creates
    /// a session, so it must not share the challenge budget.
    pub offer_limiter: Arc<RateLimiter>,
    /// Dedicated nonce store for offline recovery (ADR-0002): recovery hands
    /// out key material, so it must not share the ordinary auth nonce budget
    /// (a consumed recovery nonce and a consumed auth nonce are different
    /// ceremonies).
    pub recovery_nonces: Arc<NonceStore>,
    /// Per-IP limiter for `/nodus/recovery/challenge`.
    pub recovery_limiter: Arc<RateLimiter>,
    /// Per-IP limiter for the recovery signature submission itself, so a client
    /// cannot hammer signature verification (or a sniffed nonce).
    pub recovery_auth_limiter: Arc<RateLimiter>,
    /// Per-IP limiter for recovery-envelope fetches, capping enumeration.
    pub recovery_envelopes_limiter: Arc<RateLimiter>,
    /// Derived Relay HTTP base (ws→http, /ws dropped), reused for the
    /// `/pairing/sessions/verify` fallback. `None` disables the fallback.
    pub relay_http_base: Option<String>,
    pub http: reqwest::Client,
    /// Shell telemetry: the auth path and WebRTC manager publish their facts
    /// here so `status` stays a read-only observer.
    pub telemetry: crate::telemetry::Telemetry,
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

// ── Offline recovery (ADR-0002) ──────────────────────────────────────────

/// Challenge for the offline "lost phone" flow; `recovery_public_key` is the
/// account recovery Ed25519 key (base64) the node found sealed in its
/// envelopes, so the client can check its phrase before spending the nonce.
#[derive(Serialize)]
struct RecoveryChallenge {
    nonce: String,
    ttl_seconds: u64,
    account_id: String,
    recovery_public_key: String,
}

#[derive(Deserialize)]
struct RecoveryRequest {
    nonce: String,
    /// Ed25519 signature over the nonce bytes by the *recovery* key, hex.
    signature: String,
    device_id: String,
    /// Raw Ed25519 pubkey bytes of the new device (base64).
    device_public_key: String,
}

#[derive(Serialize)]
struct RecoveryResult {
    status: &'static str,
    account_id: String,
    device_id: String,
}

#[derive(Serialize)]
struct RecoveryFileEnvelope {
    file_id: String,
    recipient_id: String,
    recipient_kind: String,
    encrypted_key: String,
}

#[derive(Serialize)]
struct RecoveryFolderEnvelope {
    folder_id: String,
    recipient_id: String,
    recipient_kind: String,
    encrypted_key: String,
}

#[derive(Serialize)]
struct RecoveryEnvelopes {
    file_envelopes: Vec<RecoveryFileEnvelope>,
    folder_envelopes: Vec<RecoveryFolderEnvelope>,
}

/// One journaled `ACTIVITY_LOGGED` event, projected into the shared activity
/// record shape (`packages/protocol/src/messages/activity.ts`). Carries no file
/// name — names are E2E and the node must not see them; `file_id` lets the
/// client resolve the display name locally.
#[derive(Serialize, Deserialize)]
struct LocalActivity {
    activity_id: String,
    kind: String,
    outcome: String,
    #[serde(default)]
    file_id: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    detail: Option<String>,
    created_at: String,
    /// Origin device, filled from the sync_events row rather than the payload.
    #[serde(default)]
    device_id: String,
}

#[derive(Serialize)]
struct LocalActivities {
    activities: Vec<LocalActivity>,
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
        // Offline recovery (ADR-0002): challenge → signed recovery → envelopes.
        .route("/nodus/recovery/challenge", post(recovery_challenge))
        .route("/nodus/recovery", post(recovery_auth))
        .route("/nodus/recovery/envelopes", get(recovery_envelopes))
        // Offline activity feed: the LAN counterpart to the Relay's
        // `GET /activities`, so the Activity view reads the same records with
        // no Internet.
        .route("/nodus/activities", get(activities))
        .route("/nodus/shard/{object_id}", get(handle_shard_fetch))
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
    webrtc_manager: Arc<crate::webrtc::WebRtcManager>,
    relay_url: Option<&str>,
    telemetry: crate::telemetry::Telemetry,
) -> anyhow::Result<tokio::task::JoinHandle<()>> {
    let relay_http = relay_url.map(|u| {
        // Same ws→http derivation the sync client already uses for
        // /buffer/fetch; reuse it to stay consistent about base-path handling.
        crate::sync::client::relay_http_base(u)
    });

    // The manager is created by `main` and shared with the sync loop so Path A
    // (local HTTP) and Path B (relay WS) sessions live in one pool with the same
    // cap, TTL, and telemetry.
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
        offer_limiter: Arc::new(RateLimiter::new(
            super::auth::WEBRTC_OFFER_RATE_WINDOW,
            super::auth::WEBRTC_OFFER_RATE_LIMIT,
        )),
        recovery_nonces: Arc::new(NonceStore::default()),
        recovery_limiter: Arc::new(RateLimiter::new(
            super::auth::RECOVERY_RATE_WINDOW,
            super::auth::RECOVERY_RATE_LIMIT,
        )),
        recovery_auth_limiter: Arc::new(RateLimiter::new(
            super::auth::RECOVERY_AUTH_RATE_WINDOW,
            super::auth::RECOVERY_AUTH_RATE_LIMIT,
        )),
        recovery_envelopes_limiter: Arc::new(RateLimiter::new(
            super::auth::RECOVERY_ENVELOPES_RATE_WINDOW,
            super::auth::RECOVERY_ENVELOPES_RATE_LIMIT,
        )),
        relay_http_base: relay_http,
        // Bound the Relay pairing-verify call (#9): a black-holed relay IP
        // would otherwise hang this LAN request well past anything the client
        // is still waiting for. 15 s matches run_pair's own redeem budget.
        http: reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .expect("reqwest client build cannot fail"),
        telemetry: telemetry.clone(),
    };

    let addr: SocketAddr = ([0, 0, 0, 0], LOCAL_PORT).into();
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("binding local listener on {addr}"))?;
    // Binding succeeded: the LAN listener is live, so `status` can show
    // "Local: listening" without the shell dialing a check connection.
    telemetry.set_local_listening(true);
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

    // A paired client authenticated over the LAN: record the activity so
    // `status` can report that local connectivity is being used, lazily.
    state.telemetry.local_auth();

    Ok(Json(AuthResult {
        status: "ok",
        node_id: state.identity.node_id.clone(),
    }))
}

// ── Offline recovery handlers (ADR-0002) ─────────────────────────────────

/// The account recovery public key (base64) recorded in the node's envelopes.
/// Its `recipient_id` on a recovery envelope IS that key, which is how the node
/// can challenge a recovering client without any Relay data.
async fn recovery_recipient(db: &SqlitePool) -> Result<Option<String>, LocalError> {
    sqlx::query_scalar::<_, String>(
        "SELECT recipient_id FROM key_envelopes WHERE recipient_kind = 'recovery'
         UNION
         SELECT recipient_id FROM folder_key_envelopes WHERE recipient_kind = 'recovery'
         LIMIT 1",
    )
    .fetch_optional(db)
    .await
    .map_err(internal_err)
}

async fn node_account_id(db: &SqlitePool) -> Result<Option<String>, LocalError> {
    sqlx::query_scalar::<_, String>("SELECT account_id FROM node_account WHERE id = 1")
        .fetch_optional(db)
        .await
        .map_err(internal_err)
}

async fn recovery_challenge(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<LocalState>,
) -> Result<Json<RecoveryChallenge>, LocalError> {
    // Tighter budget than the ordinary challenge: recovery is the highest-value
    // LAN ceremony (it hands out key material to a phrase holder).
    if !state.recovery_limiter.check_and_record(addr.ip()).await {
        return Err(LocalError {
            error: "rate_limited".into(),
            message: "too many recovery requests; try again shortly".into(),
        });
    }
    let Some(account_id) = node_account_id(&state.db).await? else {
        return Err(LocalError {
            error: "no_account".into(),
            message: "this node is not paired to an account".into(),
        });
    };
    let Some(recovery_public_key) = recovery_recipient(&state.db).await? else {
        return Err(LocalError {
            error: "recovery_unavailable".into(),
            message: "this account has no recovery key enrolled".into(),
        });
    };
    let nonce = state
        .recovery_nonces
        .issue()
        .await
        .ok_or_else(|| LocalError {
            error: "overloaded".into(),
            message: "recovery nonce store is at capacity; retry in 30s".into(),
        })?;
    Ok(Json(RecoveryChallenge {
        nonce,
        ttl_seconds: super::auth::NONCE_TTL.as_secs(),
        account_id,
        recovery_public_key,
    }))
}

/// Prove the recovery phrase (an Ed25519 signature over the nonce), register
/// the new device locally, and return the account id. No Relay involved.
async fn recovery_auth(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<LocalState>,
    Json(req): Json<RecoveryRequest>,
) -> Result<Json<RecoveryResult>, LocalError> {
    // Bound signature-verification work (and attempts on a sniffed nonce) per IP.
    if !state
        .recovery_auth_limiter
        .check_and_record(addr.ip())
        .await
    {
        return Err(LocalError {
            error: "rate_limited".into(),
            message: "too many recovery attempts; try again shortly".into(),
        });
    }
    // Peek rather than consume: a sniffed nonce with a garbage signature must not
    // burn the legitimate recovery. Single-use is enforced by the consume after
    // the signature verifies.
    if !state.recovery_nonces.peek(&req.nonce).await {
        return Err(LocalError {
            error: "invalid_nonce".into(),
            message: "recovery nonce was not issued, is expired, or already used".into(),
        });
    }
    let Some(account_id) = node_account_id(&state.db).await? else {
        return Err(LocalError {
            error: "no_account".into(),
            message: "this node is not paired to an account".into(),
        });
    };
    let recovery_key_b64 = recovery_recipient(&state.db)
        .await?
        .ok_or_else(|| LocalError {
            error: "recovery_unavailable".into(),
            message: "this account has no recovery key enrolled".into(),
        })?;
    let recovery_key = base64_decode(&recovery_key_b64)?;
    let device_pubkey = decode_pubkey(&req.device_public_key)?;

    // Verify before any mutable state; a bad signature must not touch devices.
    verify_signature(&recovery_key, req.nonce.as_bytes(), &req.signature).map_err(|e| {
        LocalError {
            error: "bad_signature".into(),
            message: format!("recovery signature verification failed: {e}"),
        }
    })?;

    // Only now claim the nonce. A false here means a concurrent submission won
    // the race, so this (valid) attempt must not mint a second device session.
    if !state.recovery_nonces.consume(&req.nonce).await {
        return Err(LocalError {
            error: "invalid_nonce".into(),
            message: "recovery nonce was not issued, is expired, or already used".into(),
        });
    }

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
    .bind(&device_pubkey)
    .bind(&now)
    .bind(&now)
    .execute(&state.db)
    .await
    .map_err(internal_err)?;

    state.telemetry.local_auth();
    Ok(Json(RecoveryResult {
        status: "ok",
        account_id,
        device_id: req.device_id,
    }))
}

/// Serve the account's recovery-sealed envelopes to an authenticated device so
/// it can unlock file/folder keys with no Internet. Only `recipient_kind =
/// 'recovery'` rows are ever returned; device/node envelopes stay private.
async fn recovery_envelopes(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<LocalState>,
    headers: HeaderMap,
) -> Result<Json<RecoveryEnvelopes>, LocalError> {
    // The request is device-signed, but cap enumeration volume per IP anyway.
    if !state
        .recovery_envelopes_limiter
        .check_and_record(addr.ip())
        .await
    {
        return Err(LocalError {
            error: "rate_limited".into(),
            message: "too many recovery requests; try again shortly".into(),
        });
    }
    let (caller, _is_device, timestamp, _signature) = parse_signed_headers(&headers)?;
    let message = format!("{caller}:recovery-envelopes:{timestamp}");
    verify_signed_caller(&state.db, &headers, message.as_bytes()).await?;

    let file_rows = sqlx::query_as::<_, (String, String, String, String)>(
        "SELECT file_id, recipient_id, recipient_kind, encrypted_key
         FROM key_envelopes WHERE recipient_kind = 'recovery'",
    )
    .fetch_all(&state.db)
    .await
    .map_err(internal_err)?;
    let folder_rows = sqlx::query_as::<_, (String, String, String, String)>(
        "SELECT folder_id, recipient_id, recipient_kind, encrypted_key
         FROM folder_key_envelopes WHERE recipient_kind = 'recovery'",
    )
    .fetch_all(&state.db)
    .await
    .map_err(internal_err)?;

    Ok(Json(RecoveryEnvelopes {
        file_envelopes: file_rows
            .into_iter()
            .map(
                |(file_id, recipient_id, recipient_kind, encrypted_key)| RecoveryFileEnvelope {
                    file_id,
                    recipient_id,
                    recipient_kind,
                    encrypted_key,
                },
            )
            .collect(),
        folder_envelopes: folder_rows
            .into_iter()
            .map(|(folder_id, recipient_id, recipient_kind, encrypted_key)| {
                RecoveryFolderEnvelope {
                    folder_id,
                    recipient_id,
                    recipient_kind,
                    encrypted_key,
                }
            })
            .collect(),
    }))
}

/// `GET /nodus/activities` — the account's activity feed over the LAN, the
/// offline counterpart to the Relay's `GET /activities`. A signed device
/// request (same stateless scheme as recovery envelopes); the node is bound to
/// a single account, so the journal needs no account filter. `sync_events`
/// already holds every `ACTIVITY_LOGGED` event the node synced, so this reads
/// that log directly — no separate projection.
async fn activities(
    State(state): State<LocalState>,
    headers: HeaderMap,
) -> Result<Json<LocalActivities>, LocalError> {
    let (caller, _is_device, timestamp, _signature) = parse_signed_headers(&headers)?;
    let message = format!("{caller}:activities:{timestamp}");
    verify_signed_caller(&state.db, &headers, message.as_bytes()).await?;

    let rows = sqlx::query_as::<_, (String, String)>(
        "SELECT origin_id, payload FROM sync_events \
         WHERE event_type = 'ACTIVITY_LOGGED' \
         ORDER BY timestamp DESC LIMIT 200",
    )
    .fetch_all(&state.db)
    .await
    .map_err(internal_err)?;

    let mut activities = Vec::with_capacity(rows.len());
    for (origin_id, payload) in rows {
        match serde_json::from_str::<LocalActivity>(&payload) {
            Ok(mut activity) => {
                // The origin is the device that produced the entry; the payload
                // deliberately carries no device id of its own.
                activity.device_id = origin_id;
                activities.push(activity);
            }
            // Skip a malformed row rather than failing the whole feed.
            Err(_) => continue,
        }
    }

    Ok(Json(LocalActivities { activities }))
}

// ── Node-to-node shard fetch (§21a repair) ───────────────────────────────

/// Serve a shard object's bytes to a *trusted node* requesting a repair.
///
/// Stateless read auth, used by both node-to-node backhaul (Path A repair) and
/// client downloads (Phase 14 F2b). Instead of the nonce handshake (which needs
/// two round-trips and shared nonce state), the requester signs
/// `"{caller_id}:{object_id}:{timestamp_ms}"` and sends it in `X-Nodus-*`
/// headers. The receiver checks, in order: the caller is a known, active
/// identity (`trusted_nodes` for a node via `X-Nodus-Node-Id`, `devices` for a
/// paired device via `X-Nodus-Device-Id`), the timestamp is within
/// [`NODE_AUTH_FRESHNESS_MS`], and the Ed25519 signature verifies against the
/// stored public key. Only then are the bytes read from disk.
async fn handle_shard_fetch(
    State(state): State<LocalState>,
    Path(object_id): Path<String>,
    headers: HeaderMap,
) -> Result<(StatusCode, Vec<u8>), LocalError> {
    // Authenticate first, then validate the id: returning a 400 for a malformed
    // object id before checking the signature would be a small oracle letting an
    // unauthenticated prober distinguish id shapes. The signed message binds the
    // id verbatim either way.
    let (caller, _is_device, timestamp, _signature) = parse_signed_headers(&headers)?;

    // The signed message binds caller, target object, and time together, so a
    // captured signature can't be replayed against a different object.
    let message = format!("{caller}:{object_id}:{timestamp}");
    verify_signed_caller(&state.db, &headers, message.as_bytes()).await?;

    // The caller controls this string and the signature binds it verbatim, so
    // validate it BEFORE path construction: a malformed id (e.g. `..` segments
    // or absolute paths) must never reach `object_path` and read files outside
    // `objects/` under data_dir.
    validate_object_id(&object_id)?;

    // Presence check only: the requester hash-verifies against the object_id
    // it asked for, so corrupt local content fails verification there (and is
    // DEGRADED here after the next reconciliation scan anyway).
    let path =
        crate::store::layout::object_path(state.store.data_dir(), &object_id).map_err(|e| {
            LocalError {
                error: "invalid_object_id".into(),
                message: format!("{e}"),
            }
        })?;
    let bytes = tokio::fs::read(&path).await.map_err(|_| LocalError {
        error: "not_found".into(),
        message: "object not present on this node".into(),
    })?;
    Ok((StatusCode::OK, bytes))
}

fn unauthorized(message: &str) -> LocalError {
    LocalError {
        error: "unauthorized".into(),
        message: message.to_string(),
    }
}

/// The verifiable identity carried by a stateless signed request. Both node
/// (trusted peer) and paired-device callers authenticate through this path.
pub struct VerifiedCaller {
    pub caller_id: String,
    pub is_device: bool,
}

fn parse_signed_headers(headers: &HeaderMap) -> Result<(String, bool, i64, String), LocalError> {
    let device_caller = headers
        .get("x-nodus-device-id")
        .and_then(|v| v.to_str().ok());
    let node_caller = headers.get("x-nodus-node-id").and_then(|v| v.to_str().ok());
    let (caller, is_device) = match (device_caller, node_caller) {
        (Some(device), None) => (device.to_string(), true),
        (None, Some(node)) => (node.to_string(), false),
        _ => {
            return Err(unauthorized(
                "provide exactly one of X-Nodus-Device-Id or X-Nodus-Node-Id",
            ));
        }
    };
    let timestamp = headers
        .get("x-nodus-timestamp")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<i64>().ok())
        .ok_or_else(|| unauthorized("missing or invalid X-Nodus-Timestamp header"))?;
    let signature = headers
        .get("x-nodus-signature")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| unauthorized("missing X-Nodus-Signature header"))?;
    Ok((caller, is_device, timestamp, signature.to_string()))
}

async fn resolve_caller_pubkey(
    db: &SqlitePool,
    caller: &str,
    is_device: bool,
) -> Result<Vec<u8>, LocalError> {
    let row: Option<(Vec<u8>,)> = if is_device {
        sqlx::query_as(
            "SELECT public_key_bytes FROM devices WHERE device_id = ? AND status = 'ACTIVE'",
        )
        .bind(caller)
        .fetch_optional(db)
        .await
        .map_err(internal_err)?
    } else {
        sqlx::query_as("SELECT public_key_bytes FROM trusted_nodes WHERE node_id = ?")
            .bind(caller)
            .fetch_optional(db)
            .await
            .map_err(internal_err)?
    };
    row.map(|(pubkey,)| pubkey).ok_or_else(|| {
        unauthorized(if is_device {
            "caller is not an active device"
        } else {
            "caller is not a trusted node"
        })
    })
}

/// Verify a stateless `X-Nodus-*` signed request against the live identity
/// tables. Shared by the shard-fetch endpoint and WebRTC signaling so every
/// local writable endpoint enforces the same device/node cryptographic trust
/// model. `message` is the exact byte string the caller signed.
pub async fn verify_signed_caller(
    db: &SqlitePool,
    headers: &HeaderMap,
    message: &[u8],
) -> Result<VerifiedCaller, LocalError> {
    let (caller, is_device, timestamp, signature) = parse_signed_headers(headers)?;
    if (chrono::Utc::now().timestamp_millis() - timestamp).abs() > NODE_AUTH_FRESHNESS_MS {
        return Err(unauthorized(
            "request timestamp is outside the freshness window",
        ));
    }
    let pubkey = resolve_caller_pubkey(db, &caller, is_device).await?;
    verify_signature(&pubkey, message, &signature)
        .map_err(|e| unauthorized(&format!("signature verification failed: {e}")))?;
    Ok(VerifiedCaller {
        caller_id: caller,
        is_device,
    })
}

/// Headerless counterpart for SSE endpoints: browser `EventSource` cannot set
/// custom headers, so the three `X-Nodus-*` values arrive as query parameters.
pub async fn verify_signed_query(
    db: &SqlitePool,
    caller: &str,
    timestamp_ms: i64,
    signature: &str,
    message: &[u8],
) -> Result<VerifiedCaller, LocalError> {
    if (chrono::Utc::now().timestamp_millis() - timestamp_ms).abs() > NODE_AUTH_FRESHNESS_MS {
        return Err(unauthorized(
            "request timestamp is outside the freshness window",
        ));
    }
    let pubkey = resolve_caller_pubkey(db, caller, true).await?;
    verify_signature(&pubkey, message, signature)
        .map_err(|e| unauthorized(&format!("signature verification failed: {e}")))?;
    Ok(VerifiedCaller {
        caller_id: caller.to_string(),
        is_device: true,
    })
}

/// Object ids are BLAKE3 digests stored as lowercase hex by `ObjectStore::put`
/// and namespaced under `objects/` in `layout.rs`. Reject anything that is not
/// exactly 64 lowercase hex chars before it can reach path construction — a
/// signed-but-compromised peer could otherwise read arbitrary files under
/// `data_dir` by signing a traversal id.
fn validate_object_id(object_id: &str) -> Result<(), LocalError> {
    if crate::store::layout::is_valid_object_id(object_id) {
        Ok(())
    } else {
        Err(LocalError {
            error: "invalid_object_id".into(),
            message: "object id must be a 64-character lowercase hex digest".into(),
        })
    }
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

    // Consume the token atomically: the guarded UPDATE (WHERE consumed_at IS
    // NULL) is the single source of truth, so two racing redemptions of the
    // same token cannot both win even though the pre-checks above saw it
    // unconsumed. The device insert shares the same transaction so a failure
    // mid-pair leaves the token reusable rather than half-paired (#8).
    let mut tx = state.db.begin().await.map_err(internal_err)?;
    let consumed = sqlx::query(
        "UPDATE pairing_sessions SET consumed_at = ? WHERE token = ? AND consumed_at IS NULL",
    )
    .bind(now_iso())
    .bind(&req.token)
    .execute(&mut *tx)
    .await
    .map_err(internal_err)?
    .rows_affected();

    if consumed != 1 {
        return Err(LocalError {
            error: "token_consumed".into(),
            message: "this pairing token was already used".into(),
        });
    }

    let confirm = store_device_conn(
        &mut tx,
        &state.identity.node_id,
        req,
        pubkey_bytes,
        session.account_id,
    )
    .await?;
    tx.commit().await.map_err(internal_err)?;
    Ok(confirm)
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
    let mut conn = state.db.acquire().await.map_err(internal_err)?;
    store_device_conn(
        &mut conn,
        &state.identity.node_id,
        req,
        pubkey_bytes,
        account_id,
    )
    .await
}

/// Connection variant of [`store_device`]: runs on the caller's transaction so
/// the device insert is atomic with token consumption (#8). A failure
/// mid-pair must leave the token reusable rather than half-paired.
async fn store_device_conn(
    conn: &mut SqliteConnection,
    node_id: &str,
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
    .execute(&mut *conn)
    .await
    .map_err(internal_err)?;

    // Remember the account binding (ADR-0002): the offline recovery endpoints
    // need it later, and pairing is the only moment the node learns it.
    sqlx::query(
        "INSERT INTO node_account (id, account_id, paired_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET account_id = excluded.account_id, paired_at = excluded.paired_at",
    )
    .bind(account_id)
    .bind(&now)
    .execute(&mut *conn)
    .await
    .map_err(internal_err)?;

    Ok(Json(PairConfirm {
        node_id: node_id.to_string(),
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
            "unauthorized" => StatusCode::UNAUTHORIZED,
            // Recovery preconditions read as "not found" rather than a bad
            // request: the caller asked a valid question of a node that has no
            // account binding / no recovery enrollment.
            "not_found" | "no_account" | "recovery_unavailable" => StatusCode::NOT_FOUND,
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
            crate::telemetry::Telemetry::new(),
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
            offer_limiter: Arc::new(RateLimiter::new(
                Duration::from_secs(10),
                super::super::auth::WEBRTC_OFFER_RATE_LIMIT,
            )),
            recovery_nonces: Arc::new(NonceStore::default()),
            recovery_limiter: Arc::new(RateLimiter::new(
                Duration::from_secs(10),
                super::super::auth::RECOVERY_RATE_LIMIT,
            )),
            recovery_auth_limiter: Arc::new(RateLimiter::new(
                Duration::from_secs(60),
                super::super::auth::RECOVERY_AUTH_RATE_LIMIT,
            )),
            recovery_envelopes_limiter: Arc::new(RateLimiter::new(
                Duration::from_secs(60),
                super::super::auth::RECOVERY_ENVELOPES_RATE_LIMIT,
            )),
            relay_http_base: None,
            http: reqwest::Client::new(),
            telemetry: crate::telemetry::Telemetry::new(),
        };
        (make_router(state), db, identity, dir)
    }

    /// Seed a recovery-enabled node: account binding + one recovery envelope
    /// whose recipient_id is the account recovery public key.
    async fn seed_recovery(db: &SqlitePool, recovery_pub_b64: &str) {
        sqlx::query(
            "INSERT INTO node_account (id, account_id, paired_at) VALUES (1, 'acct-recover', 'now')",
        )
        .execute(db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO key_envelopes (file_id, recipient_id, recipient_kind, encrypted_key, created_at)
             VALUES ('file-r', ?, 'recovery', 'opaque', 'now')",
        )
        .bind(recovery_pub_b64)
        .execute(db)
        .await
        .unwrap();
    }

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    #[tokio::test]
    async fn test_offline_recovery_round_trip() {
        let (app, db, _id, _dir) = setup_test_server().await;
        let recovery = SigningKey::from_bytes(&[3u8; 32]);
        let recovery_pub = b64(&recovery.verifying_key().to_bytes());
        seed_recovery(&db, &recovery_pub).await;

        let addr: SocketAddr = "192.168.1.60:5555".parse().unwrap();

        // 1. Challenge advertises the account + recovery key.
        let mut req = Request::builder()
            .uri("/nodus/recovery/challenge")
            .method("POST")
            .body(Body::empty())
            .unwrap();
        req.extensions_mut().insert(ConnectInfo(addr));
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let json: serde_json::Value =
            serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(json["account_id"], "acct-recover");
        assert_eq!(json["recovery_public_key"], recovery_pub);
        let nonce = json["nonce"].as_str().unwrap().to_string();

        // 2. Recover: sign the nonce with the recovery key.
        let device = SigningKey::from_bytes(&[4u8; 32]);
        let signature = hex::encode(recovery.sign(nonce.as_bytes()).to_bytes());
        let body = serde_json::json!({
            "nonce": nonce,
            "signature": signature,
            "device_id": "dev-recovered",
            "device_public_key": b64(&device.verifying_key().to_bytes()),
        });
        let mut req = Request::builder()
            .uri("/nodus/recovery")
            .method("POST")
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        req.extensions_mut().insert(ConnectInfo(addr));
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        // The new device is registered and active on the node.
        let status: String =
            sqlx::query_scalar("SELECT status FROM devices WHERE device_id = 'dev-recovered'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(status, "ACTIVE");

        // 3. Fetch recovery envelopes with a signed device request.
        let ts = chrono::Utc::now().timestamp_millis();
        let message = format!("dev-recovered:recovery-envelopes:{ts}");
        let sig = hex::encode(device.sign(message.as_bytes()).to_bytes());
        let mut req = Request::builder()
            .uri("/nodus/recovery/envelopes")
            .method("GET")
            .header("x-nodus-device-id", "dev-recovered")
            .header("x-nodus-timestamp", ts.to_string())
            .header("x-nodus-signature", sig)
            .body(Body::empty())
            .unwrap();
        req.extensions_mut().insert(ConnectInfo(addr));
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let json: serde_json::Value =
            serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(json["file_envelopes"][0]["file_id"], "file-r");
        assert!(json["folder_envelopes"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_offline_recovery_rejects_bad_signature() {
        let (app, db, _id, _dir) = setup_test_server().await;
        let recovery = SigningKey::from_bytes(&[3u8; 32]);
        seed_recovery(&db, &b64(&recovery.verifying_key().to_bytes())).await;

        let addr: SocketAddr = "192.168.1.61:5555".parse().unwrap();
        let mut req = Request::builder()
            .uri("/nodus/recovery/challenge")
            .method("POST")
            .body(Body::empty())
            .unwrap();
        req.extensions_mut().insert(ConnectInfo(addr));
        let resp = app.clone().oneshot(req).await.unwrap();
        let json: serde_json::Value =
            serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap();
        let nonce = json["nonce"].as_str().unwrap().to_string();

        // A signature from the wrong key must not register the device.
        let attacker = SigningKey::from_bytes(&[9u8; 32]);
        let body = serde_json::json!({
            "nonce": nonce,
            "signature": hex::encode(attacker.sign(nonce.as_bytes()).to_bytes()),
            "device_id": "dev-attacker",
            "device_public_key": b64(&attacker.verifying_key().to_bytes()),
        });
        let mut req = Request::builder()
            .uri("/nodus/recovery")
            .method("POST")
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        req.extensions_mut().insert(ConnectInfo(addr));
        let resp = app.oneshot(req).await.unwrap();
        // `bad_signature` shares the generic 400 mapping with device auth.
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM devices WHERE device_id = 'dev-attacker'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn test_recovery_bad_signature_does_not_burn_nonce() {
        let (app, db, _id, _dir) = setup_test_server().await;
        let recovery = SigningKey::from_bytes(&[3u8; 32]);
        let recovery_pub = b64(&recovery.verifying_key().to_bytes());
        seed_recovery(&db, &recovery_pub).await;

        let addr: SocketAddr = "192.168.1.63:5555".parse().unwrap();
        let mut req = Request::builder()
            .uri("/nodus/recovery/challenge")
            .method("POST")
            .body(Body::empty())
            .unwrap();
        req.extensions_mut().insert(ConnectInfo(addr));
        let resp = app.clone().oneshot(req).await.unwrap();
        let json: serde_json::Value =
            serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap();
        let nonce = json["nonce"].as_str().unwrap().to_string();

        // A garbage signature over the issued nonce must be rejected without
        // consuming the nonce, so a sniffer cannot deny the real recovery.
        let attacker = SigningKey::from_bytes(&[9u8; 32]);
        let bad = serde_json::json!({
            "nonce": nonce,
            "signature": hex::encode(attacker.sign(nonce.as_bytes()).to_bytes()),
            "device_id": "dev-attacker",
            "device_public_key": b64(&attacker.verifying_key().to_bytes()),
        });
        let mut req = Request::builder()
            .uri("/nodus/recovery")
            .method("POST")
            .header("content-type", "application/json")
            .body(Body::from(bad.to_string()))
            .unwrap();
        req.extensions_mut().insert(ConnectInfo(addr));
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

        // The legitimate phrase holder can still use the same nonce.
        let device = SigningKey::from_bytes(&[4u8; 32]);
        let good = serde_json::json!({
            "nonce": nonce,
            "signature": hex::encode(recovery.sign(nonce.as_bytes()).to_bytes()),
            "device_id": "dev-recovered",
            "device_public_key": b64(&device.verifying_key().to_bytes()),
        });
        let mut req = Request::builder()
            .uri("/nodus/recovery")
            .method("POST")
            .header("content-type", "application/json")
            .body(Body::from(good.to_string()))
            .unwrap();
        req.extensions_mut().insert(ConnectInfo(addr));
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        // And the nonce is now spent, so a replay fails.
        let mut req = Request::builder()
            .uri("/nodus/recovery")
            .method("POST")
            .header("content-type", "application/json")
            .body(Body::from(good.to_string()))
            .unwrap();
        req.extensions_mut().insert(ConnectInfo(addr));
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn test_recovery_auth_rate_limited() {
        let (app, _db, _id, _dir) = setup_test_server().await;
        let addr: SocketAddr = "192.168.1.64:5555".parse().unwrap();

        // Valid JSON so the handler (and its limiter) runs; the nonce is bogus so
        // each attempt is a cheap 400 before the limit is hit.
        let body = serde_json::json!({
            "nonce": "deadbeef",
            "signature": "00",
            "device_id": "dev-1",
            "device_public_key": b64(&[1u8; 32]),
        })
        .to_string();
        let make_req = || {
            let mut req = Request::builder()
                .uri("/nodus/recovery")
                .method("POST")
                .header("content-type", "application/json")
                .body(Body::from(body.clone()))
                .unwrap();
            req.extensions_mut().insert(ConnectInfo(addr));
            req
        };

        for _ in 0..super::super::auth::RECOVERY_AUTH_RATE_LIMIT {
            let resp = app.clone().oneshot(make_req()).await.unwrap();
            assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        }
        let resp = app.oneshot(make_req()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::TOO_MANY_REQUESTS);
    }

    #[tokio::test]
    async fn test_offline_recovery_unavailable_without_enrollment() {
        let (app, db, _id, _dir) = setup_test_server().await;
        // Account bound, but no recovery envelope.
        sqlx::query(
            "INSERT INTO node_account (id, account_id, paired_at) VALUES (1, 'acct-no-rec', 'now')",
        )
        .execute(&db)
        .await
        .unwrap();

        let addr: SocketAddr = "192.168.1.62:5555".parse().unwrap();
        let mut req = Request::builder()
            .uri("/nodus/recovery/challenge")
            .method("POST")
            .body(Body::empty())
            .unwrap();
        req.extensions_mut().insert(ConnectInfo(addr));
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
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

    // ── §21a node→node shard fetch (Path A receive) ──────────────────────

    /// Seeds a `trusted_nodes` entry for `peer` (so later handlers treat it
    /// as trusted) and stores the given bytes, returning the object_id.
    async fn seed_peer_and_object(
        db: &SqlitePool,
        store: &crate::store::ObjectStore,
        peer_id: &str,
        peer_pubkey: [u8; 32],
        payload: &[u8],
    ) -> String {
        sqlx::query("INSERT INTO trusted_nodes (node_id, public_key_bytes, created_at) VALUES (?, ?, 'now')")
            .bind(peer_id)
            .bind(&peer_pubkey[..])
            .execute(db)
            .await
            .unwrap();
        store.put(payload).await.unwrap()
    }

    fn signed_fetch_request(
        peer_id: &str,
        peer_key: &SigningKey,
        object_id: &str,
    ) -> Request<Body> {
        let timestamp = chrono::Utc::now().timestamp_millis();
        let message = format!("{peer_id}:{object_id}:{timestamp}");
        let signature = hex::encode(peer_key.sign(message.as_bytes()).to_bytes());
        Request::builder()
            .uri(format!("/nodus/shard/{object_id}"))
            .method("GET")
            .header("x-nodus-node-id", peer_id)
            .header("x-nodus-timestamp", timestamp.to_string())
            .header("x-nodus-signature", signature)
            .body(Body::empty())
            .unwrap()
    }

    #[tokio::test]
    async fn test_shard_fetch_serves_bytes_to_trusted_node() {
        let (app, db, _identity, dir) = setup_test_server().await;

        let peer_key = SigningKey::from_bytes(&[55u8; 32]);
        let peer_pubkey = peer_key.verifying_key().to_bytes();
        let peer_id = "repair-peer-1";
        let payload = b"shard bytes for repair";
        let store = crate::store::ObjectStore::new(dir.path().to_path_buf(), db.clone())
            .await
            .unwrap();
        let object_id = seed_peer_and_object(&db, &store, peer_id, peer_pubkey, payload).await;

        let resp = app
            .oneshot(signed_fetch_request(peer_id, &peer_key, &object_id))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&bytes[..], payload);
    }

    #[tokio::test]
    async fn test_shard_fetch_rejects_untrusted_missing_bad_signature_stale() {
        let (app, db, _identity, dir) = setup_test_server().await;

        let peer_key = SigningKey::from_bytes(&[66u8; 32]);
        let peer_pubkey = peer_key.verifying_key().to_bytes();
        let peer_id = "repair-peer-2";
        let payload = b"shard bytes";
        let store = crate::store::ObjectStore::new(dir.path().to_path_buf(), db.clone())
            .await
            .unwrap();
        let object_id = seed_peer_and_object(&db, &store, peer_id, peer_pubkey, payload).await;

        // Unknown node (not in trusted_nodes) → 401.
        let stranger_key = SigningKey::from_bytes(&[77u8; 32]);
        let unknown = app
            .clone()
            .oneshot(signed_fetch_request("stranger", &stranger_key, &object_id))
            .await
            .unwrap();
        assert_eq!(
            unknown.status(),
            StatusCode::UNAUTHORIZED,
            "untrusted node must be rejected"
        );

        // Known node but wrong signature → 401.
        let bad_key = SigningKey::from_bytes(&[88u8; 32]);
        let resp = app
            .clone()
            .oneshot(signed_fetch_request(peer_id, &bad_key, &object_id))
            .await
            .unwrap();
        assert_eq!(
            resp.status(),
            StatusCode::UNAUTHORIZED,
            "valid-key holder verification is signature-based"
        );

        // Stale timestamp → 401 (headers built manually to pin the past).
        let stale = {
            let timestamp = chrono::Utc::now().timestamp_millis() - 5 * 60_000;
            let message = format!("{peer_id}:{object_id}:{timestamp}");
            let signature = hex::encode(peer_key.sign(message.as_bytes()).to_bytes());
            Request::builder()
                .uri(format!("/nodus/shard/{object_id}"))
                .method("GET")
                .header("x-nodus-node-id", peer_id)
                .header("x-nodus-timestamp", timestamp.to_string())
                .header("x-nodus-signature", signature)
                .body(Body::empty())
                .unwrap()
        };
        let resp = app.clone().oneshot(stale).await.unwrap();
        assert_eq!(
            resp.status(),
            StatusCode::UNAUTHORIZED,
            "stale request rejected"
        );

        // Unknown object id → 404 even for a trusted, validly-signed caller.
        let ghost = blake3::hash(b"never stored").to_hex().to_string();
        let resp = app
            .oneshot(signed_fetch_request(peer_id, &peer_key, &ghost))
            .await
            .unwrap();
        assert_eq!(
            resp.status(),
            StatusCode::NOT_FOUND,
            "missing object returns 404 for authenticated caller"
        );
    }

    #[tokio::test]
    async fn test_shard_fetch_rejects_non_object_id_paths() {
        let (app, db, _identity, dir) = setup_test_server().await;

        let peer_key = SigningKey::from_bytes(&[33u8; 32]);
        let peer_pubkey = peer_key.verifying_key().to_bytes();
        let peer_id = "repair-peer-path-traversal";
        let store = crate::store::ObjectStore::new(dir.path().to_path_buf(), db.clone())
            .await
            .unwrap();
        // Seed a trusted node *and* a real object so we can prove the validator
        // is what blocks bad ids (not merely the auth/trust checks).
        let object_id = seed_peer_and_object(
            &db,
            &store,
            peer_id,
            peer_pubkey,
            b"bytes that must never leak",
        )
        .await;

        // Control: a genuine id still serves after validation is introduced.
        let ok = app
            .clone()
            .oneshot(signed_fetch_request(peer_id, &peer_key, &object_id))
            .await
            .unwrap();
        assert_eq!(ok.status(), StatusCode::OK);

        // Non-hex or wrong-case ids are rejected before touching the filesystem.
        for bad in ["not-an-object-id", &"DEADBEEF".repeat(8)] {
            let resp = app
                .clone()
                .oneshot(signed_fetch_request(peer_id, &peer_key, bad))
                .await
                .unwrap();
            assert_eq!(
                resp.status(),
                StatusCode::BAD_REQUEST,
                "non-hex/wrong-length id `{bad}` must be rejected"
            );
        }

        // Percent-encoded traversal: even if a client could decode it into a
        // path segment, the id itself is not a 64-hex digest, so it must never
        // produce a 200 (200 only happens if bytes were read from disk).
        let traversal = "%2E%2E%2F%2E%2E%2Fnodus.db";
        let resp = app
            .oneshot(signed_fetch_request(peer_id, &peer_key, traversal))
            .await
            .unwrap();
        assert_ne!(
            resp.status(),
            StatusCode::OK,
            "traversal object id must not reach the filesystem"
        );
    }

    // ── Phase 14 F2b: paired-device download ─────────────────────────────

    #[tokio::test]
    async fn test_shard_fetch_serves_bytes_to_paired_device() {
        let (app, db, _identity, dir) = setup_test_server().await;

        let device_key = SigningKey::from_bytes(&[99u8; 32]);
        let device_pubkey = device_key.verifying_key().to_bytes();
        let device_id = "device-download-1";
        let store = crate::store::ObjectStore::new(dir.path().to_path_buf(), db.clone())
            .await
            .unwrap();
        let payload = b"packed nonce+ciphertext";
        let object_id = store.put(payload).await.unwrap();
        sqlx::query(
            "INSERT INTO devices (device_id, public_key_bytes, status, created_at) VALUES (?, ?, 'ACTIVE', 'now')",
        )
        .bind(device_id)
        .bind(&device_pubkey[..])
        .execute(&db)
        .await
        .unwrap();

        let timestamp = chrono::Utc::now().timestamp_millis();
        let message = format!("{device_id}:{object_id}:{timestamp}");
        let signature = hex::encode(device_key.sign(message.as_bytes()).to_bytes());
        let req = Request::builder()
            .uri(format!("/nodus/shard/{object_id}"))
            .method("GET")
            .header("x-nodus-device-id", device_id)
            .header("x-nodus-timestamp", timestamp.to_string())
            .header("x-nodus-signature", signature)
            .body(Body::empty())
            .unwrap();

        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&bytes[..], payload);
    }

    #[tokio::test]
    async fn test_activities_returns_journaled_activity() {
        let (app, db, _identity, _dir) = setup_test_server().await;

        let device_key = SigningKey::from_bytes(&[77u8; 32]);
        let device_pubkey = device_key.verifying_key().to_bytes();
        let device_id = "device-activity-1";
        sqlx::query(
            "INSERT INTO devices (device_id, public_key_bytes, status, created_at) VALUES (?, ?, 'ACTIVE', 'now')",
        )
        .bind(device_id)
        .bind(&device_pubkey[..])
        .execute(&db)
        .await
        .unwrap();

        // The node stores ACTIVITY_LOGGED events from the sync journal; the
        // endpoint projects them into the shared record shape and fills the
        // device from the row's origin, not the payload.
        let payload = serde_json::json!({
            "activity_id": "act-1",
            "kind": "upload",
            "outcome": "complete",
            "file_id": "file-1",
            "path": "local",
            "detail": "2 shards",
            "created_at": "2026-09-19T10:00:00Z",
        })
        .to_string();
        sqlx::query(
            "INSERT INTO sync_events (event_id, origin_id, origin_sequence, event_type, payload, timestamp)
             VALUES ('ev-1', ?, 1, 'ACTIVITY_LOGGED', ?, '2026-09-19T10:00:00Z')",
        )
        .bind(device_id)
        .bind(payload)
        .execute(&db)
        .await
        .unwrap();

        let timestamp = chrono::Utc::now().timestamp_millis();
        let message = format!("{device_id}:activities:{timestamp}");
        let signature = hex::encode(device_key.sign(message.as_bytes()).to_bytes());
        let req = Request::builder()
            .uri("/nodus/activities")
            .method("GET")
            .header("x-nodus-device-id", device_id)
            .header("x-nodus-timestamp", timestamp.to_string())
            .header("x-nodus-signature", signature)
            .body(Body::empty())
            .unwrap();

        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let json: serde_json::Value =
            serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(json["activities"][0]["activity_id"], "act-1");
        assert_eq!(json["activities"][0]["device_id"], device_id);
        assert_eq!(json["activities"][0]["kind"], "upload");
    }

    #[tokio::test]
    async fn test_shard_fetch_rejects_revoked_device_and_both_identity_headers() {
        let (app, db, _identity, dir) = setup_test_server().await;

        let device_key = SigningKey::from_bytes(&[101u8; 32]);
        let device_pubkey = device_key.verifying_key().to_bytes();
        let device_id = "device-revoked-1";
        let store = crate::store::ObjectStore::new(dir.path().to_path_buf(), db.clone())
            .await
            .unwrap();
        let object_id = store.put(b"x").await.unwrap();
        sqlx::query(
            "INSERT INTO devices (device_id, public_key_bytes, status, created_at) VALUES (?, ?, 'REVOKED', 'now')",
        )
        .bind(device_id)
        .bind(&device_pubkey[..])
        .execute(&db)
        .await
        .unwrap();

        let timestamp = chrono::Utc::now().timestamp_millis();
        let message = format!("{device_id}:{object_id}:{timestamp}");
        let signature = hex::encode(device_key.sign(message.as_bytes()).to_bytes());

        // A revoked device must not read shards even with a valid signature.
        let revoked = Request::builder()
            .uri(format!("/nodus/shard/{object_id}"))
            .method("GET")
            .header("x-nodus-device-id", device_id)
            .header("x-nodus-timestamp", timestamp.to_string())
            .header("x-nodus-signature", signature.clone())
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(revoked).await.unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

        // Supplying both a device and a node identity is ambiguous → 401.
        let both = Request::builder()
            .uri(format!("/nodus/shard/{object_id}"))
            .method("GET")
            .header("x-nodus-device-id", device_id)
            .header("x-nodus-node-id", "some-node")
            .header("x-nodus-timestamp", timestamp.to_string())
            .header("x-nodus-signature", signature)
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(both).await.unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    // ── #8: atomic token consumption under concurrency ────────────────────

    #[tokio::test]
    async fn test_pair_concurrent_redeem_single_winner() {
        let (app, db, identity, _dir) = setup_test_server().await;

        let device_key = SigningKey::from_bytes(&[77u8; 32]);
        let device_pubkey = device_key.verifying_key().to_bytes();
        let device_pubkey_b64 = base64::engine::general_purpose::STANDARD.encode(device_pubkey);
        let token = "test-race-token-1";
        let device_id = "device-race-1";
        let expires_at = (chrono::Utc::now() + chrono::Duration::minutes(15)).to_rfc3339();

        sqlx::query(
            "INSERT INTO pairing_sessions (token, device_public_key, node_id, issued_at, expires_at, account_id)
             VALUES (?, ?, ?, 'now', ?, 'acct-race-1')"
        )
        .bind(token)
        .bind(&device_pubkey[..])
        .bind(&identity.node_id)
        .bind(&expires_at)
        .execute(&db)
        .await
        .unwrap();

        let pair_body = serde_json::json!({
            "node_id": identity.node_id,
            "token": token,
            "device_public_key": device_pubkey_b64,
            "device_id": device_id,
        });
        let body = serde_json::to_vec(&pair_body).unwrap();

        // N=8 racing redemptions of the same token from the same device.
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let app = app.clone();
                let body = body.clone();
                tokio::spawn(async move {
                    let req = Request::builder()
                        .uri("/nodus/pair")
                        .method("POST")
                        .header("content-type", "application/json")
                        .body(Body::from(body))
                        .unwrap();
                    let resp = app.oneshot(req).await.unwrap();
                    let status = resp.status();
                    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
                    let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                    (status, json["error"].as_str().map(String::from))
                })
            })
            .collect();

        let results: Vec<_> = futures_util::future::join_all(handles)
            .await
            .into_iter()
            .map(|r| r.unwrap())
            .collect();

        // Exactly one redemption wins; every other request sees the consumed
        // token (guarded UPDATE ... AND consumed_at IS NULL is the arbiter).
        let winners = results
            .iter()
            .filter(|(status, _)| *status == StatusCode::OK)
            .count();
        assert_eq!(winners, 1, "exactly one concurrent redemption may win");
        for (status, err) in &results {
            if *status != StatusCode::OK {
                assert_eq!(*status, StatusCode::BAD_REQUEST);
                assert_eq!(err.as_deref(), Some("token_consumed"));
            }
        }

        // The session is consumed exactly once and the device is stored once.
        let consumed_at: Option<String> =
            sqlx::query_scalar("SELECT consumed_at FROM pairing_sessions WHERE token = ?")
                .bind(token)
                .fetch_one(&db)
                .await
                .unwrap();
        assert!(consumed_at.is_some(), "token must end consumed");

        let device_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM devices WHERE device_id = ?")
                .bind(device_id)
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(device_count, 1, "device row must be inserted exactly once");
    }
}
