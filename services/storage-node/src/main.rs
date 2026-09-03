mod config;
mod db;
mod identity;

use std::path::PathBuf;

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

    let cfg = config::load_or_setup(cli.data_dir, interactive, cli.force_adopt)
        .map_err(|e| {
            eprintln!("configuration error: {e}");
            eprintln!(
                "provide a data directory via --data-dir or NODUS_DATA_DIR, or run interactively"
            );
            anyhow::anyhow!(e.to_string())
        })?;

    println!("node data dir: {}", cfg.data_dir.display());
    println!("config dir:    {}", cfg.nodus_dir.display());

    // Phase 5: Node identity
    let node_id_info = identity::load_or_generate(&cfg.nodus_dir)
        .context("initialising node identity")?;
    println!("node id:       {}", node_id_info.node_id);

    // Phase 5: Database init + migrations
    let _db = db::open(&cfg.data_dir)
        .await
        .context("initialising database")?;
    println!("database:      ready");

    Ok(())
}
