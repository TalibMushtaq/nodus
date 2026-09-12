//! Runtime telemetry shared between the node's background tasks and the
//! interactive shell (`shell`).
//!
//! The sync loop publishes the live state of its Relay WebSocket link into
//! this small shared struct; the shell's `status`/`test` commands read it back
//! to answer "is the relay connected?" without duplicating the connection.
//! Keeping one writer + one reader per fact here avoids scatter-printing in the
//! workers and lets the shell stay a read-only observer.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::Utc;

/// Live state of the Relay WebSocket sync link, as last observed by the sync
/// loop.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RelayLink {
    /// No successful session yet, or the last attempt failed.
    Down,
    /// A session is being dialed/handshaken right now.
    Connecting,
    /// The last session finished (or is still running) successfully.
    Up,
}

/// Point-in-time snapshot of node runtime telemetry.
#[derive(Clone, Debug)]
pub struct Snapshot {
    pub link: RelayLink,
    pub last_error: Option<String>,
    pub sessions: u64,
    /// ISO RFC 3339 timestamp of the last successful session.
    pub last_up_rfc3339: Option<String>,
    /// How long the node has been running.
    pub uptime: Duration,
    /// Client→node direct (WebRTC) sessions over the internet, live right now.
    pub direct_active: u32,
    /// Cumulative direct sessions observed since boot.
    pub direct_sessions: u64,
    /// ISO RFC 3339 timestamp of the last direct session start.
    pub last_direct_rfc3339: Option<String>,
    /// Whether the local HTTP listener (:9378) is bound and serving.
    pub local_listening: bool,
    /// ISO RFC 3339 timestamp of the last successful LAN challenge-response
    /// auth from a paired client.
    pub local_last_auth_rfc3339: Option<String>,
}

#[derive(Clone, Default)]
pub struct Telemetry(Arc<Mutex<TelemetryInner>>);

struct TelemetryInner {
    started: Instant,
    link: RelayLink,
    last_error: Option<String>,
    sessions: u64,
    last_up_rfc3339: Option<String>,
    direct_active: u32,
    direct_sessions: u64,
    last_direct_rfc3339: Option<String>,
    local_listening: bool,
    local_last_auth_rfc3339: Option<String>,
}

impl Default for TelemetryInner {
    fn default() -> Self {
        Self {
            started: Instant::now(),
            link: RelayLink::Down,
            last_error: None,
            sessions: 0,
            last_up_rfc3339: None,
            direct_active: 0,
            direct_sessions: 0,
            last_direct_rfc3339: None,
            local_listening: false,
            local_last_auth_rfc3339: None,
        }
    }
}

impl Telemetry {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(TelemetryInner::default())))
    }

    /// The sync loop is about to dial/authenticate.
    pub fn set_connecting(&self) {
        self.with_inner(|inner| inner.link = RelayLink::Connecting);
    }

    /// The link came up and a full session completed successfully.
    pub fn session_up(&self) {
        self.with_inner(|inner| {
            inner.link = RelayLink::Up;
            inner.sessions += 1;
            inner.last_error = None;
            inner.last_up_rfc3339 = Some(Utc::now().to_rfc3339());
        });
    }

    /// The last attempt failed; remember the reason for the shell's `test`.
    pub fn set_down(&self, err: String) {
        self.with_inner(|inner| {
            inner.link = RelayLink::Down;
            inner.last_error = Some(err);
        });
    }

    /// A client established a direct (WebRTC) session to this node.
    pub fn direct_session_started(&self) {
        self.with_inner(|inner| {
            inner.direct_sessions += 1;
            inner.last_direct_rfc3339 = Some(Utc::now().to_rfc3339());
        });
    }

    /// The WebRTC manager reports its live session count (bumped on session
    /// create, shrunk when its reaper prunes abandoned sessions).
    pub fn set_direct_active(&self, active: u32) {
        self.with_inner(|inner| inner.direct_active = active);
    }

    /// The local HTTP listener is bound and serving on :9378.
    pub fn set_local_listening(&self, listening: bool) {
        self.with_inner(|inner| inner.local_listening = listening);
    }

    /// A paired client completed the LAN challenge-response auth handshake.
    pub fn local_auth(&self) {
        self.with_inner(|inner| {
            inner.local_last_auth_rfc3339 = Some(Utc::now().to_rfc3339());
        });
    }

    pub fn snapshot(&self) -> Snapshot {
        let inner = self.0.lock().expect("telemetry mutex poisoned");
        Snapshot {
            link: inner.link.clone(),
            last_error: inner.last_error.clone(),
            sessions: inner.sessions,
            last_up_rfc3339: inner.last_up_rfc3339.clone(),
            uptime: inner.started.elapsed(),
            direct_active: inner.direct_active,
            direct_sessions: inner.direct_sessions,
            last_direct_rfc3339: inner.last_direct_rfc3339.clone(),
            local_listening: inner.local_listening,
            local_last_auth_rfc3339: inner.local_last_auth_rfc3339.clone(),
        }
    }

    fn with_inner(&self, f: impl FnOnce(&mut TelemetryInner)) {
        let mut inner = self.0.lock().expect("telemetry mutex poisoned");
        f(&mut inner);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_down_and_tracks_uptime() {
        let t = Telemetry::new();
        let snap = t.snapshot();
        assert_eq!(snap.link, RelayLink::Down);
        assert_eq!(snap.sessions, 0);
        assert_eq!(snap.last_error, None);
        assert!(snap.uptime >= Duration::ZERO);
    }

    #[test]
    fn session_up_clears_error_and_counts() {
        let t = Telemetry::new();
        t.set_down("boom".to_string());
        assert_eq!(t.snapshot().link, RelayLink::Down);

        t.set_connecting();
        assert_eq!(t.snapshot().link, RelayLink::Connecting);

        t.session_up();
        let snap = t.snapshot();
        assert_eq!(snap.link, RelayLink::Up);
        assert_eq!(snap.sessions, 1);
        assert_eq!(snap.last_error, None);
        assert!(snap.last_up_rfc3339.is_some());
    }

    #[test]
    fn direct_sessions_track_cumulative_and_live_counts() {
        let t = Telemetry::new();
        let snap = t.snapshot();
        assert_eq!(snap.direct_active, 0);
        assert_eq!(snap.direct_sessions, 0);
        assert!(snap.last_direct_rfc3339.is_none());

        t.direct_session_started();
        t.set_direct_active(2);
        let snap = t.snapshot();
        assert_eq!(snap.direct_sessions, 1);
        assert_eq!(snap.direct_active, 2);
        assert!(snap.last_direct_rfc3339.is_some());
    }

    #[test]
    fn local_facts_start_unset_and_update() {
        let t = Telemetry::new();
        assert!(!t.snapshot().local_listening);
        assert!(t.snapshot().local_last_auth_rfc3339.is_none());

        t.set_local_listening(true);
        t.local_auth();
        let snap = t.snapshot();
        assert!(snap.local_listening);
        assert!(snap.local_last_auth_rfc3339.is_some());
    }
}
