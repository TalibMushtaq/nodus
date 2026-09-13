//! Interactive command shell inside the running Storage Node.
//!
//! When the node boots on a terminal (`nodus` → "Run the node", or
//! `nodus node start` on a TTY) it enters this shell instead of silently
//! blocking on Ctrl+C. Commands read the node's own SQLite catalogue and the
//! shared runtime `Telemetry`, so an operator can keep an eye on live state
//! without leaving the process:
//!
//!   help        list commands
//!   status      node identity, config, uptime, connections (relay / direct / local)
//!   storage     object / file / folder totals (this node)
//!   files       list stored files (ciphertext names)
//!   folders     list stored folders
//!   conflicts   list preserved conflicted copies (ADR-0003)
//!   devices     paired clients + last authentication
//!   test        live connectivity checks (relay HTTP + WS, local HTTP, storage)
//!   quit        stop the node  (Ctrl+C or EOF also work)
//!
//! Piped/systemd runs never reach this shell; `boot_daemon` only enters it when
//! stdin is a terminal, keeping the legacy non-interactive daemon behavior.

use std::io::Write;
use std::time::Duration;

use anyhow::Context;
use chrono::{DateTime, Utc};
use sqlx::SqlitePool;
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::config::Config;
use crate::identity::NodeIdentity;
use crate::local::server::LOCAL_PORT;
use crate::report;
use crate::sync::client::relay_http_base;
use crate::telemetry::{RelayLink, Snapshot, Telemetry};

pub struct Shell {
    pub cfg: Config,
    pub db: SqlitePool,
    pub telemetry: Telemetry,
    pub identity: std::sync::Arc<NodeIdentity>,
    pub relay_ws_url: String,
}

pub async fn run(shell: Shell) -> anyhow::Result<()> {
    println!("Storage node shell — type `help` for commands, `quit` or Ctrl+C to stop.");

    let mut reader = BufReader::new(tokio::io::stdin());
    let mut line = String::new();
    loop {
        print!("nodus> ");
        std::io::stdout().flush().ok();

        line.clear();
        let read = reader.read_line(&mut line).await?;
        if read == 0 {
            // EOF (e.g. piped stdin that ran out) is a clean exit.
            println!();
            return Ok(());
        }
        let command = line.trim();
        match command {
            "" => {}
            "help" | "?" => print_help(),
            "status" => status(&shell).await?,
            "storage" | "summary" => report::print_summary(&shell.db).await?,
            "files" => report::print_files(&shell.db).await?,
            "folders" => report::print_folders(&shell.db).await?,
            "conflicts" => report::print_conflicts(&shell.db).await?,
            "devices" => devices(&shell).await?,
            "test" | "diag" => test(&shell).await?,
            "quit" | "stop" | "exit" => {
                println!("stopping node…");
                return Ok(());
            }
            other => println!("unknown command `{other}` — type `help` for the list."),
        }
        println!();
    }
}

fn print_help() {
    println!();
    println!("Commands");
    println!("  help        show this list");
    println!("  status      node identity, config, uptime, connections (relay / direct / local)");
    println!("  storage     object / file / folder totals stored on this node");
    println!("  files       list stored files (names are ciphertext, by design)");
    println!("  folders     list stored folders");
    println!("  conflicts   list preserved conflicted copies awaiting resolution");
    println!("  devices     paired clients and last authentication");
    println!("  test        live connectivity checks (relay HTTP + WS, local HTTP, storage)");
    println!("  quit        stop the node (Ctrl+C or EOF also work)");
}

async fn status(shell: &Shell) -> anyhow::Result<()> {
    let snap = shell.telemetry.snapshot();
    println!();
    println!("Status");
    println!("  Node id:      {}", shell.identity.node_id);
    println!("  Data dir:     {}", shell.cfg.data_dir.display());
    println!("  Config dir:   {}", shell.cfg.nodus_dir.display());
    println!(
        "  Relay:        {}",
        shell.cfg.relay_url.as_deref().unwrap_or("(not configured)")
    );
    println!("  Uptime:       {}", human_duration(snap.uptime));
    println!();
    print!("{}", render_connections(&snap));
    if let Some(err) = &snap.last_error {
        println!("  Last error:   {err}");
    }
    Ok(())
}

/// Renders the three connection lines: Relay WS, client direct over the
/// internet (WebRTC), and the local LAN listener. Extracted so the formatting
/// is unit-testable without a live Telemetry.
fn render_connections(snap: &Snapshot) -> String {
    let mut out = String::from("Connections\n");
    match snap.link {
        RelayLink::Up => out.push_str(&format!(
            "  Relay WS:            connected · {} session(s) · last up {}\n",
            snap.sessions,
            snap.last_up_rfc3339.as_deref().unwrap_or("—")
        )),
        RelayLink::Connecting => out.push_str("  Relay WS:            connecting…\n"),
        RelayLink::Down => out.push_str("  Relay WS:            disconnected\n"),
    }
    if snap.direct_sessions > 0 {
        out.push_str(&format!(
            "  Direct (internet):   {} active · {} session(s) · last {}\n",
            snap.direct_active,
            snap.direct_sessions,
            snap.last_direct_rfc3339
                .as_deref()
                .map(time_ago)
                .unwrap_or_else(|| "—".to_string())
        ));
    } else {
        out.push_str("  Direct (internet):   none yet (WebRTC)\n");
    }
    if snap.local_listening {
        let auth = snap
            .local_last_auth_rfc3339
            .as_deref()
            .map(|t| format!("{} ago", time_ago(t)))
            .unwrap_or_else(|| "never".to_string());
        out.push_str(&format!(
            "  Local:               listening on :{LOCAL_PORT} · auth {auth}\n"
        ));
    } else {
        out.push_str("  Local:               not listening\n");
    }
    out
}

async fn devices(shell: &Shell) -> anyhow::Result<()> {
    let rows = sqlx::query_as::<_, (String, String, Option<String>)>(
        "SELECT device_id, status, last_authenticated_at FROM devices ORDER BY device_id",
    )
    .fetch_all(&shell.db)
    .await
    .context("reading paired devices")?;

    println!();
    if rows.is_empty() {
        println!("No paired devices on this node yet.");
        return Ok(());
    }
    println!("Paired devices ({})", rows.len());
    println!("  {:<18} {:<8} LAST AUTH", "DEVICE ID", "STATUS");
    for (id, status, last) in &rows {
        let last = last
            .as_deref()
            .map(time_ago)
            .unwrap_or_else(|| "never".to_string());
        println!("  {:<18} {:<8} {}", short_id(id, 18), status, last);
    }
    println!();
    println!("A device authenticates over the local network via the challenge handshake;");
    println!("last auth is when that happened, not a live heartbeat.");
    Ok(())
}

/// Live diagnostics: each check runs now and prints ok/FAIL with evidence.
async fn test(shell: &Shell) -> anyhow::Result<()> {
    println!();
    println!("Diagnostics");

    match relay_http_check(shell).await {
        Ok(detail) => println!("  Relay HTTP    ok      {detail}"),
        Err(e) => println!("  Relay HTTP    FAIL    {e}"),
    }

    let snap = shell.telemetry.snapshot();
    match snap.link {
        RelayLink::Up => println!(
            "  Relay WS      ok      connected · {} session(s) · last up {}",
            snap.sessions,
            snap.last_up_rfc3339.as_deref().unwrap_or("—")
        ),
        RelayLink::Connecting => println!("  Relay WS      n/a     connecting…"),
        RelayLink::Down => {
            let why = snap.last_error.as_deref().unwrap_or("no session yet");
            println!("  Relay WS      FAIL    disconnected: {why}");
        }
    }

    match local_http_check().await {
        Ok(node_id) => {
            let match_ = if node_id == shell.identity.node_id {
                "ok"
            } else {
                "MISMATCH"
            };
            println!("  Local HTTP    {match_:6} :{LOCAL_PORT} reachable");
        }
        Err(e) => println!("  Local HTTP    FAIL    :{LOCAL_PORT} unreachable: {e}"),
    }

    if snap.direct_sessions > 0 {
        println!(
            "  Direct        ok      {} active client session(s) · cumulative {} · last {}",
            snap.direct_active,
            snap.direct_sessions,
            snap.last_direct_rfc3339
                .as_deref()
                .map(time_ago)
                .unwrap_or_else(|| "—".to_string())
        );
    } else {
        println!("  Direct        n/a     no client WebRTC sessions yet");
    }

    match report::summary(&shell.db).await {
        Ok(s) => println!(
            "  Storage       ok      {} files · {} folders · {} shards · {} stored",
            s.file_count,
            s.folder_count,
            s.shard_count,
            report::format_bytes(s.stored_bytes)
        ),
        Err(e) => println!("  Storage       FAIL    {e}"),
    }
    Ok(())
}

/// `GET /health` on the Relay's derived HTTP base with a short timeout.
async fn relay_http_check(shell: &Shell) -> Result<String, String> {
    let base = relay_http_base(&shell.relay_ws_url);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|e| format!("client build failed: {e}"))?;
    let resp = client
        .get(format!("{base}/health"))
        .send()
        .await
        .map_err(|e| format!("unreachable: {e}"))?;
    let status = resp.status();
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("bad response: {e}"))?;
    if !status.is_success() {
        return Err(format!("HTTP {status}: {body}"));
    }
    let detail = body
        .get("services")
        .map(|v| serde_json::to_string(v).unwrap_or_default())
        .unwrap_or_else(|| body.to_string());
    Ok(detail)
}

/// `GET /nodus/discovery` on ourselves; the returned node id proves the local
/// listener is serving this node's identity.
async fn local_http_check() -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|e| format!("client build failed: {e}"))?;
    let url = format!("http://127.0.0.1:{LOCAL_PORT}/nodus/discovery");
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("unreachable: {e}"))?;
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("bad response: {e}"))?;
    body.get("node_id")
        .and_then(|v| v.as_str())
        .map(ToOwned::to_owned)
        .ok_or_else(|| "response missing node_id".to_string())
}

fn human_duration(d: Duration) -> String {
    let secs = d.as_secs();
    let (days, hours, mins, secs) = (
        secs / 86_400,
        (secs % 86_400) / 3_600,
        (secs % 3_600) / 60,
        secs % 60,
    );
    if days > 0 {
        format!("{days}d {hours}h {mins}m")
    } else if hours > 0 {
        format!("{hours}h {mins}m {secs}s")
    } else if mins > 0 {
        format!("{mins}m {secs}s")
    } else {
        format!("{secs}s")
    }
}

/// Compact "N units ago" for an RFC 3339 timestamp.
fn time_ago(iso: &str) -> String {
    let Ok(parsed) = DateTime::parse_from_rfc3339(iso) else {
        return "—".to_string();
    };
    let seconds = (Utc::now() - parsed.with_timezone(&Utc))
        .num_seconds()
        .max(0);
    if seconds < 60 {
        format!("{seconds}s ago")
    } else if seconds < 3_600 {
        format!("{}m ago", seconds / 60)
    } else if seconds < 86_400 {
        format!("{}h ago", seconds / 3_600)
    } else {
        format!("{}d ago", seconds / 86_400)
    }
}

fn short_id(id: &str, len: usize) -> String {
    if id.len() <= len {
        id.to_string()
    } else {
        format!("{}…", &id[..len])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn human_duration_formats_units() {
        assert_eq!(human_duration(Duration::from_secs(5)), "5s");
        assert_eq!(human_duration(Duration::from_secs(125)), "2m 5s");
        assert_eq!(human_duration(Duration::from_secs(7_300)), "2h 1m 40s");
        assert_eq!(human_duration(Duration::from_secs(200_000)), "2d 7h 33m");
    }

    #[test]
    fn time_ago_handles_recent_and_invalid() {
        let now = Utc::now().to_rfc3339();
        assert_eq!(time_ago(&now), "0s ago");
        assert_eq!(time_ago("not-a-date"), "—");
    }

    #[test]
    fn render_connections_covers_all_states() {
        let snap = Snapshot {
            link: RelayLink::Up,
            last_error: None,
            sessions: 1,
            last_up_rfc3339: Some("2026-09-12T00:00:00Z".to_string()),
            uptime: Duration::from_secs(5),
            direct_active: 2,
            direct_sessions: 3,
            last_direct_rfc3339: Some("2026-09-12T00:01:00Z".to_string()),
            local_listening: true,
            local_last_auth_rfc3339: None,
        };
        let out = render_connections(&snap);
        assert!(out.contains("Relay WS:            connected · 1 session(s)"));
        assert!(out.contains("Direct (internet):   2 active · 3 session(s)"));
        assert!(out.contains(&format!("listening on :{}", LOCAL_PORT)));

        let snap = Snapshot {
            link: RelayLink::Down,
            last_error: None,
            sessions: 0,
            last_up_rfc3339: None,
            uptime: Duration::from_secs(5),
            direct_active: 0,
            direct_sessions: 0,
            last_direct_rfc3339: None,
            local_listening: false,
            local_last_auth_rfc3339: None,
        };
        let out = render_connections(&snap);
        assert!(out.contains("Relay WS:            disconnected"));
        assert!(out.contains("Direct (internet):   none yet (WebRTC)"));
        assert!(out.contains("Local:               not listening"));
    }
}
