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

/// Bootstrap config file contents. Holds exactly one key today (`data_dir`);
/// adding more keys here is backward-compatible because `data_dir` has no
/// serde default that would make it optional.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodusConfigFile {
    pub data_dir: PathBuf,
}

/// Resolved runtime configuration for the node.
#[derive(Debug, Clone)]
pub struct Config {
    /// User-chosen location for `nodus.db` and `objects/`.
    pub data_dir: PathBuf,
    /// Fixed OS-standard config dir (`~/.nodus`) holding identity + config.
    pub nodus_dir: PathBuf,
}

impl Config {
    fn from_path(nodus_dir: PathBuf, data_dir: PathBuf) -> Self {
        Config { data_dir, nodus_dir }
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
pub fn load_or_setup(
    cli_data_dir: Option<PathBuf>,
    interactive: bool,
    force_adopt: bool,
) -> Result<Config, ConfigError> {
    let nodus_dir = nodus_dir_os();
    let config_path = nodus_dir.join(CONFIG_FILE);

    // First-run detection: an existing config means a prior setup, so boot
    // from it without prompting — required so an unattended daemon restart
    // never blocks on input.
    if let Some(cfg) = read_config_file(&config_path)? {
        return Ok(Config::from_path(nodus_dir, cfg.data_dir));
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
        return Ok(Config::from_path(nodus_dir, data_dir));
    }

    // Interactive first-run setup.
    if interactive {
        // interactive_data_dir() already confirms prior-install with the user,
        // so adopt_and_save is called with force_adopt=true to avoid a
        // redundant check on the already-confirmed path.
        let data_dir = prompt::interactive_data_dir(default_data_dir_hint())?;
        let data_dir = adopt_and_save(&nodus_dir, &config_path, data_dir, true)?;
        return Ok(Config::from_path(nodus_dir, data_dir));
    }

    Err(ConfigError::NoDataDir)
}

/// Read the config file if it exists; returns `None` when the file is absent.
fn read_config_file(path: &Path) -> Result<Option<NodusConfigFile>, ConfigError> {
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(path)?;
    let cfg: NodusConfigFile = toml::from_str(&text)?;
    if cfg.data_dir.as_os_str().is_empty() {
        return Err(ConfigError::MissingField("data_dir"));
    }
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
    let cfg = NodusConfigFile { data_dir };
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

        let cfg = NodusConfigFile { data_dir: data_dir.clone() };
        std::fs::write(&config_path, toml::to_string(&cfg).unwrap()).unwrap();

        let read = read_config_file(&config_path).unwrap().unwrap();
        assert_eq!(read.data_dir, data_dir);
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
        let result = adopt_and_save(&nodus_dir, &nodus_dir.join("config.toml"), data_dir.clone(), false);
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
        adopt_and_save(&nodus_dir, &nodus_dir.join("config.toml"), data_dir.clone(), false).unwrap();
        assert!(data_dir.is_dir());
    }
}

