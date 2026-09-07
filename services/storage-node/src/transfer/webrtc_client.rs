use std::sync::Arc;
use std::time::Duration;

use webrtc::api::APIBuilder;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;

use super::config::TransferConfig;
use super::types::{ShardTransferRequest, TransferResult, TransferPath};

/// Node as WebRTC initiator — creates offers, handles answers, and
/// transfers shard bytes over a DataChannel. This is the Rust counterpart
/// of the TS `transferShardViaWebRtc` in `packages/webrtc-transport`.
///
/// The signaling channel (how the offer/answer/ICE are exchanged) is
/// parameterized via `SignalingSender` — it can be local HTTP (Path A)
/// or Relay WS (Path B).
#[async_trait::async_trait]
pub trait SignalingSender: Send + Sync {
    /// Send an SDP offer and wait for the answer string.
    async fn send_offer(&self, sdp: &str) -> anyhow::Result<String>;
}

/// Initiate a WebRTC transfer, sending shard bytes to a remote peer.
pub async fn initiate_transfer(
    request: &ShardTransferRequest,
    signaling: &impl SignalingSender,
    config: &TransferConfig,
    path: TransferPath,
) -> TransferResult {
    let start = std::time::Instant::now();
    let timeout = Duration::from_millis(config.webrtc_negotiation_timeout_ms);

    let api = APIBuilder::new().build();
    let rtc_config = RTCConfiguration {
        ice_servers: vec![RTCIceServer {
            urls: vec!["stun:stun.l.google.com:19302".to_string()],
            ..Default::default()
        }],
        ..Default::default()
    };

    let pc = match api.new_peer_connection(rtc_config).await {
        Ok(pc) => Arc::new(pc),
        Err(e) => {
            return TransferResult {
                path,
                duration_ms: start.elapsed().as_millis() as u64,
                transfer_id: request.transfer_id.clone(),
                bytes_transferred: 0,
                success: false,
                error: Some(format!("peer connection creation failed: {e}")),
            };
        }
    };

    // Create the DataChannel for shard transfer
    let channel_name = format!("nodus-shard-{}", request.shard_index);
    let dc = match pc.create_data_channel(&channel_name, Default::default()).await {
        Ok(dc) => Arc::new(dc),
        Err(e) => {
            pc.close().await.ok();
            return TransferResult {
                path,
                duration_ms: start.elapsed().as_millis() as u64,
                transfer_id: request.transfer_id.clone(),
                bytes_transferred: 0,
                success: false,
                error: Some(format!("data channel creation failed: {e}")),
            };
        }
    };

    // Set up DataChannel open listener
    let dc_open = {
        let dc = dc.clone();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let tx = std::sync::Mutex::new(Some(tx));

        dc.on_open(Box::new(move || {
            if let Some(tx) = tx.lock().unwrap().take() {
                let _ = tx.send(());
            }
            Box::pin(async {})
        }));

        rx
    };

    // Generate SDP offer
    let offer = match pc.create_offer(None).await {
        Ok(o) => o,
        Err(e) => {
            pc.close().await.ok();
            return TransferResult {
                path,
                duration_ms: start.elapsed().as_millis() as u64,
                transfer_id: request.transfer_id.clone(),
                bytes_transferred: 0,
                success: false,
                error: Some(format!("SDP offer creation failed: {e}")),
            };
        }
    };

    let offer_sdp = offer.sdp.clone();

    // Send offer via signaling and await answer
    let answer_sdp = match signaling.send_offer(&offer_sdp).await {
        Ok(a) => a,
        Err(e) => {
            pc.close().await.ok();
            return TransferResult {
                path,
                duration_ms: start.elapsed().as_millis() as u64,
                transfer_id: request.transfer_id.clone(),
                bytes_transferred: 0,
                success: false,
                error: Some(format!("signaling offer failed: {e}")),
            };
        }
    };

    // Set local description
    if let Err(e) = pc.set_local_description(offer).await {
        pc.close().await.ok();
        return TransferResult {
            path,
            duration_ms: start.elapsed().as_millis() as u64,
            transfer_id: request.transfer_id.clone(),
            bytes_transferred: 0,
            success: false,
            error: Some(format!("set local description failed: {e}")),
        };
    }

    // Set remote description (answer)
    let answer = match RTCSessionDescription::answer(answer_sdp) {
        Ok(a) => a,
        Err(e) => {
            pc.close().await.ok();
            return TransferResult {
                path,
                duration_ms: start.elapsed().as_millis() as u64,
                transfer_id: request.transfer_id.clone(),
                bytes_transferred: 0,
                success: false,
                error: Some(format!("invalid SDP answer: {e}")),
            };
        }
    };
    if let Err(e) = pc.set_remote_description(answer).await {
        pc.close().await.ok();
        return TransferResult {
            path,
            duration_ms: start.elapsed().as_millis() as u64,
            transfer_id: request.transfer_id.clone(),
            bytes_transferred: 0,
            success: false,
            error: Some(format!("set remote description failed: {e}")),
        };
    }

    // Wait for DataChannel to open (with timeout)
    match tokio::time::timeout(timeout, dc_open).await {
        Ok(Ok(())) => { /* channel is open */ }
        _ => {
            pc.close().await.ok();
            return TransferResult {
                path,
                duration_ms: start.elapsed().as_millis() as u64,
                transfer_id: request.transfer_id.clone(),
                bytes_transferred: 0,
                success: false,
                error: Some(format!(
                    "WebRTC negotiation timed out after {}ms",
                    config.webrtc_negotiation_timeout_ms
                )),
            };
        }
    }

    // Transfer shard: metadata header, binary data, done signal, wait for ack
    let metadata = serde_json::json!({
        "file_id": request.file_id,
        "version_number": request.version_number,
        "shard_index": request.shard_index,
        "hash": request.hash,
        "transfer_id": request.transfer_id,
    });

    if let Err(e) = dc.send_text(metadata.to_string()).await {
        pc.close().await.ok();
        return TransferResult {
            path,
            duration_ms: start.elapsed().as_millis() as u64,
            transfer_id: request.transfer_id.clone(),
            bytes_transferred: 0,
            success: false,
            error: Some(format!("send metadata failed: {e}")),
        };
    }

    if let Err(e) = dc.send(&request.data.clone().into()).await {
        pc.close().await.ok();
        return TransferResult {
            path,
            duration_ms: start.elapsed().as_millis() as u64,
            transfer_id: request.transfer_id.clone(),
            bytes_transferred: 0,
            success: false,
            error: Some(format!("send data failed: {e}")),
        };
    }

    if let Err(e) = dc.send_text(r#"{"shard_done":true}"#).await {
        pc.close().await.ok();
        return TransferResult {
            path,
            duration_ms: start.elapsed().as_millis() as u64,
            transfer_id: request.transfer_id.clone(),
            bytes_transferred: request.data.len(),
            success: false,
            error: Some(format!("send done signal failed: {e}")),
        };
    }

    // Wait for ack (generous timeout for verification)
    let ack_timeout = Duration::from_secs(30);
    let ack_result = {
        let (ack_tx, ack_rx) = tokio::sync::oneshot::channel();
        let ack_tx = std::sync::Mutex::new(Some(ack_tx));

        dc.on_message(Box::new(move |msg: DataChannelMessage| {
            if msg.is_string {
                if let Ok(text) = String::from_utf8(msg.data.to_vec()) {
                    if let Ok(ack) = serde_json::from_str::<serde_json::Value>(&text) {
                        match ack.get("status").and_then(|s| s.as_str()) {
                            Some("verified") => {
                                if let Some(tx) = ack_tx.lock().unwrap().take() {
                                    let _ = tx.send(Ok(()));
                                }
                            }
                            Some("failed") => {
                                let err = ack
                                    .get("error_message")
                                    .and_then(|e| e.as_str())
                                    .unwrap_or("unknown error")
                                    .to_string();
                                if let Some(tx) = ack_tx.lock().unwrap().take() {
                                    let _ = tx.send(Err(err));
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
            Box::pin(async {})
        }));

        ack_rx
    };

    match tokio::time::timeout(ack_timeout, ack_result).await {
        Ok(Ok(Ok(()))) => {
            pc.close().await.ok();
            TransferResult {
                path,
                duration_ms: start.elapsed().as_millis() as u64,
                transfer_id: request.transfer_id.clone(),
                bytes_transferred: request.data.len(),
                success: true,
                error: None,
            }
        }
        Ok(Ok(Err(e))) => {
            pc.close().await.ok();
            TransferResult {
                path,
                duration_ms: start.elapsed().as_millis() as u64,
                transfer_id: request.transfer_id.clone(),
                bytes_transferred: request.data.len(),
                success: false,
                error: Some(format!("transfer rejected: {e}")),
            }
        }
        _ => {
            pc.close().await.ok();
            TransferResult {
                path,
                duration_ms: start.elapsed().as_millis() as u64,
                transfer_id: request.transfer_id.clone(),
                bytes_transferred: request.data.len(),
                success: false,
                error: Some("timed out waiting for shard ack".to_string()),
            }
        }
    }
}
