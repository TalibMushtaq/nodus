mod prompt;
mod validation;

use std::fs;
use std::path::{Path, PathBuf};

use directories::BaseDirs;
use serde::{Deserialize, Serialize};

pub const CONFIG_FILE: &str = "config.toml";
/// Reserved fixed subdirectory (see §11) that will hold the node keypair when
/// the identity module lands in Phase 5. Kept here as the single reference for
/// the reserved name so identity code and config code agree on it.
#[allow(dead_code)]
pub const IDENTITY_DIR: &str = "identity";

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
    fs::write(config_path, toml)?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

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
