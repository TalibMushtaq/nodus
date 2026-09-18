//! Factory reset for a Storage Node.
//!
//! Wipes every piece of state that ties this node to an account: the SQLite
//! catalogue, the content-addressed object store, and the node identity itself.
//! Deleting the identity is deliberate — a new keypair yields a new `node_id`,
//! so the node cannot silently re-attach to its old Relay registration: the
//! operator must pair again from scratch. The caller must close the SQLite pool
//! before purging (SQLite would otherwise keep writing to the unlinked file).

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use crate::config::{CONFIG_FILE, IDENTITY_DIR, MIGRATION_JOURNAL};
use crate::store::layout::{objects_dir, temp_dir};

/// Exact phrase the operator must type to confirm a factory reset. Matched
/// case-sensitively so a reflex "yes"/empty line cannot trigger a wipe.
pub const CONFIRM_PHRASE: &str = "purge everything";

/// Every path a factory reset removes. Kept as a pure function so the set is
/// reviewable and unit-testable, and so callers can print it before deleting.
///
/// Deliberately limited to the node's own artefacts rather than removing the
/// directories themselves: `data_dir` may be any operator-chosen location and
/// could hold unrelated files.
pub fn purgable_paths(data_dir: &Path, nodus_dir: &Path) -> Vec<PathBuf> {
    vec![
        // SQLite catalogue and its WAL sidecars.
        data_dir.join("nodus.db"),
        data_dir.join("nodus.db-wal"),
        data_dir.join("nodus.db-shm"),
        // Encrypted shards + in-flight temp writes.
        objects_dir(data_dir),
        temp_dir(data_dir),
        // Relay pairing + identity: removing these forces a fresh node_id and
        // the first-run pairing wizard on the next boot.
        nodus_dir.join(CONFIG_FILE),
        nodus_dir.join(MIGRATION_JOURNAL),
        nodus_dir.join(IDENTITY_DIR),
    ]
}

/// Delete the node's catalogue, objects, identity, and config. Returns the
/// paths that existed and were removed, for reporting. Missing paths are
/// skipped so a reset is idempotent.
pub fn purge_node(data_dir: &Path, nodus_dir: &Path) -> Result<Vec<PathBuf>> {
    let mut removed = Vec::new();
    for path in purgable_paths(data_dir, nodus_dir) {
        if !path.exists() {
            continue;
        }
        if path.is_dir() {
            std::fs::remove_dir_all(&path)
                .with_context(|| format!("removing directory {}", path.display()))?;
        } else {
            std::fs::remove_file(&path)
                .with_context(|| format!("removing file {}", path.display()))?;
        }
        removed.push(path);
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn purgable_paths_cover_identity_config_and_store() {
        let data = Path::new("/tmp/nodus-data");
        let nodus = Path::new("/tmp/nodus-home");
        let paths = purgable_paths(data, nodus);
        assert!(paths.contains(&data.join("nodus.db")));
        assert!(paths.contains(&data.join("objects")));
        assert!(paths.contains(&data.join("temp")));
        assert!(paths.contains(&nodus.join("config.toml")));
        assert!(paths.contains(&nodus.join("identity")));
    }

    #[test]
    fn purge_removes_artifacts_and_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data");
        let nodus = tmp.path().join("nodus");
        std::fs::create_dir_all(data.join("objects")).unwrap();
        std::fs::create_dir_all(data.join("temp")).unwrap();
        std::fs::create_dir_all(nodus.join("identity")).unwrap();
        std::fs::write(data.join("nodus.db"), b"db").unwrap();
        std::fs::write(nodus.join("config.toml"), b"relay_url = \"x\"").unwrap();
        std::fs::write(nodus.join("identity").join("node_id"), b"id").unwrap();
        // An unrelated file in the data dir must survive.
        std::fs::write(data.join("keep.txt"), b"keep").unwrap();

        let removed = purge_node(&data, &nodus).unwrap();
        assert!(!removed.is_empty());
        assert!(!data.join("nodus.db").exists());
        assert!(!data.join("objects").exists());
        assert!(!nodus.join("config.toml").exists());
        assert!(!nodus.join("identity").exists());
        assert!(
            data.join("keep.txt").exists(),
            "unrelated files are left alone"
        );

        // A second reset finds nothing and errors on nothing.
        assert!(purge_node(&data, &nodus).unwrap().is_empty());
    }
}
