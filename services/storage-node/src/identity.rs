//! Node identity: persistent Ed25519 keypair stored under `~/.nodus/identity/`.
//!
//! The `SigningKey` is kept in memory for signing operations (Phase 9 snapshot
//! signatures, Phase 11 challenge-response). The raw bytes are stored under
//! `IDENTITY_DIR` (the constant already reserved in `config/mod.rs`).
//!
//! Security properties:
//! - The private key file is created with mode 0o600 (owner read/write only).
//! - If the file exists but has wrong permissions on Unix, we warn but continue;
//!   a hard failure would break unattended restarts in a misconfigured install.
//! - The `SigningKey` is a `zeroize`-on-drop type from ed25519-dalek, so the
//!   key material is cleared from memory when the struct is dropped.

use std::fs;
use std::path::Path;

use anyhow::{Context, bail};
use ed25519_dalek::{SigningKey, VerifyingKey};
use rand::rngs::OsRng;

use crate::config::IDENTITY_DIR;

const PRIVATE_KEY_FILE: &str = "node_private_key";
const NODE_ID_FILE: &str = "node_id";

/// Live node identity held in memory for the process lifetime.
pub struct NodeIdentity {
    /// Hex-encoded public key, used as the stable Node ID on the wire.
    pub node_id: String,
    /// Ed25519 public key (32 bytes). Exposed for pairing / trust verification.
    pub public_key: VerifyingKey,
    /// Full signing key, kept in memory for signing challenges (and snapshots
    /// if a later phase calls for it). Zeroized on drop.
    signing_key: SigningKey,
}

impl NodeIdentity {
    /// Sign `message` with the node's private key (used for the Relay auth
    /// challenge response and node-to-node verification).
    pub fn sign(&self, message: &[u8]) -> ed25519_dalek::Signature {
        use ed25519_dalek::Signer;
        self.signing_key.sign(message)
    }
}

/// Load the node keypair from `nodus_dir/identity/`, generating a new one
/// on first run.
///
/// `nodus_dir` is the config directory (`~/.nodus`) as resolved by
/// `config::load_or_setup`; the identity directory is always a fixed
/// subdirectory of that path (see `config::IDENTITY_DIR`).
pub fn load_or_generate(nodus_dir: &Path) -> anyhow::Result<NodeIdentity> {
    let identity_dir = nodus_dir.join(IDENTITY_DIR);
    fs::create_dir_all(&identity_dir)
        .with_context(|| format!("creating identity dir {}", identity_dir.display()))?;

    let key_path = identity_dir.join(PRIVATE_KEY_FILE);

    let signing_key = if key_path.exists() {
        load_key(&key_path)?
    } else {
        generate_and_persist(&key_path)?
    };

    let public_key = signing_key.verifying_key();
    // Hex-encode the 32-byte public key as the Node ID.
    let node_id = hex::encode(public_key.as_bytes());

    // Write the node_id as plain text for operator convenience. This file is
    // not authoritative — the ID is always re-derived from the public key.
    let id_path = identity_dir.join(NODE_ID_FILE);
    fs::write(&id_path, &node_id)
        .with_context(|| format!("writing node_id file {}", id_path.display()))?;

    Ok(NodeIdentity {
        node_id,
        public_key,
        signing_key,
    })
}

/// Read the persisted node id without generating an identity.
///
/// Used by the interactive status view: inspecting a node must not create a
/// keypair as a side effect. Returns `None` when the node has never generated
/// its identity.
pub fn existing_node_id(nodus_dir: &Path) -> Option<String> {
    let path = nodus_dir.join(IDENTITY_DIR).join(NODE_ID_FILE);
    fs::read_to_string(path)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn load_key(path: &Path) -> anyhow::Result<SigningKey> {
    use std::io::Read;
    use zeroize::Zeroizing;

    // Warn (but continue) on a key file that is group/world-accessible: a hard
    // failure would break unattended restarts on a misconfigured install, but
    // the operator must be told the private key is exposed.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(path)?.permissions().mode() & 0o777;
        if mode & 0o077 != 0 {
            eprintln!(
                "[identity] warning: private key {} has permissions {mode:o}; \
                 expected 0600 (owner read/write only)",
                path.display()
            );
        }
    }

    let file =
        fs::File::open(path).with_context(|| format!("reading private key {}", path.display()))?;
    let len = file
        .metadata()
        .with_context(|| format!("stat private key {}", path.display()))?
        .len();
    if len != 32 {
        bail!(
            "private key file {} has {} bytes, expected 32; \
             restore it from backup or remove it to generate a new identity \
             (a new identity requires re-pairing)",
            path.display(),
            len
        );
    }

    // Read directly into a fixed buffer wrapped in `Zeroizing` so the private
    // bytes are cleared from memory on drop (the header comment's promise).
    let mut key_bytes = Zeroizing::new([0u8; 32]);
    file.take(32)
        .read_exact(&mut *key_bytes)
        .with_context(|| format!("reading private key {}", path.display()))?;
    Ok(SigningKey::from_bytes(&key_bytes))
}

fn generate_and_persist(path: &Path) -> anyhow::Result<SigningKey> {
    use zeroize::Zeroizing;

    let key = SigningKey::generate(&mut OsRng);
    // Write the raw bytes through a Zeroizing copy so the intermediate is also
    // cleared; `as_bytes` borrows the key, which zeroizes itself on drop.
    let bytes = Zeroizing::new(*key.as_bytes());
    write_private_key(path, &bytes[..])?;
    Ok(key)
}

/// Write `bytes` to `path` atomically with `0o600` permissions (Unix:
/// owner-only). A sibling temp file is written with the restricted mode first,
/// then renamed over `path`; a crash mid-write therefore leaves either no key
/// or the complete key, never a truncated one that would brick the node.
fn write_private_key(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    use std::io::Write;

    let tmp = path.with_extension("tmp");

    // On Unix, open with restricted permissions before writing any bytes.
    #[cfg(unix)]
    let mut file = {
        use std::os::unix::fs::OpenOptionsExt;
        fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)
            .with_context(|| format!("creating private key file {}", tmp.display()))?
    };
    // Non-Unix fallback (Windows dev environments).
    #[cfg(not(unix))]
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&tmp)
        .with_context(|| format!("creating private key file {}", tmp.display()))?;

    file.write_all(bytes)
        .with_context(|| format!("writing private key file {}", tmp.display()))?;
    file.sync_all()
        .with_context(|| format!("syncing private key file {}", tmp.display()))?;
    drop(file);

    fs::rename(&tmp, path).with_context(|| {
        format!(
            "renaming private key {} to {}",
            tmp.display(),
            path.display()
        )
    })?;
    if let Some(parent) = path.parent() {
        // Best-effort: make the renamed entry durable.
        #[cfg(unix)]
        {
            let _ = fs::File::open(parent).and_then(|d| d.sync_all());
        }
        #[cfg(not(unix))]
        {
            let _ = parent;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn generate_creates_key_files() {
        let dir = tempdir().unwrap();
        let id = load_or_generate(dir.path()).unwrap();
        assert_eq!(id.node_id.len(), 64, "hex node_id should be 64 chars");
        assert!(
            dir.path()
                .join(IDENTITY_DIR)
                .join(PRIVATE_KEY_FILE)
                .exists()
        );
        assert!(dir.path().join(IDENTITY_DIR).join(NODE_ID_FILE).exists());
    }

    #[test]
    fn reload_returns_same_node_id() {
        let dir = tempdir().unwrap();
        let id1 = load_or_generate(dir.path()).unwrap();
        let id2 = load_or_generate(dir.path()).unwrap();
        assert_eq!(
            id1.node_id, id2.node_id,
            "node_id must be stable across restarts"
        );
    }

    #[test]
    fn bad_key_file_length_errors() {
        let dir = tempdir().unwrap();
        let key_path = dir.path().join(IDENTITY_DIR).join(PRIVATE_KEY_FILE);
        fs::create_dir_all(dir.path().join(IDENTITY_DIR)).unwrap();
        fs::write(&key_path, b"tooshort").unwrap();
        assert!(load_or_generate(dir.path()).is_err());
    }

    #[test]
    fn existing_node_id_absent_until_generated() {
        let dir = tempdir().unwrap();
        // Inspecting a fresh node must not create identity material.
        assert_eq!(existing_node_id(dir.path()), None);
        let generated = load_or_generate(dir.path()).unwrap();
        assert_eq!(
            existing_node_id(dir.path()).as_deref(),
            Some(generated.node_id.as_str())
        );
    }

    #[cfg(unix)]
    #[test]
    fn private_key_is_owner_only_and_no_temp_left_behind() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempdir().unwrap();
        load_or_generate(dir.path()).unwrap();

        let key_path = dir.path().join(IDENTITY_DIR).join(PRIVATE_KEY_FILE);
        let mode = fs::metadata(&key_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "private key must be owner read/write only");
        assert!(
            !key_path.with_extension("tmp").exists(),
            "atomic write must not leave a temp file"
        );
    }

    #[cfg(unix)]
    #[test]
    fn wide_permission_key_still_loads() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempdir().unwrap();
        load_or_generate(dir.path()).unwrap();
        let key_path = dir.path().join(IDENTITY_DIR).join(PRIVATE_KEY_FILE);
        // Loosen permissions; load must warn but still succeed (a hard failure
        // would break unattended restarts).
        fs::set_permissions(&key_path, fs::Permissions::from_mode(0o644)).unwrap();
        let id = load_or_generate(dir.path()).unwrap();
        assert_eq!(id.node_id.len(), 64);
    }
}
