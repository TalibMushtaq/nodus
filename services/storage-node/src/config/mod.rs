mod prompt;
mod validation;

use std::fs;
use std::path::{Path, PathBuf};

use directories::BaseDirs;
use serde::{Deserialize, Serialize};

pub const CONFIG_FILE: &str = "config.toml";
/// Journal recording an in-flight data-directory move. Lives in `nodus_dir`
/// (not under either data dir) so it survives a crash regardless of where the
/// move stopped, letting boot detect and resolve a half-completed relocation
/// instead of silently creating an empty database at the stale path.
pub const MIGRATION_JOURNAL: &str = "migration.json";
/// Reserved fixed subdirectory (§11) holding the node keypair; the single
/// reference for the reserved name so identity code and config code agree.
pub const IDENTITY_DIR: &str = "identity";

/// Returns the host when `raw` is a plaintext transport (`http`/`ws`) to a
/// non-loopback host. Loopback is exempt so a local dev relay keeps working.
///
/// Shared by bootstrap pairing (the pairing code is a credential) and the
/// daemon link (challenge signatures, metadata, and fetch tokens must not
/// cross the wire in cleartext). Returning `Option` rather than a typed error
/// keeps each caller free to map it to its own error type. Unparseable values
/// yield `None` and are left to fail on connection instead of being
/// mislabelled as insecure.
pub fn insecure_plaintext_host(raw: &str) -> Option<String> {
    let url = url::Url::parse(raw).ok()?;
    let loopback = match url.host() {
        Some(url::Host::Domain("localhost")) => true,
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        _ => false,
    };

    let plaintext = matches!(url.scheme(), "http" | "ws");
    if plaintext && !loopback {
        Some(url.host_str().unwrap_or(raw).to_string())
    } else {
        None
    }
}

/// Bootstrap config file contents. `relay_url` is optional so existing
/// `config.toml` files without the key keep parsing; it is written only after
/// successful pairing (§11a), not during first-run data-dir setup.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodusConfigFile {
    pub data_dir: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay_url: Option<String>,
}

/// Resolved runtime configuration for the node.
#[derive(Debug, Clone)]
pub struct Config {
    /// User-chosen location for `nodus.db` and `objects/`.
    pub data_dir: PathBuf,
    /// Fixed OS-standard config dir (`~/.nodus`) holding identity + config.
    pub nodus_dir: PathBuf,
    /// Relay endpoint resolved for this run via CLI `--relay` >
    /// `config.toml relay_url` > `NODUS_RELAY_URL` > none. This is the public
    /// base origin (or a legacy explicit ws/wss URL); callers normalize it to
    /// a WS URL with `sync::client::relay_ws_url` before dialing.
    pub relay_url: Option<String>,
}

impl Config {
    fn from_path(nodus_dir: PathBuf, data_dir: PathBuf, relay_url: Option<String>) -> Self {
        Config {
            data_dir,
            nodus_dir,
            relay_url,
        }
    }
}

/// Errors surfaced while resolving the node configuration on boot.
#[derive(Debug)]
pub enum ConfigError {
    /// No config file, and none of the unattended sources supplied a path.
    NoDataDir,
    /// The config file exists but could not be parsed.
    Parse(String),
    /// The config file is present but its `data_dir` is empty.
    MissingField(&'static str),
    Io(std::io::Error),
    /// The data directory already holds node data from a prior install.
    /// Pass `--force-adopt` to adopt it without prompting.
    PriorInstall(PathBuf),
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConfigError::NoDataDir => {
                write!(f, "no data directory configured and none provided")
            }
            ConfigError::Parse(s) => write!(f, "failed to parse config file: {s}"),
            ConfigError::MissingField(k) => write!(f, "config file missing field: {k}"),
            ConfigError::Io(e) => write!(f, "io error: {e}"),
            ConfigError::PriorInstall(p) => write!(
                f,
                "{} already contains node data from a prior install; \
                 pass --force-adopt to adopt it as-is",
                p.display()
            ),
        }
    }
}

impl std::error::Error for ConfigError {}

impl From<std::io::Error> for ConfigError {
    fn from(e: std::io::Error) -> Self {
        ConfigError::Io(e)
    }
}

impl From<toml::de::Error> for ConfigError {
    fn from(e: toml::de::Error) -> Self {
        ConfigError::Parse(e.to_string())
    }
}

/// Expand a leading `~/` to the user's home directory.
///
/// `PathBuf::from("~/foo")` does **not** expand the tilde — that is a shell
/// feature. This matters for `NODUS_DATA_DIR` set in systemd unit files or
/// other non-shell contexts.
fn expand_tilde(path: PathBuf) -> PathBuf {
    let s = path.as_os_str().to_string_lossy();
    if let Some(rest) = s.strip_prefix("~/")
        && let Some(home) = BaseDirs::new().map(|b| b.home_dir().to_path_buf())
    {
        return home.join(rest);
    }
    path
}

/// Path of the fixed config directory `~/.nodus`, resolved via the
/// `directories` crate so it lands in the OS-standard config location on each
/// platform. If no home directory can be determined we fall back to `.nodus`
/// in the current working directory so the node can still start.
fn nodus_dir_os() -> PathBuf {
    BaseDirs::new()
        .map(|d| d.home_dir().join(".nodus"))
        .unwrap_or_else(|| PathBuf::from(".nodus"))
}

/// The default suggestion for the interactive prompt: `~/NodusBackup`.
pub fn default_data_dir_hint() -> PathBuf {
    BaseDirs::new()
        .map(|d| d.home_dir().join("NodusBackup"))
        .unwrap_or_else(|| PathBuf::from("NodusBackup"))
}

/// Resolve the node configuration, running first-run setup if needed.
///
/// Order of precedence, matching the confirmed design:
/// 1. existing `config.toml` (unattended restart path, never prompts);
/// 2. explicit `--data-dir` CLI flag or `NODUS_DATA_DIR` env var;
/// 3. interactive prompt (only when the process has an interactive stdin).
///
/// The relay URL is resolved independently via `resolve_relay_url` on every
/// path (see its docs for the locked precedence) and is never persisted here —
/// only `nodus node pair` writes it to `config.toml` after a successful redeem.
pub fn load_or_setup(
    cli_data_dir: Option<PathBuf>,
    cli_relay: Option<String>,
    interactive: bool,
    force_adopt: bool,
) -> Result<Config, ConfigError> {
    let nodus_dir = nodus_dir_os();
    let config_path = nodus_dir.join(CONFIG_FILE);

    // Resolve any move the previous run left half-finished *before* trusting
    // `config.toml`, so a crash can never strand the database and cause boot to
    // create an empty one at the stale path.
    recover_interrupted_migration(&nodus_dir, &config_path)?;

    // First-run detection: an existing config means a prior setup, so boot
    // from it without prompting — required so an unattended daemon restart
    // never blocks on input.
    if let Some(cfg) = read_config_file(&config_path)? {
        let relay_url = resolve_relay_url(cli_relay, cfg.relay_url, relay_from_env());
        return Ok(Config::from_path(nodus_dir, cfg.data_dir, relay_url));
    }

    // Unattended install: CLI flag takes precedence over env var; both are
    // tilde-expanded so `~/foo` works in service-unit definitions.
    let from_env = std::env::var("NODUS_DATA_DIR")
        .ok()
        .map(PathBuf::from)
        .map(expand_tilde);
    if let Some(raw_dir) = cli_data_dir.map(expand_tilde).or(from_env) {
        let data_dir = adopt_and_save(&nodus_dir, &config_path, raw_dir, force_adopt)?;
        emit_nonblocking_warnings(&data_dir);
        let relay_url = resolve_relay_url(cli_relay, None, relay_from_env());
        return Ok(Config::from_path(nodus_dir, data_dir, relay_url));
    }

    // Interactive first-run setup.
    if interactive {
        // interactive_data_dir() already confirms prior-install with the user,
        // so adopt_and_save is called with force_adopt=true to avoid a
        // redundant check on the already-confirmed path.
        let data_dir = prompt::interactive_data_dir(default_data_dir_hint())?;
        let data_dir = adopt_and_save(&nodus_dir, &config_path, data_dir, true)?;
        let relay_url = resolve_relay_url(cli_relay, None, relay_from_env());
        return Ok(Config::from_path(nodus_dir, data_dir, relay_url));
    }

    Err(ConfigError::NoDataDir)
}

/// Read `NODUS_RELAY_URL` as the last-resort relay source. Kept separate from
/// `resolve_relay_url` so the precedence function stays pure and testable.
fn relay_from_env() -> Option<String> {
    std::env::var("NODUS_RELAY_URL").ok()
}

/// Apply the locked relay-URL precedence: CLI `--relay` > `config.toml`
/// `relay_url` > `NODUS_RELAY_URL` > none. Blank/whitespace sources are treated
/// as absent so an empty env var cannot mask a lower-precedence value. Returns
/// `None` when nothing is configured — callers must fail loudly rather than
/// defaulting to localhost (first-run pairing must never dial 127.0.0.1).
pub fn resolve_relay_url(
    cli: Option<String>,
    file: Option<String>,
    env: Option<String>,
) -> Option<String> {
    [cli, file, env]
        .into_iter()
        .flatten()
        .map(|s| s.trim().to_string())
        .find(|s| !s.is_empty())
}

/// Persist `relay_url` into `config.toml`, preserving every existing key (in
/// particular `data_dir` and any field a future version adds). Called by
/// `nodus node pair` **only after a successful redemption** (§11a); an unpaired
/// node therefore never records a relay it has not proven.
///
/// Writes through a sibling temp file + rename so a crash mid-write cannot
/// truncate the config into an unparseable state. Deliberately edits a
/// `toml::Table` rather than re-serializing `NodusConfigFile`: a typed
/// round-trip would silently drop keys the struct does not yet model.
pub fn persist_relay_url(
    nodus_dir: &Path,
    data_dir: &Path,
    relay_url: &str,
) -> Result<(), ConfigError> {
    fs::create_dir_all(nodus_dir)?;
    let path = nodus_dir.join(CONFIG_FILE);

    // Start from the on-disk document when present so unknown keys survive;
    // fall back to a minimal document seeded with the caller's data_dir.
    let mut doc: toml::Table = match fs::read_to_string(&path) {
        Ok(text) => toml::from_str(&text)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => toml::Table::new(),
        Err(e) => return Err(e.into()),
    };
    if !doc.contains_key("data_dir") {
        doc.insert(
            "data_dir".to_string(),
            toml::Value::String(data_dir.display().to_string()),
        );
    }
    doc.insert(
        "relay_url".to_string(),
        toml::Value::String(relay_url.trim().to_string()),
    );

    let serialized = toml::to_string(&doc).map_err(|e| ConfigError::Parse(e.to_string()))?;
    let tmp = nodus_dir.join(format!("{CONFIG_FILE}.tmp"));
    fs::write(&tmp, serialized)?;
    fs::rename(&tmp, &path)?;
    Ok(())
}

/// Read the config file if it exists; returns `None` when the file is absent.
fn read_config_file(path: &Path) -> Result<Option<NodusConfigFile>, ConfigError> {
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(path)?;
    let mut cfg: NodusConfigFile = toml::from_str(&text)?;
    if cfg.data_dir.as_os_str().is_empty() {
        return Err(ConfigError::MissingField("data_dir"));
    }
    // Normalize a blank relay_url to `None` so it is not treated as configured.
    cfg.relay_url = cfg.relay_url.filter(|s| !s.trim().is_empty());
    Ok(Some(cfg))
}

/// Validate `data_dir`, persist `config.toml`, and return the validated path.
///
/// Checks (in order): non-empty → exists-or-create → writable → no prior install
/// (unless `force_adopt`).
fn adopt_and_save(
    nodus_dir: &Path,
    config_path: &Path,
    data_dir: PathBuf,
    force_adopt: bool,
) -> Result<PathBuf, ConfigError> {
    if data_dir.as_os_str().is_empty() {
        return Err(ConfigError::MissingField("data_dir"));
    }
    validation::ensure_dir(&data_dir)?;
    if !validation::is_writable(&data_dir) {
        return Err(ConfigError::Io(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!("{} is not writable", data_dir.display()),
        )));
    }
    if !force_adopt && validation::has_prior_install(&data_dir) {
        return Err(ConfigError::PriorInstall(data_dir));
    }
    fs::create_dir_all(nodus_dir)?;
    // `relay_url` is intentionally left unset on first-run setup; it is only
    // recorded by `nodus node pair` after a successful redeem (§11a).
    let cfg = NodusConfigFile {
        data_dir,
        relay_url: None,
    };
    let toml = toml::to_string(&cfg).map_err(|e| ConfigError::Parse(e.to_string()))?;
    // Durable write: a crash mid-first-run must not leave config.toml truncated
    // and unparseable, which would block every subsequent boot.
    write_file_durable(nodus_dir, config_path, toml.as_bytes())?;
    Ok(cfg.data_dir)
}

/// Emit non-blocking stderr warnings for cloud-sync and removable/network drives.
/// Called after unattended adoption so operators see concerns in service logs.
fn emit_nonblocking_warnings(data_dir: &Path) {
    if validation::is_inside_cloud_sync(data_dir) {
        eprintln!("[config] warning: data dir is inside a cloud-sync folder");
    }
    if validation::is_removable_or_network_root(data_dir) {
        eprintln!("[config] warning: data dir is on a removable/network drive");
    }
}

/// On-disk record of a data-directory relocation in progress. `from` is the
/// old location, `to` the new one; presence of this file at boot means the
/// previous `change_data_dir` did not finish.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct MigrationJournal {
    from: PathBuf,
    to: PathBuf,
}

fn migration_journal_path(nodus_dir: &Path) -> PathBuf {
    nodus_dir.join(MIGRATION_JOURNAL)
}

/// Write the journal (temp + rename + fsync) before touching either data dir.
/// Durability matters here: a journal that is itself lost to a crash provides
/// no protection for the move it was meant to guard.
fn write_migration_journal(nodus_dir: &Path, from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(nodus_dir)?;
    let journal = MigrationJournal {
        from: from.to_path_buf(),
        to: to.to_path_buf(),
    };
    let serialized = serde_json::to_string(&journal)
        .map_err(|e| std::io::Error::other(format!("serializing migration journal: {e}")))?;
    write_file_durable(
        nodus_dir,
        &migration_journal_path(nodus_dir),
        serialized.as_bytes(),
    )
}

fn read_migration_journal(nodus_dir: &Path) -> std::io::Result<Option<MigrationJournal>> {
    let path = migration_journal_path(nodus_dir);
    match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text)
            .map(Some)
            .map_err(|e| std::io::Error::other(format!("parsing {}: {e}", path.display()))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

fn clear_migration_journal(nodus_dir: &Path) -> std::io::Result<()> {
    match fs::remove_file(migration_journal_path(nodus_dir)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// Write `bytes` to `path` via a sibling temp file + rename, then fsync the
/// directory entry. Shared by the migration journal and config rewrites so a
/// crash cannot truncate either into an unreadable state.
fn write_file_durable(dir: &Path, path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let tmp = path.with_extension("tmp");
    {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    #[cfg(unix)]
    {
        fs::File::open(dir)?.sync_all()?;
    }
    Ok(())
}

/// Compare two configured paths leniently: canonicalize when both exist so
/// `…/data` and `…/data/.` compare equal, otherwise fall back to spelling.
fn paths_match(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
    }
}

/// Resolve a move that did not finish, before the config is read for boot.
///
/// The catastrophic failure this guards against: a previous move left the
/// database at the new path while `config.toml` still named the old one; boot
/// would then `create_if_missing` an empty DB and reconcile could later treat
/// the real objects as orphans and delete them. Recovery prefers whichever
/// location actually holds `nodus.db` and repoints the config there, so a
/// crash can never turn a healthy backup into an empty one.
fn recover_interrupted_migration(nodus_dir: &Path, config_path: &Path) -> Result<(), ConfigError> {
    let Some(journal) = read_migration_journal(nodus_dir)? else {
        return Ok(());
    };
    let from_db = journal.from.join("nodus.db").exists();
    let to_db = journal.to.join("nodus.db").exists();
    let configured = read_config_file(config_path)?.map(|c| c.data_dir);
    // Preserve the relay pairing if we have to rewrite config.toml.
    let relay = read_config_file(config_path)?.and_then(|c| c.relay_url);

    if !from_db && to_db {
        // Move completed (same-FS rename, or EXDEV copy) but the config flip
        // did not. Point the config at the data that actually exists.
        eprintln!(
            "[config] recovering interrupted data move: using {} (database found there)",
            journal.to.display()
        );
        write_config(nodus_dir, config_path, journal.to.clone(), relay)?;
        clear_migration_journal(nodus_dir)?;
        if journal.from.exists() {
            let _ = fs::remove_dir_all(&journal.from);
        }
        return Ok(());
    }

    // Source still holds the database: the move did not complete. Keep it.
    // If the config somehow points at the (DB-less) target, correct it.
    if from_db {
        if configured
            .as_deref()
            .is_some_and(|p| paths_match(p, &journal.to))
        {
            write_config(nodus_dir, config_path, journal.from.clone(), relay)?;
        }
        clear_migration_journal(nodus_dir)?;
        return Ok(());
    }

    // Both contain a DB (or neither): nothing safe to auto-choose. If only the
    // target has data, prefer it; otherwise drop the journal and let the normal
    // config path decide.
    if to_db {
        write_config(nodus_dir, config_path, journal.to.clone(), relay)?;
    }
    clear_migration_journal(nodus_dir)?;
    Ok(())
}

/// Interactively choose a new data directory and persist it to `config.toml`,
/// preserving every existing key (notably `relay_url`). This is how an operator
/// changes the backup location from the menu ("Change data location") instead
/// of hand-editing the file. The prompt reuses the first-run flow, so it
/// creates missing directories, confirms adopting a prior-install directory,
/// and warns about cloud-sync/removable drives before anything is written.
pub fn change_data_dir(current: &Path) -> std::io::Result<PathBuf> {
    let nodus_dir = nodus_dir_os();
    let config_path = nodus_dir.join(CONFIG_FILE);

    // Keep the relay pairing intact: first-run setup writes `relay_url: None`
    // (only `nodus node pair` persists it), so re-reading the file here — not
    // `adopt_and_save`, which would drop the value — is what preserves the
    // existing relay when we rewrite `data_dir`.
    let existing_relay = match read_config_file(&config_path) {
        Ok(Some(cfg)) => cfg.relay_url,
        Ok(None) => None,
        Err(e) => {
            return Err(std::io::Error::other(format!(
                "could not read {}: {e}",
                config_path.display()
            )));
        }
    };

    let chosen = prompt::interactive_data_dir(current.to_path_buf())?;

    // Resolving both sides lets "…/data" and "/…/data/." compare equal; the
    // chosen path itself is still stored exactly as typed in config.toml.
    let same = match (fs::canonicalize(current), fs::canonicalize(&chosen)) {
        (Ok(a), Ok(b)) => a == b,
        _ => current == chosen,
    };
    if same {
        println!("Data location is already {}", chosen.display());
        return Ok(chosen);
    }

    // A *move* must never merge into a directory that already holds node data:
    // adopting (the prompt's first-run behaviour) would mix two backups. Refuse
    // so the operator picks an empty target.
    ensure_migratable_target(&chosen)?;

    // Journal + config-before-source-delete makes the move recoverable: the
    // old location is only removed once `config.toml` durably names the new one.
    let bytes = relocate_data_dir(current, &chosen, &nodus_dir, &config_path, existing_relay)?;
    if bytes > 0 {
        println!(
            "Moved {bytes} bytes of existing data to {}",
            chosen.display()
        );
    }
    Ok(chosen)
}

/// Move all node data from `from` to `to`, then record `to` as the new location
/// and only then remove `from`. The ordering is the safety property: if the
/// process dies between the data move and the config write, the boot-time
/// journal recovery (see [`recover_interrupted_migration`]) repoints the config
/// at whichever path holds the database.
///
/// On one filesystem the whole directory is renamed atomically. Across
/// filesystems (`rename` returns `EXDEV`) the tree is copied with `nodus.db`
/// last, and the source is kept until the config is durable. An existing
/// non-empty target is merged into rather than clobbered.
fn relocate_data_dir(
    from: &Path,
    to: &Path,
    nodus_dir: &Path,
    config_path: &Path,
    relay_url: Option<String>,
) -> std::io::Result<u64> {
    if !from.exists() {
        fs::create_dir_all(to)?;
        write_config(nodus_dir, config_path, to.to_path_buf(), relay_url)?;
        return Ok(0);
    }

    write_migration_journal(nodus_dir, from, to)?;

    let bytes = if dir_absent_or_empty(to)? {
        // Same-FS rename is atomic: no half-moved tree can exist, so the only
        // recoverable gap is the config pointer (handled at boot).
        match fs::rename(from, to) {
            Ok(()) => entry_bytes(to)?,
            Err(e) if e.kind() == std::io::ErrorKind::CrossesDevices => {
                copy_data_tree_db_last(from, to)?
            }
            Err(e) => {
                // A failed rename that is not a cross-device move leaves the
                // source untouched; drop the journal so the next boot is normal.
                clear_migration_journal(nodus_dir)?;
                return Err(e);
            }
        }
    } else {
        // Target held unrelated files: merge-copy without clobbering them.
        copy_data_tree_db_last(from, to)?
    };

    write_config(nodus_dir, config_path, to.to_path_buf(), relay_url)?;
    clear_migration_journal(nodus_dir)?;
    // Best-effort cleanup only after the config is durable; a failure here
    // leaves a harmless duplicate rather than an unreachable database.
    if from.exists() {
        let _ = fs::remove_dir_all(from);
    }
    Ok(bytes)
}

/// True when `path` does not exist, or is an empty directory. Used to decide
/// whether the whole-directory atomic rename can replace it.
fn dir_absent_or_empty(path: &Path) -> std::io::Result<bool> {
    if !path.exists() {
        return Ok(true);
    }
    if !path.is_dir() {
        return Ok(false);
    }
    Ok(fs::read_dir(path)?.next().is_none())
}

/// Copy `src`'s contents into `dst`, copying `nodus.db` (and its WAL/SHM
/// sidecars) last. A crash mid-copy therefore never leaves a complete-looking
/// database in the target before the object store has been copied.
fn copy_data_tree_db_last(src: &Path, dst: &Path) -> std::io::Result<u64> {
    fs::create_dir_all(dst)?;
    let mut bytes = 0u64;
    let mut db_entries = Vec::new();

    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        if name.to_string_lossy().starts_with("nodus.db") {
            db_entries.push(name);
            continue;
        }
        let path = entry.path();
        let kind = entry.file_type()?;
        if kind.is_dir() {
            bytes += copy_dir_all(&path, &dst.join(&name))?;
        } else if kind.is_file() {
            bytes += fs::copy(&path, dst.join(&name))?;
        }
    }

    for name in db_entries {
        bytes += fs::copy(src.join(&name), dst.join(&name))?;
    }
    Ok(bytes)
}

/// Move the contents of `old` (the node database, `objects/`, and `temp/`) into
/// `new`, then remove the emptied `old` directory so the operator does not end
/// up with twin backups. Retained as a direct, journal-free helper for tests;
/// `change_data_dir` now uses [`relocate_data_dir`], which adds the journal and
/// writes the config before removing the source.
///
/// `new` must already exist (the prompt creates/validates it); it is created as
/// a belt-and-braces fallback so the helper stays callable in tests.
#[cfg(test)]
pub fn migrate_data_dir(old: &Path, new: &Path) -> std::io::Result<u64> {
    if !old.exists() {
        return Ok(0);
    }
    fs::create_dir_all(new)?;
    let mut bytes = 0u64;
    for entry in fs::read_dir(old)? {
        let entry = entry?;
        bytes += move_entry(&entry.path(), &new.join(entry.file_name()))?;
    }
    // Best-effort: if an entry failed to move, `remove_dir` leaves `old` in
    // place and the error above already aborted the config write, so the node
    // still boots from the old location next time.
    let _ = fs::remove_dir(old);
    Ok(bytes)
}

/// Move one file or directory tree between data dirs. `rename` is atomic on a
/// single filesystem; when the target is on a different disk (the common reason
/// to change the backup location) it fails with `EXDEV` and we fall back to a
/// recursive copy + delete. Returns the total bytes in moved files.
#[cfg(test)]
fn move_entry(src: &Path, dst: &Path) -> std::io::Result<u64> {
    match fs::rename(src, dst) {
        Ok(()) => entry_bytes(dst),
        Err(e) if e.kind() == std::io::ErrorKind::CrossesDevices => {
            if fs::metadata(src)?.is_dir() {
                let bytes = copy_dir_all(src, dst)?;
                fs::remove_dir_all(src)?;
                Ok(bytes)
            } else {
                fs::copy(src, dst)?;
                let bytes = fs::metadata(dst)?.len();
                fs::remove_file(src)?;
                Ok(bytes)
            }
        }
        Err(e) => Err(e),
    }
}

/// Recursively copy a directory tree (directories + regular files), skipping
/// symlinks — object shards and the SQLite database are never symlinks. Uses
/// `fs::copy` (no external crate). Returns the total bytes copied; exercised
/// directly by tests since triggering a real `EXDEV` needs a second filesystem.
fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<u64> {
    fs::create_dir_all(dst)?;
    let mut total = 0u64;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let path = entry.path();
        let kind = entry.file_type()?;
        if kind.is_dir() {
            total += copy_dir_all(&path, &dst.join(entry.file_name()))?;
        } else if kind.is_file() {
            total += fs::copy(&path, dst.join(entry.file_name()))?;
        }
    }
    Ok(total)
}

/// Total size of a (possibly directory) entry, read from metadata only — no
/// data is touched, so reporting the migration size is cheap.
fn entry_bytes(path: &Path) -> std::io::Result<u64> {
    let meta = fs::metadata(path)?;
    if !meta.is_dir() {
        return Ok(meta.len());
    }
    let mut total = 0u64;
    for entry in fs::read_dir(path)? {
        total += entry_bytes(&entry?.path())?;
    }
    Ok(total)
}

/// Refuse a change-of-location target that already contains node data.
fn ensure_migratable_target(target: &Path) -> std::io::Result<()> {
    if validation::has_prior_install(target) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!(
                "{} already contains node data; cannot move into it (choose an empty path)",
                target.display()
            ),
        ));
    }
    Ok(())
}

/// Persist a `config.toml` with the given `data_dir` and `relay_url`. Kept
/// private and separate from the interactive prompt so the persistence logic is
/// unit-testable without a terminal.
fn write_config(
    nodus_dir: &Path,
    config_path: &Path,
    data_dir: PathBuf,
    relay_url: Option<String>,
) -> std::io::Result<()> {
    fs::create_dir_all(nodus_dir)?;
    let cfg = NodusConfigFile {
        data_dir,
        relay_url,
    };
    let toml = toml::to_string(&cfg)
        .map_err(|e| std::io::Error::other(format!("serializing config: {e}")))?;
    // Temp + rename + fsync so a crash cannot truncate the config into an
    // unparseable state (which would block the next boot). The relocation
    // invariant depends on this being durable before the old data is removed.
    write_file_durable(nodus_dir, config_path, toml.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    // --- insecure_plaintext_host ---

    #[test]
    fn insecure_plaintext_host_flags_public_http_and_ws() {
        assert_eq!(
            insecure_plaintext_host("http://nodus.example.com").as_deref(),
            Some("nodus.example.com")
        );
        assert_eq!(
            insecure_plaintext_host("ws://10.0.0.5:8080/ws").as_deref(),
            Some("10.0.0.5")
        );
    }

    #[test]
    fn insecure_plaintext_host_allows_tls_and_loopback() {
        assert!(insecure_plaintext_host("https://nodus.example.com").is_none());
        assert!(insecure_plaintext_host("wss://nodus.example.com/ws").is_none());
        assert!(insecure_plaintext_host("http://localhost:8080").is_none());
        assert!(insecure_plaintext_host("http://127.0.0.1:8080").is_none());
        assert!(insecure_plaintext_host("ws://[::1]:8080/ws").is_none());
        // Unparseable input is left to fail on connection, not mislabelled.
        assert!(insecure_plaintext_host("not-a-url").is_none());
    }

    // --- expand_tilde ---

    #[test]
    fn expand_tilde_expands_home() {
        let result = expand_tilde(PathBuf::from("~/mydata"));
        let s = result.to_string_lossy();
        assert!(!s.starts_with('~'), "tilde should be expanded, got: {s}");
        assert!(s.ends_with("mydata"), "should end with 'mydata', got: {s}");
    }

    #[test]
    fn expand_tilde_leaves_absolute_alone() {
        let p = PathBuf::from("/absolute/path");
        assert_eq!(expand_tilde(p.clone()), p);
    }

    #[test]
    fn expand_tilde_leaves_relative_alone() {
        let p = PathBuf::from("relative/path");
        assert_eq!(expand_tilde(p.clone()), p);
    }

    #[test]
    fn expand_tilde_lone_tilde_not_expanded() {
        // "~" alone (no trailing slash) is NOT expanded — only "~/" prefix is.
        let p = PathBuf::from("~");
        assert_eq!(expand_tilde(p.clone()), p);
    }

    // --- read_config_file ---

    #[test]
    fn config_roundtrip() {
        let dir = tempdir().unwrap();
        let config_path = dir.path().join("config.toml");
        let data_dir = dir.path().join("data");

        let cfg = NodusConfigFile {
            data_dir: data_dir.clone(),
            relay_url: Some("https://nodus.example.com".to_string()),
        };
        std::fs::write(&config_path, toml::to_string(&cfg).unwrap()).unwrap();

        let read = read_config_file(&config_path).unwrap().unwrap();
        assert_eq!(read.data_dir, data_dir);
        assert_eq!(read.relay_url.as_deref(), Some("https://nodus.example.com"));
    }

    #[test]
    fn config_without_relay_url_parses_none() {
        // Backward compatibility: config.toml files written before relay_url
        // existed must still parse, with relay_url defaulting to None.
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.toml");
        std::fs::write(&path, r#"data_dir = "/tmp/data""#).unwrap();

        let read = read_config_file(&path).unwrap().unwrap();
        assert_eq!(read.relay_url, None);
    }

    #[test]
    fn config_blank_relay_url_normalizes_to_none() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.toml");
        std::fs::write(&path, "data_dir = \"/tmp/data\"\nrelay_url = \"   \"").unwrap();

        let read = read_config_file(&path).unwrap().unwrap();
        assert_eq!(read.relay_url, None);
    }

    // --- resolve_relay_url ---

    #[test]
    fn relay_precedence_cli_wins() {
        assert_eq!(
            resolve_relay_url(Some("cli".into()), Some("file".into()), Some("env".into()))
                .as_deref(),
            Some("cli")
        );
    }

    #[test]
    fn relay_precedence_file_over_env() {
        assert_eq!(
            resolve_relay_url(None, Some("file".into()), Some("env".into())).as_deref(),
            Some("file")
        );
    }

    #[test]
    fn relay_precedence_env_when_alone() {
        assert_eq!(
            resolve_relay_url(None, None, Some("env".into())).as_deref(),
            Some("env")
        );
    }

    #[test]
    fn relay_none_when_all_absent() {
        // Empty config must not fall back to localhost; the caller fails loudly.
        assert_eq!(resolve_relay_url(None, None, None), None);
    }

    #[test]
    fn relay_blank_sources_are_ignored() {
        // A blank/whitespace higher-precedence source must not mask a real one.
        assert_eq!(
            resolve_relay_url(Some("   ".into()), Some("".into()), Some(" env ".into())).as_deref(),
            Some("env")
        );
    }

    // --- persist_relay_url ---

    #[test]
    fn persist_relay_url_preserves_data_dir() {
        let dir = tempdir().unwrap();
        let data_dir = dir.path().join("data");
        persist_relay_url(dir.path(), &data_dir, "https://nodus.example.com").unwrap();

        let cfg = read_config_file(&dir.path().join(CONFIG_FILE))
            .unwrap()
            .unwrap();
        assert_eq!(cfg.data_dir, data_dir);
        assert_eq!(cfg.relay_url.as_deref(), Some("https://nodus.example.com"));
    }

    // --- write_config (data-location change) ---

    #[test]
    fn write_config_preserves_relay_url_on_data_dir_change() {
        let dir = tempdir().unwrap();
        let data_dir = dir.path().join("new-location");
        let path = dir.path().join(CONFIG_FILE);

        // Simulate an already-paired node: config.toml has a relay_url.
        write_config(
            dir.path(),
            &path,
            dir.path().join("old-location"),
            Some("https://nodus.example.com".into()),
        )
        .unwrap();

        // Rewrite with a new data_dir; the relay pairing must survive.
        write_config(
            dir.path(),
            &path,
            data_dir.clone(),
            Some("https://nodus.example.com".into()),
        )
        .unwrap();

        let cfg = read_config_file(&path).unwrap().unwrap();
        assert_eq!(cfg.data_dir, data_dir);
        assert_eq!(cfg.relay_url.as_deref(), Some("https://nodus.example.com"));
    }

    // --- migrate_data_dir (change-of-location move) ---

    /// Seed a node-shaped data dir: database + object store + in-flight temp.
    fn seed_data_dir(dir: &Path) {
        std::fs::create_dir_all(dir.join("objects/ab")).unwrap();
        std::fs::create_dir_all(dir.join("temp")).unwrap();
        std::fs::write(dir.join("nodus.db"), b"dbfile").unwrap();
        std::fs::write(dir.join("objects/ab/abc123"), b"shard").unwrap();
        std::fs::write(dir.join("temp/inflight"), b"partial").unwrap();
    }

    #[test]
    fn migrate_moves_db_and_objects_and_temp() {
        let dir = tempdir().unwrap();
        let old = dir.path().join("old");
        let new = dir.path().join("new");
        seed_data_dir(&old);

        let bytes = migrate_data_dir(&old, &new).unwrap();
        assert!(bytes >= 5 + 5 + 7); // dbfile + shard + partial

        assert!(new.join("nodus.db").is_file());
        assert!(new.join("objects/ab/abc123").is_file());
        assert!(new.join("temp/inflight").is_file());
        assert!(
            !old.exists(),
            "old data dir should be removed after migration"
        );
    }

    /// Run the real relocation path (journal + config-before-source-delete)
    /// against a throwaway `nodus_dir`.
    fn run_relocate(old: &Path, new: &Path, relay: Option<&str>) -> (u64, PathBuf, PathBuf) {
        let nodus = old.parent().unwrap().join(".nodus");
        let config_path = nodus.join(CONFIG_FILE);
        let bytes =
            relocate_data_dir(old, new, &nodus, &config_path, relay.map(str::to_string)).unwrap();
        (bytes, nodus, config_path)
    }

    #[test]
    fn relocate_points_config_at_new_and_clears_journal() {
        let dir = tempdir().unwrap();
        let old = dir.path().join("old");
        let new = dir.path().join("new");
        seed_data_dir(&old);

        let (bytes, nodus, config_path) = run_relocate(&old, &new, Some("https://r.example"));
        assert!(bytes >= 5 + 5 + 7);
        assert!(new.join("nodus.db").is_file());
        assert!(new.join("objects/ab/abc123").is_file());
        assert!(
            !old.exists(),
            "source is deleted only after the config is durable"
        );

        let cfg = read_config_file(&config_path).unwrap().unwrap();
        assert_eq!(cfg.data_dir, new);
        assert_eq!(cfg.relay_url.as_deref(), Some("https://r.example"));
        assert!(!migration_journal_path(&nodus).exists());
    }

    #[test]
    fn recovery_repoints_config_when_move_completed_before_config_write() {
        let dir = tempdir().unwrap();
        let old = dir.path().join("old");
        let new = dir.path().join("new");
        let nodus = dir.path().join(".nodus");
        let config_path = nodus.join(CONFIG_FILE);

        // Same-FS rename finished (old gone, new holds the DB) but the crash hit
        // before the config flip: journal present, config still names old.
        std::fs::create_dir_all(&new).unwrap();
        std::fs::write(new.join("nodus.db"), b"db").unwrap();
        write_config(&nodus, &config_path, old.clone(), None).unwrap();
        write_migration_journal(&nodus, &old, &new).unwrap();

        recover_interrupted_migration(&nodus, &config_path).unwrap();

        let cfg = read_config_file(&config_path).unwrap().unwrap();
        assert_eq!(cfg.data_dir, new, "config must follow the database");
        assert!(!migration_journal_path(&nodus).exists());
    }

    #[test]
    fn recovery_keeps_source_when_move_incomplete() {
        let dir = tempdir().unwrap();
        let old = dir.path().join("old");
        let new = dir.path().join("new");
        let nodus = dir.path().join(".nodus");
        let config_path = nodus.join(CONFIG_FILE);
        seed_data_dir(&old);

        // Partial cross-device copy: target has objects but no database yet.
        std::fs::create_dir_all(new.join("objects")).unwrap();
        write_config(&nodus, &config_path, old.clone(), Some("https://r".into())).unwrap();
        write_migration_journal(&nodus, &old, &new).unwrap();

        recover_interrupted_migration(&nodus, &config_path).unwrap();

        let cfg = read_config_file(&config_path).unwrap().unwrap();
        assert_eq!(cfg.data_dir, old, "the source still owns the database");
        assert_eq!(cfg.relay_url.as_deref(), Some("https://r"));
        assert!(old.join("nodus.db").is_file());
        assert!(!migration_journal_path(&nodus).exists());
    }

    /// The menu's "Change data location" closes its reporting pool before the
    /// move. Verify a real WAL-mode database survives that exact sequence:
    /// write, clean close (SQLite checkpoints/releases the WAL), move the dir,
    /// reopen at the new path, and read the row back. A move under a live pool
    /// would risk renaming `nodus.db` away from its `-wal`/`-shm` sidecars.
    #[tokio::test]
    async fn migrate_moves_a_real_wal_database_intact() {
        let dir = tempdir().unwrap();
        let old = dir.path().join("old");
        let new = dir.path().join("new");

        let pool = crate::db::open(&old).await.unwrap();
        sqlx::query("CREATE TABLE marker (value TEXT NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO marker (value) VALUES ('survives-the-move')")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;

        migrate_data_dir(&old, &new).unwrap();
        assert!(new.join("nodus.db").is_file());

        let reopened = crate::db::open(&new).await.unwrap();
        let value: String = sqlx::query_scalar("SELECT value FROM marker")
            .fetch_one(&reopened)
            .await
            .unwrap();
        assert_eq!(value, "survives-the-move");
        reopened.close().await;
    }

    #[test]
    fn migrate_into_existing_empty_dir_moves_contents() {
        let dir = tempdir().unwrap();
        let old = dir.path().join("old");
        let new = dir.path().join("new");
        seed_data_dir(&old);
        std::fs::create_dir(&new).unwrap();

        migrate_data_dir(&old, &new).unwrap();
        assert!(new.join("nodus.db").is_file());
        assert!(!old.exists());
    }

    #[test]
    fn migrate_without_prior_data_is_a_noop() {
        let dir = tempdir().unwrap();
        let old = dir.path().join("old");
        let new = dir.path().join("new");
        std::fs::create_dir(&old).unwrap();

        migrate_data_dir(&old, &new).unwrap();
        assert!(new.is_dir());
        assert!(!old.exists());
    }

    #[test]
    fn migrate_refuses_target_with_prior_install() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("target");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("nodus.db"), b"different node").unwrap();

        let err = ensure_migratable_target(&target).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput);
    }

    #[test]
    fn copy_dir_all_preserves_tree_and_counts_bytes() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("src");
        let dst = dir.path().join("dst");
        seed_data_dir(&src);

        let bytes = copy_dir_all(&src, &dst).unwrap();
        assert!(dst.join("nodus.db").is_file());
        assert!(dst.join("objects/ab/abc123").is_file());
        assert!(dst.join("temp/inflight").is_file());
        assert!(bytes >= 17);
    }

    #[test]
    fn persist_relay_url_preserves_unknown_keys() {
        // A future-or-foreign config key must survive a relay_url write;
        // re-serializing the typed struct would silently drop it.
        let dir = tempdir().unwrap();
        let data_dir = dir.path().join("data");
        let path = dir.path().join(CONFIG_FILE);
        std::fs::write(
            &path,
            format!(
                "data_dir = {:?}\nfuture_key = \"keep-me\"\n",
                data_dir.display().to_string()
            ),
        )
        .unwrap();

        persist_relay_url(dir.path(), &data_dir, "https://nodus.example.com").unwrap();

        let doc: toml::Table = toml::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            doc.get("future_key").and_then(|v| v.as_str()),
            Some("keep-me")
        );
        assert_eq!(
            doc.get("relay_url").and_then(|v| v.as_str()),
            Some("https://nodus.example.com")
        );
    }

    #[test]
    fn config_missing_returns_none() {
        let dir = tempdir().unwrap();
        let result = read_config_file(&dir.path().join("nonexistent.toml")).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn config_empty_data_dir_errors() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.toml");
        std::fs::write(&path, r#"data_dir = """#).unwrap();
        assert!(matches!(
            read_config_file(&path),
            Err(ConfigError::MissingField("data_dir"))
        ));
    }

    // --- adopt_and_save ---

    #[test]
    fn adopt_clean_dir_succeeds() {
        let dir = tempdir().unwrap();
        let nodus_dir = dir.path().join(".nodus");
        let data_dir = dir.path().join("data");
        let result = adopt_and_save(
            &nodus_dir,
            &nodus_dir.join("config.toml"),
            data_dir.clone(),
            false,
        );
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), data_dir);
    }

    #[test]
    fn adopt_blocks_prior_install_without_force() {
        let dir = tempdir().unwrap();
        let nodus_dir = dir.path().join(".nodus");
        let data_dir = dir.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();
        std::fs::write(data_dir.join("nodus.db"), b"fake").unwrap();

        let result = adopt_and_save(&nodus_dir, &nodus_dir.join("config.toml"), data_dir, false);
        assert!(matches!(result, Err(ConfigError::PriorInstall(_))));
    }

    #[test]
    fn adopt_force_skips_prior_install() {
        let dir = tempdir().unwrap();
        let nodus_dir = dir.path().join(".nodus");
        let data_dir = dir.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();
        std::fs::write(data_dir.join("nodus.db"), b"fake").unwrap();

        let result = adopt_and_save(&nodus_dir, &nodus_dir.join("config.toml"), data_dir, true);
        assert!(result.is_ok());
    }

    #[test]
    fn adopt_creates_data_dir() {
        let dir = tempdir().unwrap();
        let nodus_dir = dir.path().join(".nodus");
        let data_dir = dir.path().join("new/nested/dir");
        assert!(!data_dir.exists());
        adopt_and_save(
            &nodus_dir,
            &nodus_dir.join("config.toml"),
            data_dir.clone(),
            false,
        )
        .unwrap();
        assert!(data_dir.is_dir());
    }
}
