use std::convert::Infallible;

use axum::Json;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, Sse};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tokio_stream::wrappers::BroadcastStream;

use crate::local::server::{LocalError, LocalState};

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
}

pub async fn handle_offer(
    State(state): State<LocalState>,
    Json(body): Json<OfferRequest>,
) -> Result<Json<OfferResponse>, (StatusCode, Json<LocalError>)> {
    // 1. Verify device exists and is not revoked
    let exists: Option<String> = sqlx::query_scalar(
        "SELECT device_id FROM devices WHERE device_id = ? AND revoked_at IS NULL",
    )
    .bind(&body.device_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(LocalError {
                error: "db_error".into(),
                message: format!("database error: {e}"),
            }),
        )
    })?;

    if exists.is_none() {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(LocalError {
                error: "unauthorized".into(),
                message: "device is not paired or has been revoked".into(),
            }),
        ));
    }

    // 2. Get or create WebRTC session
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

    // 3. Process SDP offer and generate answer
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
    Json(body): Json<IceCandidateRequest>,
) -> Result<StatusCode, (StatusCode, Json<LocalError>)> {
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
    // 1. Verify device exists and is not revoked
    let exists: Option<String> = sqlx::query_scalar(
        "SELECT device_id FROM devices WHERE device_id = ? AND revoked_at IS NULL",
    )
    .bind(&query.device_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(LocalError {
                error: "db_error".into(),
                message: format!("database error: {e}"),
            }),
        )
    })?;

    if exists.is_none() {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(LocalError {
                error: "unauthorized".into(),
                message: "device is not paired or has been revoked".into(),
            }),
        ));
    }

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
