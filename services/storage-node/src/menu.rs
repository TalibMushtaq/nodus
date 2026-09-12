//! Interactive command-line menu for the Storage Node.
//!
//! Reached only from a bare `nodus` invocation with an interactive stdin, so
//! piped/systemd runs keep the legacy non-interactive daemon behavior. On first
//! run (no relay recorded) it walks the pairing wizard — prompting for the relay
//! URL and pairing code — before showing the menu. Every reporting action reads
//! this node's local SQLite (see `report`), not the account-wide Relay catalogue.

use std::time::Duration;

use anyhow::Context;
use dialoguer::Select;
use dialoguer::theme::ColorfulTheme;

use crate::config::Config;
use crate::pair;
use crate::{Cli, boot_daemon, db, report, resolve_config};

const MENU_ITEMS: &[&str] = &[
    "Run the node",
    "Storage summary",
    "List files",
    "List folders",
    "Show status",
    "Pair / re-pair this node",
    "Quit",
];

pub async fn run_interactive(cli: &Cli) -> anyhow::Result<()> {
    println!();
    println!("Nodus Storage Node");
    println!("==================");

    let mut cfg = resolve_config(cli)?;

    // First run: no relay has been recorded yet (pairing persists it only after
    // the relay accepts the code). Run the wizard up front so a new operator
    // supplies the URL + code before anything else, matching "ask on first run".
    if cfg.relay_url.is_none() {
        println!();
        println!("First run: pair this node with your account.");
        pair_wizard(&mut cfg, cli).await?;
    }

    // Open the local DB once for the reporting actions. This also initializes
    // `nodus.db` if "Run the node" has not created it yet.
    let pool = db::open(&cfg.data_dir)
        .await
        .context("opening node database")?;

    loop {
        let selection = match Select::with_theme(&ColorfulTheme::default())
            .with_prompt("Choose an action")
            .items(MENU_ITEMS)
            .default(0)
            .interact_opt()
        {
            Ok(Some(choice)) => choice,
            // Esc or Ctrl+C at the prompt exits quietly rather than as an error.
            Ok(None) | Err(_) => {
                println!();
                return Ok(());
            }
        };

        match selection {
            0 => return boot_daemon(cfg).await,
            1 => report::print_summary(&pool).await?,
            2 => report::print_files(&pool).await?,
            3 => report::print_folders(&pool).await?,
            4 => print_status(&cfg),
            5 => {
                pair_wizard(&mut cfg, cli).await?;
            }
            _ => {
                println!();
                return Ok(());
            }
        }
    }
}

/// Pair (or re-pair) through the shared `pair::run` flow. Interactive, so the
/// relay URL is prompted (pre-filled with the configured value) and the code is
/// prompted when `--code` was not supplied. Returns whether pairing succeeded.
async fn pair_wizard(cfg: &mut Config, cli: &Cli) -> anyhow::Result<bool> {
    // Bound the redeem so a black-holed relay fails in seconds, matching
    // `nodus node pair`.
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .context("building HTTP client for pairing")?;
    let mut prompt = pair::DialoguerPrompt;

    match pair::run(cfg, cli.relay.clone(), None, true, &mut prompt, &http).await {
        Ok(outcome) => {
            println!();
            println!("Paired successfully.");
            println!("  node id:    {}", outcome.node_id);
            println!("  account id: {}", outcome.account_id);
            if outcome.is_primary {
                println!("  role:       primary node");
            }
            // Keep the in-memory config in step with the just-persisted relay so
            // "Run the node" boots against the address we actually paired to.
            cfg.relay_url = Some(outcome.relay_base);
            Ok(true)
        }
        Err(err) => {
            println!();
            println!("Pairing failed: {err}");
            // The generic guidance points at `nodus node pair`; inside the menu
            // that is the command the user is already in, so only show the
            // failure-specific advice (insecure relay / persist failure), and
            // otherwise rely on the "Pair / re-pair" menu item.
            let guidance = err.guidance();
            if guidance != pair::NOT_PAIRED_GUIDANCE {
                println!("{guidance}");
            }
            Ok(false)
        }
    }
}

fn print_status(cfg: &Config) {
    println!();
    println!("Status");
    println!("  Data dir:    {}", cfg.data_dir.display());
    println!("  Config dir:  {}", cfg.nodus_dir.display());
    println!(
        "  Relay:       {}",
        cfg.relay_url
            .as_deref()
            .unwrap_or("(not configured — pair this node)")
    );
    match crate::identity::existing_node_id(&cfg.nodus_dir) {
        Some(id) => println!("  Node id:     {id}"),
        None => println!("  Node id:     (not generated yet — run the node or pair)"),
    }
    println!();
}
