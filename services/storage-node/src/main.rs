mod config;

use std::path::PathBuf;

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

fn main() {
    let cli = Cli::parse();

    let interactive = std::io::IsTerminal::is_terminal(&std::io::stdin());
    match config::load_or_setup(cli.data_dir, interactive, cli.force_adopt) {
        Ok(cfg) => {
            println!("node data dir: {}", cfg.data_dir.display());
            println!("config dir:    {}", cfg.nodus_dir.display());
        }
        Err(e) => {
            eprintln!("configuration error: {e}");
            eprintln!("provide a data directory via --data-dir or NODUS_DATA_DIR, or run interactively");
            std::process::exit(1);
        }
    }
}

