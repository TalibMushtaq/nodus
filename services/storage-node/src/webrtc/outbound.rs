//! Outbound WebRTC data-channel sender for node→node shard repair (Path B).
//!
//! The node's [`super::session::WebRtcSession`] is answerer-only: it accepts
//! channels a device/peer opens and stores what they upload. Path B needs the
//! opposite — the *holder* node originates the peer connection to the repairing
//! node and pushes the shard. This module is that initiator.
//!
//! It is deliberately free of relay/WS concerns: the caller wires SDP and ICE
//! through whatever signaling channel it has (the node's authenticated Relay
//! WS) and calls [`OutboundSession::send_shard`], which uses the exact
//! metadata → binary → `shard_done` framing `WebRtcSession` expects and waits
//! for the receiver's ack.

use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, bail};
use tokio::sync::{Mutex, mpsc};
use tokio::time::sleep;
use webrtc::api::APIBuilder;
use webrtc::data_channel::RTCDataChannel;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::data_channel::data_channel_state::RTCDataChannelState;
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;

use super::session::{
    SHARD_CHUNK_BYTES, SHARD_CHUNK_HIGH_WATER, ShardAckPayload, ShardUploadPayload,
};

/// Must match the label the answerer accepts on its `on_data_channel`.
const DATA_CHANNEL_LABEL: &str = "nodus-shard";
/// How long to wait for the data channel to reach `Open` after signaling.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// How long to wait for the receiver's ack after sending one shard.
const ACK_TIMEOUT: Duration = Duration::from_secs(30);

pub struct OutboundSession {
    peer_connection: Arc<RTCPeerConnection>,
    data_channel: Arc<RTCDataChannel>,
    ice_rx: tokio::sync::broadcast::Receiver<String>,
    /// Acks parsed from channel text frames. `send_shard` matches by transfer id
    /// so an interleaved/foreign ack cannot satisfy the wrong shard.
    ack_rx: Arc<Mutex<mpsc::UnboundedReceiver<ShardAckPayload>>>,
}

impl OutboundSession {
    /// Build a peer connection with a pre-created data channel and register the
    /// ICE and ack callbacks. STUN mirrors [`super::session::WebRtcSession`], so
    /// an offline-first deployment can disable/redirect it.
    pub async fn new() -> anyhow::Result<Self> {
        let api = APIBuilder::new().build();
        let stun_url = std::env::var("NODUS_STUN_URL")
            .unwrap_or_else(|_| "stun:stun.l.google.com:19302".to_string());
        let ice_servers = if stun_url.trim().is_empty() {
            Vec::new()
        } else {
            vec![RTCIceServer {
                urls: vec![stun_url],
                ..Default::default()
            }]
        };
        let config = RTCConfiguration {
            ice_servers,
            ..Default::default()
        };

        let peer_connection = Arc::new(
            api.new_peer_connection(config)
                .await
                .context("creating outbound WebRTC peer connection")?,
        );

        // Local ICE candidates are broadcast for the caller to forward over its
        // signaling channel.
        let (ice_tx, ice_rx) = tokio::sync::broadcast::channel(64);
        peer_connection.on_ice_candidate(Box::new(move |candidate| {
            let tx = ice_tx.clone();
            Box::pin(async move {
                if let Some(Ok(json)) = candidate.map(|c| c.to_json()) {
                    let _ = tx.send(serde_json::to_string(&json).unwrap_or_default());
                }
            })
        }));

        // One data channel is created by the initiator; the answerer observes it
        // via `on_data_channel`.
        let data_channel = peer_connection
            .create_data_channel(DATA_CHANNEL_LABEL, None)
            .await
            .context("creating outbound data channel")?;

        let (ack_tx, ack_rx) = mpsc::unbounded_channel::<ShardAckPayload>();
        data_channel.on_message(Box::new(move |msg: DataChannelMessage| {
            let ack_tx = ack_tx.clone();
            Box::pin(async move {
                if !msg.is_string {
                    return;
                }
                if let Ok(text) = String::from_utf8(msg.data.to_vec())
                    && let Ok(ack) = serde_json::from_str::<ShardAckPayload>(&text)
                {
                    let _ = ack_tx.send(ack);
                }
            })
        }));

        Ok(Self {
            peer_connection,
            data_channel,
            ice_rx,
            ack_rx: Arc::new(Mutex::new(ack_rx)),
        })
    }

    /// Create and apply the local offer. The returned SDP is sent to the
    /// answerer over signaling.
    pub async fn create_offer(&self) -> anyhow::Result<String> {
        let offer = self
            .peer_connection
            .create_offer(None)
            .await
            .context("creating outbound offer")?;
        self.peer_connection
            .set_local_description(offer.clone())
            .await
            .context("setting local description")?;
        Ok(offer.sdp)
    }

    /// Apply the answerer's SDP answer.
    pub async fn set_answer(&self, sdp: &str) -> anyhow::Result<()> {
        let answer =
            RTCSessionDescription::answer(sdp.to_string()).context("parsing answer SDP")?;
        self.peer_connection
            .set_remote_description(answer)
            .await
            .context("setting remote description")?;
        Ok(())
    }

    /// Subscribe to this side's ICE candidates for forwarding over signaling.
    pub fn subscribe_ice(&self) -> tokio::sync::broadcast::Receiver<String> {
        self.ice_rx.resubscribe()
    }

    /// Add a remote ICE candidate (JSON `RTCIceCandidateInit`).
    pub async fn add_ice_candidate(&self, candidate_json: &str) -> anyhow::Result<()> {
        let init: RTCIceCandidateInit =
            serde_json::from_str(candidate_json).context("parsing remote ICE candidate")?;
        self.peer_connection
            .add_ice_candidate(init)
            .await
            .context("adding remote ICE candidate")?;
        Ok(())
    }

    async fn wait_open(&self) -> anyhow::Result<()> {
        let deadline = Instant::now() + CONNECT_TIMEOUT;
        while self.data_channel.ready_state() != RTCDataChannelState::Open {
            if Instant::now() >= deadline {
                bail!("outbound data channel did not open within {CONNECT_TIMEOUT:?}");
            }
            sleep(Duration::from_millis(50)).await;
        }
        Ok(())
    }

    /// Stream one shard in the answerer's expected framing and wait for its ack.
    /// Serialized by design: the receiver's per-channel state machine handles
    /// one shard at a time.
    pub async fn send_shard(
        &self,
        meta: &ShardUploadPayload,
        bytes: &[u8],
    ) -> anyhow::Result<ShardAckPayload> {
        self.wait_open().await?;

        self.data_channel
            .send_text(serde_json::to_string(meta).context("serializing shard metadata")?)
            .await
            .context("sending shard metadata")?;
        // SCTP rejects a message larger than the negotiated max-message-size,
        // so stream the shard in chunks with flow control (the answerer's
        // `on_binary` already accumulates chunks). A single send of a multi-MiB
        // shard failed with `ErrOutboundPacketTooLarge` and stalled the repair.
        let payload = bytes::Bytes::copy_from_slice(bytes);
        let mut offset = 0;
        while offset < payload.len() {
            if self.data_channel.buffered_amount().await > SHARD_CHUNK_HIGH_WATER {
                sleep(Duration::from_millis(5)).await;
                continue;
            }
            let end = (offset + SHARD_CHUNK_BYTES).min(payload.len());
            self.data_channel
                .send(&payload.slice(offset..end))
                .await
                .context("sending shard bytes")?;
            offset = end;
        }
        self.data_channel
            .send_text(serde_json::json!({ "shard_done": true }).to_string())
            .await
            .context("sending shard_done")?;

        let mut ack_rx = self.ack_rx.lock().await;
        loop {
            match tokio::time::timeout(ACK_TIMEOUT, ack_rx.recv()).await {
                Ok(Some(ack)) if ack.transfer_id == meta.transfer_id => return Ok(ack),
                // Stale ack for a different transfer: keep waiting for ours.
                Ok(Some(_)) => continue,
                Ok(None) => bail!("ack channel closed before the receiver replied"),
                Err(_) => bail!("timed out waiting for the shard ack"),
            }
        }
    }

    /// Close the peer connection, releasing its sockets and buffers.
    pub async fn close(&self) {
        let _ = self.peer_connection.close().await;
    }
}
