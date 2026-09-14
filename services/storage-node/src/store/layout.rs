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
/// Layout: `<data_dir>/objects/<abcdef...>` (flat).
///
/// The earlier two-level `<ab>/<hash>` layout put each shard in its own
/// prefix directory (distinct hashes almost never share a prefix), which read
/// as "a folder per shard". Objects now share the one `objects/` directory;
/// `migrate_flat_layout` moves any existing bucketed objects on boot.
///
/// Fails on anything that is not a 64-character lowercase hex digest: the
/// caller controls the id and the path is later opened for read or unlink, so
/// validating here prevents a malformed id from escaping `objects/`. (The
/// previous free-form slice also panicked on a multi-byte first character.)
pub fn object_path(data_dir: &Path, hash_hex: &str) -> anyhow::Result<PathBuf> {
    if !is_valid_object_id(hash_hex) {
        bail!("invalid object id {hash_hex:?}: expected a 64-character lowercase hex digest");
    }
    Ok(objects_dir(data_dir).join(hash_hex))
}

/// One-time migration from the legacy bucketed layout (`objects/<ab>/<hash>`)
/// to the flat layout (`objects/<hash>`). Idempotent and cheap after the first
/// run: once no 2-hex bucket directories remain, the scan is a single
/// `read_dir`. Best-effort — a failure is logged rather than bricking startup,
/// and any un-moved object is still reachable by hand.
pub fn migrate_flat_layout(objects_dir: &Path) {
    let Ok(entries) = std::fs::read_dir(objects_dir) else {
        return;
    };
    let mut migrated = 0usize;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        // Only touch 2-hex bucket dirs; any unexpected subdirectory is left be.
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.len() != 2 || !name.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
            continue;
        }
        let Ok(inner) = std::fs::read_dir(&path) else {
            continue;
        };
        for object in inner.flatten() {
            let src = object.path();
            if !src.is_file() {
                continue;
            }
            let dest = objects_dir.join(object.file_name());
            if dest.exists() {
                // Same content-addressed hash already present: drop the copy.
                let _ = std::fs::remove_file(&src);
            } else if let Err(e) = std::fs::rename(&src, &dest) {
                eprintln!(
                    "[store] warning: failed to migrate object {}: {e}",
                    src.display()
                );
                continue;
            }
            migrated += 1;
        }
        let _ = std::fs::remove_dir(&path);
    }
    if migrated > 0 {
        println!("[store] migrated {migrated} object(s) to the flat objects/ layout");
    }
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
                "/data/objects/abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"
            )
        );
        assert_eq!(
            temp_path(base, "uuid-1234"),
            PathBuf::from("/data/temp/uuid-1234")
        );
    }

    #[test]
    fn migrate_flat_layout_moves_bucketed_objects() {
        let dir = tempfile::tempdir().unwrap();
        let objects = objects_dir(dir.path());
        let hash = format!("ab{}", "c".repeat(62));
        std::fs::create_dir_all(objects.join("ab")).unwrap();
        std::fs::write(objects.join("ab").join(&hash), b"bytes").unwrap();

        migrate_flat_layout(&objects);

        assert!(objects.join(&hash).exists(), "object must move to objects/");
        assert!(!objects.join("ab").exists(), "empty bucket must be removed");
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
