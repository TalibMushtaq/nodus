//! Path layout helpers for content-addressed storage objects and temp files.

use std::path::{Path, PathBuf};

/// Returns the root objects directory: `<data_dir>/objects`
pub fn objects_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("objects")
}

/// Returns the root temp directory: `<data_dir>/temp`
pub fn temp_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("temp")
}

/// Returns the on-disk path for a stored object given its hex BLAKE3 hash.
/// Layout: `<data_dir>/objects/<ab>/<abcdef...>`
///
/// If `hash_hex` is shorter than 2 characters, falls back to `objects/<hash_hex>`.
pub fn object_path(data_dir: &Path, hash_hex: &str) -> PathBuf {
    if hash_hex.len() >= 2 {
        let prefix = &hash_hex[..2];
        objects_dir(data_dir).join(prefix).join(hash_hex)
    } else {
        objects_dir(data_dir).join(hash_hex)
    }
}

/// Returns a unique temp path for an in-progress atomic write.
/// Layout: `<data_dir>/temp/<id>`
#[allow(dead_code)]
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
            object_path(base, "abcdef123456"),
            PathBuf::from("/data/objects/ab/abcdef123456")
        );
        assert_eq!(
            temp_path(base, "uuid-1234"),
            PathBuf::from("/data/temp/uuid-1234")
        );
    }
}
