//! Phase 11: local discovery, pairing and challenge-response auth.
//!
//! Spawns the mDNS advertiser plus the plain-HTTP listener that together let
//! web/mobile clients find the node on the LAN and establish durable trust
//! via Relay-issued pairing tokens (see docs/protocol/local-discovery.md and
//! docs/security/local-endpoints.md).

pub mod auth;
pub mod mdns;
pub mod server;

use std::sync::Arc;

use sqlx::sqlite::SqlitePool;

use crate::identity::NodeIdentity;

/// Start mDNS advertisement and the local HTTP listener.
///
/// `relay_url` gates the pairing-verify fallback: when `Some`, the server
/// derives the Relay HTTP base for lazy token checks; when `None` the node is
/// fully offline and pairing can only succeed for tokens already pushed over
/// the (impossible, without a connection) WS. Returns the HTTP task handle.
pub async fn spawn_local(
    identity: Arc<NodeIdentity>,
    db: SqlitePool,
    relay_url: Option<&str>,
    port: u16,
) -> anyhow::Result<tokio::task::JoinHandle<()>> {
    let _mdns =
        mdns::MdnsAdvertiser::start(&identity.node_id, identity.public_key.as_bytes(), port)?;
    server::spawn(identity, db, relay_url).await
}
