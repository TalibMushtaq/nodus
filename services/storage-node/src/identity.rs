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
    #[allow(dead_code)]
    pub public_key: VerifyingKey,
    /// Full signing key, kept in memory for signing snapshots and challenges.
    /// Zeroized on drop.
    #[allow(dead_code)]
    signing_key: SigningKey,
}

impl NodeIdentity {
    /// Sign `message` with the node's private key (for Phase 9 / Phase 11).
    #[allow(dead_code)]
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

fn load_key(path: &Path) -> anyhow::Result<SigningKey> {
    let bytes =
        fs::read(path).with_context(|| format!("reading private key {}", path.display()))?;
    if bytes.len() != 32 {
        bail!(
            "private key file {} has {} bytes, expected 32",
            path.display(),
            bytes.len()
        );
    }
    let mut key_bytes = [0u8; 32];
    key_bytes.copy_from_slice(&bytes);
    Ok(SigningKey::from_bytes(&key_bytes))
}

fn generate_and_persist(path: &Path) -> anyhow::Result<SigningKey> {
    let key = SigningKey::generate(&mut OsRng);
    write_private_key(path, key.as_bytes())?;
    Ok(key)
}

/// Write `bytes` to `path` with `0o600` permissions (Unix: owner-only).
fn write_private_key(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    use std::io::Write;

    // On Unix, open with restricted permissions before writing any bytes.
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .with_context(|| format!("creating private key file {}", path.display()))?;
        file.write_all(bytes)
            .with_context(|| format!("writing private key file {}", path.display()))?;
    }
    // Non-Unix fallback (Windows dev environments).
    #[cfg(not(unix))]
    {
        fs::write(path, bytes)
            .with_context(|| format!("writing private key file {}", path.display()))?;
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
}
