mod config;
mod db;
mod identity;
mod store;
pub mod sync;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use clap::Parser;

/// Nodus Storage Node — local durable storage for the Nodus sync system.
#[derive(Parser)]
#[command(version, about)]
struct Cli {
    /// Directory for node data (objects + database). Overrides NODUS_DATA_DIR.
    #[arg(long, value_name = "PATH")]
    data_dir: Option<PathBuf>,
    /// Adopt an existing data directory without prompting, even if it already
    /// contains node data from a previous install. Has no effect once
    /// `~/.nodus/config.toml` exists (the node is already configured).
    #[arg(long)]
    force_adopt: bool,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let interactive = std::io::IsTerminal::is_terminal(&std::io::stdin());

    let cfg = config::load_or_setup(cli.data_dir, interactive, cli.force_adopt).map_err(|e| {
        eprintln!("configuration error: {e}");
        eprintln!(
            "provide a data directory via --data-dir or NODUS_DATA_DIR, or run interactively"
        );
        anyhow::anyhow!(e.to_string())
    })?;

    println!("node data dir: {}", cfg.data_dir.display());
    println!("config dir:    {}", cfg.nodus_dir.display());

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

    // Phase 6: Reconciliation background task (runs at boot then every 24h)
    let _reconcile_handle =
        store::spawn_reconcile_task(store_arc.clone(), Duration::from_secs(24 * 3600));

    // Phase 6: Garbage collection background task (runs every 6h)
    let _gc_handle = store::spawn_gc_task(
        store_arc.clone(),
        store::GcConfig::default(),
        Duration::from_secs(6 * 3600),
    );

    // Phase 8: Start WebSocket sync loop
    let sync_identity_arc = Arc::new(node_id_info);
    let sync_db = db.clone();
    let relay_url =
        std::env::var("NODUS_RELAY_URL").unwrap_or_else(|_| "ws://127.0.0.1:8080/ws".to_string());

    let _sync_handle = tokio::spawn(async move {
        loop {
            let client = sync::client::SyncClient::new(
                relay_url.clone(),
                sync_identity_arc.clone(),
                sync_db.clone(),
                store_arc.clone(), // Phase 10: buffer-fetch flow writes shards
                500,               // batch size
            );
            match client.run_sync_session().await {
                Ok(_) => {
                    println!("sync: session ended gracefully");
                }
                Err(e) => {
                    eprintln!("sync: session error: {}", e);
                }
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });

    println!("storage node running. Press Ctrl+C to stop.");
    tokio::signal::ctrl_c()
        .await
        .context("waiting for termination signal")?;
    println!("storage node shutting down.");

    Ok(())
}
