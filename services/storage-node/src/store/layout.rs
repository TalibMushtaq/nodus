//! Path layout helpers for content-addressed storage objects and temp files.

use std::path::{Path, PathBuf};

use anyhow::bail;

/// Returns the root objects directory: `<data_dir>/objects`
pub fn objects_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("objects")
}

/// Returns the root temp directory: `<data_dir>/temp`
pub fn temp_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("temp")
}

/// True when `id` is exactly 64 lowercase hex characters — the only shape
/// `ObjectStore::put` can produce (a BLAKE3 digest). Centralised so every
/// caller that builds a filesystem path can reject anything else first; a
/// stored-but-malformed id (DB corruption, crafted snapshot) must never reach
/// `fs::remove_file`/`fs::read` as a traversal path.
pub fn is_valid_object_id(id: &str) -> bool {
    id.len() == 64 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Returns the on-disk path for a stored object given its hex BLAKE3 hash.
/// Layout: `<data_dir>/objects/<ab>/<abcdef...>`
///
/// Fails on anything that is not a 64-character lowercase hex digest: the
/// caller controls the id and the path is later opened for read or unlink, so
/// validating here prevents a malformed id from escaping `objects/`. (The
/// previous free-form slice also panicked on a multi-byte first character.)
pub fn object_path(data_dir: &Path, hash_hex: &str) -> anyhow::Result<PathBuf> {
    if !is_valid_object_id(hash_hex) {
        bail!("invalid object id {hash_hex:?}: expected a 64-character lowercase hex digest");
    }
    // Safe: length is 64 and every byte is ASCII hex.
    let prefix = &hash_hex[..2];
    Ok(objects_dir(data_dir).join(prefix).join(hash_hex))
}

/// Returns a unique temp path for an in-progress atomic write.
/// Layout: `<data_dir>/temp/<id>`
pub fn temp_path(data_dir: &Path, id: &str) -> PathBuf {
    temp_dir(data_dir).join(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_paths() {
        let base = Path::new("/data");
        assert_eq!(objects_dir(base), PathBuf::from("/data/objects"));
        assert_eq!(temp_dir(base), PathBuf::from("/data/temp"));
        assert_eq!(
            object_path(
                base,
                "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"
            )
            .unwrap(),
            PathBuf::from(
                "/data/objects/ab/abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"
            )
        );
        assert_eq!(
            temp_path(base, "uuid-1234"),
            PathBuf::from("/data/temp/uuid-1234")
        );
    }

    #[test]
    fn object_path_rejects_traversal_and_non_hex() {
        let base = Path::new("/data");
        for bad in [
            "../../etc/passwd",
            "not-a-hash",
            &"DEADBEEF".repeat(8), // uppercase
            &"é".repeat(64),       // multi-byte, would have panicked on slicing
        ] {
            assert!(
                object_path(base, bad).is_err(),
                "malformed id {bad:?} must be rejected before path construction"
            );
        }
    }

    #[test]
    fn is_valid_object_id_matches_put_output() {
        assert!(is_valid_object_id(
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        ));
        assert!(!is_valid_object_id(
            "0123456789ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef"
        ));
        assert!(!is_valid_object_id("short"));
    }
}
