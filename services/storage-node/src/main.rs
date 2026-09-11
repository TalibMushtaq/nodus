mod config;
mod db;
mod identity;
mod local;
mod pair;
mod store;
pub mod sync;
mod transfer;
mod webrtc;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use clap::{Parser, Subcommand};
use url::Url;

/// Nodus Storage Node — local durable storage for the Nodus sync system.
#[derive(Parser)]
#[command(version, about)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,

    /// Directory for node data (objects + database). Overrides NODUS_DATA_DIR.
    #[arg(long, global = true, value_name = "PATH")]
    data_dir: Option<PathBuf>,
    /// Adopt an existing data directory without prompting, even if it already
    /// contains node data from a previous install. Has no effect once
    /// `~/.nodus/config.toml` exists (the node is already configured).
    #[arg(long, global = true)]
    force_adopt: bool,
    /// Relay endpoint. Public base origin (`https://nodus.example.com`) or an
    /// explicit legacy ws/wss URL. Precedence: this flag > config.toml
    /// `relay_url` > `NODUS_RELAY_URL` > none (first-run never defaults to
    /// localhost).
    #[arg(long, global = true, value_name = "URL")]
    relay: Option<String>,
}

#[derive(Subcommand)]
enum Command {
    /// Storage node lifecycle commands.
    Node {
        #[command(subcommand)]
        action: NodeAction,
    },
}

#[derive(Subcommand)]
enum NodeAction {
    /// Boot the storage node daemon (same behavior as a bare `nodus`).
    Start,
    /// Pair this node with an account using a one-time pairing code.
    Pair {
        /// Pairing code (`NODUS-XXXX-XXXX`); omit to be prompted (S5).
        #[arg(long, value_name = "CODE")]
        code: Option<String>,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    // Bare invocation and `node start` both boot the daemon, so existing
    // flag-only invocations (`nodus --data-dir … --force-adopt`) keep working.
    match &cli.command {
        None
        | Some(Command::Node {
            action: NodeAction::Start,
        }) => run_daemon(&cli).await,
        Some(Command::Node {
            action: NodeAction::Pair { code },
        }) => run_pair(&cli, code.clone()).await,
    }
}

/// Resolve data-dir + relay config, printing an actionable message on failure.
fn resolve_config(cli: &Cli) -> anyhow::Result<config::Config> {
    let interactive = std::io::IsTerminal::is_terminal(&std::io::stdin());
    config::load_or_setup(
        cli.data_dir.clone(),
        cli.relay.clone(),
        interactive,
        cli.force_adopt,
    )
    .map_err(|e| {
        eprintln!("configuration error: {e}");
        eprintln!(
            "provide a data directory via --data-dir or NODUS_DATA_DIR, or run interactively"
        );
        anyhow::anyhow!(e.to_string())
    })
}

async fn run_daemon(cli: &Cli) -> anyhow::Result<()> {
    let cfg = resolve_config(cli)?;
    boot_daemon(cfg).await
}

/// Pair this node and, on success, continue into the normal daemon so the WS
/// challenge-response flow starts immediately (§7c). On failure, print the
/// machine-readable reason plus recovery guidance and exit non-zero.
async fn run_pair(cli: &Cli, code: Option<String>) -> anyhow::Result<()> {
    let interactive = std::io::IsTerminal::is_terminal(&std::io::stdin());
    let mut cfg = resolve_config(cli)?;

    // Bound the redeem so a black-holed relay fails in seconds, not forever.
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .context("building HTTP client for pairing")?;
    let mut prompt = pair::DialoguerPrompt;

    match pair::run(
        &cfg,
        cli.relay.clone(),
        code,
        interactive,
        &mut prompt,
        &http,
    )
    .await
    {
        Ok(outcome) => {
            println!("node id:    {}", outcome.node_id);
            println!("account id: {}", outcome.account_id);
            if outcome.is_primary {
                println!("role:       primary node");
            }
            // Boot against the freshly-paired relay now persisted in config.toml.
            cfg.relay_url = Some(outcome.relay_base);
            boot_daemon(cfg).await
        }
        Err(e) => {
            eprintln!("pairing failed: {e}");
            eprintln!("{}", e.guidance());
            std::process::exit(1);
        }
    }
}

async fn boot_daemon(cfg: config::Config) -> anyhow::Result<()> {
    println!("node data dir: {}", cfg.data_dir.display());
    println!("config dir:    {}", cfg.nodus_dir.display());

    // Phase 7b: the daemon only communicates over WSS through the public
    // origin, so a missing relay is a hard failure. Never fall back to
    // localhost — that would silently pair/boot a node against the wrong host.
    let relay_url = resolve_daemon_relay(cfg.relay_url.as_deref())?;

    // Phase 5: Node identity
    let node_id_info =
        identity::load_or_generate(&cfg.nodus_dir).context("initialising node identity")?;
    println!("node id:       {}", node_id_info.node_id);

    // Phase 5: Database init + migrations
    let db = db::open(&cfg.data_dir)
        .await
        .context("initialising database")?;
    println!("database:      ready");

    // Phase 6: Object store init
    let object_store = store::ObjectStore::new(cfg.data_dir.clone(), db.clone())
        .await
        .context("initialising object store")?;
    println!("object store:  ready");

    // Phase 6: Crash recovery on startup
    object_store
        .recover_temp_writes()
        .await
        .context("recovering temp writes")?;
    println!("object store:  temp recovery done");

    let store_arc = Arc::new(object_store);

    // Phase 5 Node identity is Arc'd once here and shared by the sync loop
    // (Phase 8), local discovery (Phase 11), and the Transfer Manager (13).
    let sync_identity_arc = Arc::new(node_id_info);

    // Phase 13: Transfer Manager — wires the §21a re-fetch-from-peer repair
    // action through the same fallback/backoff/path-cache machinery as any
    // other transfer.
    let transfer_manager = transfer::manager::TransferManager::new(
        transfer::config::TransferConfig::default(),
        transfer::cache::SqlitePathCache::new(db.clone()),
        Arc::new(transfer::node_attempter::NodePathAttempter::new(
            db.clone(),
            store_arc.clone(),
            Arc::clone(&sync_identity_arc),
        )),
    );

    // Phase 6: Reconciliation background task (runs at boot then every 24h);
    // repairs DEGRADED objects through the Transfer Manager.
    let _reconcile_handle = store::spawn_reconcile_task(
        store_arc.clone(),
        Duration::from_secs(24 * 3600),
        Some(transfer_manager),
    );

    // Phase 6: Garbage collection background task (runs every 6h)
    let _gc_handle = store::spawn_gc_task(
        store_arc.clone(),
        store::GcConfig::default(),
        Duration::from_secs(6 * 3600),
    );

    // Phase 8: Start WebSocket sync loop
    let sync_db = db.clone();

    // The sync loop owns its own copy of the relay URL; the original is kept
    // for the local-discovery verify-fallback derivation below.
    let sync_relay_url = relay_url.clone();
    let sync_identity_for_loop = Arc::clone(&sync_identity_arc);
    let sync_store = store_arc.clone();
    let _sync_handle = tokio::spawn(async move {
        // A relay that is down at boot or stays down spams one error line per
        // 5s retry; log the failure once per state transition and go quiet
        // until the relay recovers, so a node can run happily offline.
        let mut relay_down_logged = false;
        loop {
            let client = sync::client::SyncClient::new(
                sync_relay_url.clone(),
                sync_identity_for_loop.clone(),
                sync_db.clone(),
                sync_store.clone(), // Phase 10: buffer-fetch flow writes shards
                500,                // batch size
            );
            match client.run_sync_session().await {
                Ok(_) => {
                    relay_down_logged = false;
                    println!("sync: session ended gracefully");
                }
                Err(e) => {
                    if !relay_down_logged {
                        if sync::client::is_node_not_paired(&e) {
                            // Unpaired node: point the operator at the fix
                            // instead of reporting a phantom relay outage.
                            eprintln!("{}", pair::NOT_PAIRED_GUIDANCE);
                        } else if sync::client::is_node_not_active(&e) {
                            // Registered but disabled/revoked: pairing again is
                            // the wrong advice.
                            eprintln!(
                                "sync: this node is registered but not active; \
                                 re-enable it in the web UI, or re-pair if it was revoked"
                            );
                        } else {
                            eprintln!("sync: relay unreachable: {e}");
                        }
                        relay_down_logged = true;
                    }
                }
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });

    // Phase 11: Local discovery mDNS advertisement + HTTP listener for
    // pairing and challenge-response auth. Shares the node identity; the
    // relay URL is passed along only to derive the pairing-verify fallback.
    // mDNS binds multicast sockets on startup; a best-effort failure should
    // not brick an otherwise-healthy node, so log and continue without local
    // discovery rather than aborting the process.
    let _local_services = match local::spawn_local(
        Arc::clone(&sync_identity_arc),
        db.clone(),
        store_arc.clone(),
        Some(&relay_url),
        local::server::LOCAL_PORT,
    )
    .await
    {
        Ok(services) => Some(services),
        Err(e) => {
            eprintln!("warning: local discovery disabled: {e}");
            None
        }
    };

    println!("storage node running. Press Ctrl+C to stop.");
    tokio::signal::ctrl_c()
        .await
        .context("waiting for termination signal")?;
    println!("storage node shutting down.");

    Ok(())
}

/// Resolve the daemon's WebSocket relay endpoint from the configured value.
///
/// Extracted from `run_daemon` so the "fail loudly, never localhost" rule is
/// unit-testable without booting the node. A missing relay is a hard error
/// (first-run must never silently target 127.0.0.1), and a value that does not
/// normalize to a `ws(s)://` URL is rejected up front so an operator typo
/// surfaces at boot instead of spinning in the reconnect loop forever.
fn resolve_daemon_relay(configured: Option<&str>) -> anyhow::Result<String> {
    let Some(raw) = configured else {
        anyhow::bail!(
            "no relay configured; run `nodus node pair` or set \
             NODUS_RELAY_URL / --relay (refusing to default to localhost)"
        );
    };
    let ws_url = sync::client::relay_ws_url(raw);
    match Url::parse(&ws_url) {
        Ok(url) if matches!(url.scheme(), "ws" | "wss") => Ok(ws_url),
        _ => anyhow::bail!(
            "invalid relay URL {raw:?}: expected an https:// public origin \
             or an explicit ws(s):// endpoint"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_daemon_relay_rejects_missing() {
        // Empty config must fail loudly rather than defaulting to localhost.
        let err = resolve_daemon_relay(None).unwrap_err().to_string();
        assert!(err.contains("no relay configured"), "unexpected: {err}");
    }

    #[test]
    fn resolve_daemon_relay_normalizes_public_origin() {
        assert_eq!(
            resolve_daemon_relay(Some("https://nodus.example.com")).unwrap(),
            "wss://nodus.example.com/ws"
        );
        // Legacy explicit WS endpoints are accepted verbatim.
        assert_eq!(
            resolve_daemon_relay(Some("ws://127.0.0.1:8080/ws")).unwrap(),
            "ws://127.0.0.1:8080/ws"
        );
    }

    #[test]
    fn resolve_daemon_relay_rejects_malformed_and_bad_scheme() {
        assert!(resolve_daemon_relay(Some("not-a-url")).is_err());
        assert!(resolve_daemon_relay(Some("nodus.example.com")).is_err());
        assert!(resolve_daemon_relay(Some("ftp://nodus.example.com")).is_err());
    }

    #[test]
    fn bare_invocation_has_no_subcommand_and_boots_legacy() {
        let cli = Cli::try_parse_from(["nodus"]).unwrap();
        assert!(cli.command.is_none());
        assert!(cli.data_dir.is_none());
        assert!(!cli.force_adopt);
        assert!(cli.relay.is_none());
    }

    #[test]
    fn root_flags_still_parse_without_subcommand() {
        let cli = Cli::try_parse_from([
            "nodus",
            "--data-dir",
            "/tmp/data",
            "--force-adopt",
            "--relay",
            "https://nodus.example.com",
        ])
        .unwrap();
        assert!(cli.command.is_none());
        assert_eq!(cli.data_dir.unwrap(), PathBuf::from("/tmp/data"));
        assert!(cli.force_adopt);
        assert_eq!(cli.relay.as_deref(), Some("https://nodus.example.com"));
    }

    #[test]
    fn node_start_parses() {
        let cli = Cli::try_parse_from(["nodus", "node", "start"]).unwrap();
        assert!(matches!(
            cli.command,
            Some(Command::Node {
                action: NodeAction::Start
            })
        ));
    }

    #[test]
    fn global_flags_work_after_subcommand() {
        // `--data-dir`/`--relay` are global so they are accepted after the
        // subcommand, not only before it.
        let cli = Cli::try_parse_from([
            "nodus",
            "node",
            "start",
            "--data-dir",
            "/tmp/data",
            "--relay",
            "https://nodus.example.com",
        ])
        .unwrap();
        assert_eq!(cli.data_dir.unwrap(), PathBuf::from("/tmp/data"));
        assert_eq!(cli.relay.as_deref(), Some("https://nodus.example.com"));
    }

    #[test]
    fn node_pair_parses_code() {
        let cli =
            Cli::try_parse_from(["nodus", "node", "pair", "--code", "NODUS-ABCD-2345"]).unwrap();
        match cli.command {
            Some(Command::Node {
                action: NodeAction::Pair { code },
            }) => assert_eq!(code.as_deref(), Some("NODUS-ABCD-2345")),
            _ => panic!("expected node pair"),
        }
    }

    #[test]
    fn node_pair_without_code_parses_for_interactive_prompt() {
        let cli = Cli::try_parse_from(["nodus", "node", "pair"]).unwrap();
        assert!(matches!(
            cli.command,
            Some(Command::Node {
                action: NodeAction::Pair { code: None }
            })
        ));
    }
}
