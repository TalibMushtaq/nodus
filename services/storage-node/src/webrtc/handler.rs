use std::convert::Infallible;

use axum::Json;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::sse::{Event, Sse};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tokio_stream::wrappers::BroadcastStream;

use crate::local::server::{LocalError, LocalState, verify_signed_caller, verify_signed_query};

#[derive(Deserialize)]
pub struct OfferRequest {
    pub session_id: String,
    pub device_id: String,
    pub sdp: String,
}

#[derive(Serialize)]
pub struct OfferResponse {
    pub session_id: String,
    pub sdp: String,
}

#[derive(Deserialize)]
pub struct IceCandidateRequest {
    pub session_id: String,
    pub device_id: String,
    pub candidate: String,
}

#[derive(Deserialize)]
pub struct IceQuery {
    pub session_id: String,
    pub device_id: String,
    /// Unix millis the signature was created at (SSE cannot set headers, so
    /// the three `X-Nodus-*` values ride in the query string).
    pub timestamp: i64,
    /// Hex-encoded Ed25519 signature over `"{device_id}:{session_id}:{timestamp}"`.
    pub signature: String,
}

/// Enforce the signed-device auth for one WebRTC signaling message. The device
/// proves possession of its pairing key per message; the body's `device_id`
/// must equal the authenticated caller so a signature can't be replayed across
/// sessions or devices.
async fn verify_webrtc_caller(
    state: &LocalState,
    headers: &HeaderMap,
    device_id: &str,
    session_id: &str,
) -> Result<(), (StatusCode, Json<LocalError>)> {
    let timestamp = headers
        .get("x-nodus-timestamp")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<i64>().ok())
        .ok_or_else(|| unauthorized_err("missing or invalid X-Nodus-Timestamp header"))?;

    // The message binds device, session, and time; verify_signed_caller also
    // enforces the timestamp freshness window from the same header.
    let message = format!("{device_id}:{session_id}:{timestamp}");
    let caller = verify_signed_caller(&state.db, headers, message.as_bytes())
        .await
        .map_err(to_unauthorized)?;

    if caller.caller_id != device_id {
        return Err(unauthorized_err(
            "signed caller does not match request device_id",
        ));
    }
    // WebRTC signaling is a device capability: refuse node-signed requests even
    // if the key verifies, so a trusted peer can't drive client sessions.
    if !caller.is_device {
        return Err(unauthorized_err(
            "signaling requires a paired device identity",
        ));
    }
    Ok(())
}

fn unauthorized_err(message: &str) -> (StatusCode, Json<LocalError>) {
    (
        StatusCode::UNAUTHORIZED,
        Json(LocalError {
            error: "unauthorized".into(),
            message: message.into(),
        }),
    )
}

fn to_unauthorized(e: LocalError) -> (StatusCode, Json<LocalError>) {
    (
        StatusCode::UNAUTHORIZED,
        Json(LocalError {
            error: e.error,
            message: e.message,
        }),
    )
}

pub async fn handle_offer(
    State(state): State<LocalState>,
    headers: HeaderMap,
    Json(body): Json<OfferRequest>,
) -> Result<Json<OfferResponse>, (StatusCode, Json<LocalError>)> {
    verify_webrtc_caller(&state, &headers, &body.device_id, &body.session_id).await?;

    // Get or create WebRTC session (single-flight in the manager).
    let session = state
        .webrtc_manager
        .get_or_create_session(&body.session_id, &body.device_id)
        .await
        .map_err(|e| {
            (
                StatusCode::BAD_REQUEST,
                Json(LocalError {
                    error: "session_error".into(),
                    message: format!("session error: {e}"),
                }),
            )
        })?;
    session.touch();

    // Process SDP offer and generate answer
    let answer_sdp = session.handle_offer(&body.sdp).await.map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            Json(LocalError {
                error: "webrtc_error".into(),
                message: format!("failed to handle sdp offer: {e}"),
            }),
        )
    })?;

    Ok(Json(OfferResponse {
        session_id: body.session_id,
        sdp: answer_sdp,
    }))
}

pub async fn handle_ice_candidate(
    State(state): State<LocalState>,
    headers: HeaderMap,
    Json(body): Json<IceCandidateRequest>,
) -> Result<StatusCode, (StatusCode, Json<LocalError>)> {
    verify_webrtc_caller(&state, &headers, &body.device_id, &body.session_id).await?;

    let session = match state.webrtc_manager.get_session(&body.session_id).await {
        Some(s) => s,
        None => {
            return Err((
                StatusCode::NOT_FOUND,
                Json(LocalError {
                    error: "session_not_found".into(),
                    message: "WebRTC session does not exist or expired".into(),
                }),
            ));
        }
    };

    if session.device_id != body.device_id {
        return Err((
            StatusCode::FORBIDDEN,
            Json(LocalError {
                error: "forbidden".into(),
                message: "device_id mismatch".into(),
            }),
        ));
    }
    session.touch();

    session
        .add_ice_candidate(&body.candidate)
        .await
        .map_err(|e| {
            (
                StatusCode::BAD_REQUEST,
                Json(LocalError {
                    error: "ice_error".into(),
                    message: format!("failed to add ice candidate: {e}"),
                }),
            )
        })?;

    Ok(StatusCode::OK)
}

pub async fn stream_ice_candidates(
    State(state): State<LocalState>,
    Query(query): Query<IceQuery>,
) -> Result<
    Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>>,
    (StatusCode, Json<LocalError>),
> {
    // SSE cannot send headers, so the signature arrives via query params. Same
    // freshness window and same Ed25519 message shape as the POST endpoints.
    let message = format!(
        "{}:{}:{}",
        query.device_id, query.session_id, query.timestamp
    );
    verify_signed_query(
        &state.db,
        &query.device_id,
        query.timestamp,
        &query.signature,
        message.as_bytes(),
    )
    .await
    .map_err(|e| {
        (
            StatusCode::UNAUTHORIZED,
            Json(LocalError {
                error: e.error,
                message: e.message,
            }),
        )
    })?;

    let session = match state.webrtc_manager.get_session(&query.session_id).await {
        Some(s) => s,
        None => {
            // Auto-create or wait if requested before offer
            match state
                .webrtc_manager
                .get_or_create_session(&query.session_id, &query.device_id)
                .await
            {
                Ok(s) => s,
                Err(e) => {
                    return Err((
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(LocalError {
                            error: "session_error".into(),
                            message: format!("failed to create session: {e}"),
                        }),
                    ));
                }
            }
        }
    };

    let rx = session.subscribe_ice();
    session.touch();
    let stream = BroadcastStream::new(rx).filter_map(|res| async move {
        match res {
            Ok(candidate_json) => {
                Some(Ok(Event::default().event("candidate").data(candidate_json)))
            }
            Err(_) => None,
        }
    });

    Ok(Sse::new(stream))
}
