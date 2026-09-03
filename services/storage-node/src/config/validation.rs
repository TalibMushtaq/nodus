use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// Lowercase substrings matched against each path component (via `starts_with`).
///
/// | Substring      | Catches                                            |
/// |----------------|----------------------------------------------------|
/// | `dropbox`      | `Dropbox/` — all platforms                         |
/// | `onedrive`     | `OneDrive/` — all platforms                        |
/// | `googledrive`  | `GoogleDrive-user@gmail.com/` — macOS CloudStorage |
/// | `iclouddrive`  | `iCloudDrive/` — macOS CloudStorage                |
const CLOUD_SYNC_SUBSTRINGS: &[&str] = &["dropbox", "onedrive", "googledrive", "iclouddrive"];

/// The names that indicate a prior install inside a candidate directory.
const PRIOR_INSTALL_MARKERS: &[&str] = &["nodus.db", "objects"];

/// True if `path` is a writable directory. Uses a real create/remove probe
/// because `OpenOptions` cannot open a directory for writing portably.
pub fn is_writable(path: &Path) -> bool {
    if !path.is_dir() {
        return false;
    }
    probe_write(path)
}

fn probe_write(path: &Path) -> bool {
    let probe = path.join(format!(".nodus-write-test-{}", std::process::id()));
    let ok = std::fs::write(&probe, b"probe").is_ok();
    let _ = std::fs::remove_file(&probe);
    ok
}

/// Create `path` (and parents) if it is missing. Returns the path back.
pub fn ensure_dir(path: &Path) -> std::io::Result<PathBuf> {
    if path.exists() {
        return Ok(path.to_path_buf());
    }
    std::fs::create_dir_all(path)?;
    Ok(path.to_path_buf())
}

/// True if any ancestor (up to and including the path itself) is a known
/// cloud-sync folder, so we can warn the user that the data may be
/// mirrored to the cloud.
pub fn is_inside_cloud_sync(path: &Path) -> bool {
    path.ancestors()
        .filter_map(|a| a.file_name())
        .any(|name| {
            let lower = name.to_string_lossy().to_lowercase();
            CLOUD_SYNC_SUBSTRINGS.iter().any(|sub| lower.starts_with(sub))
        })
}

/// Detect whether the path sits on a removable/network mount rather than the
/// system home disk, by comparing it against known mount points.
pub fn is_removable_or_network_root(path: &Path) -> bool {
    mounts()
        .iter()
        .any(|(mount, fstype)| {
            longpath_starts_with(path, mount) && is_removable_or_network(fstype)
        })
}

fn is_removable_or_network(fstype: &str) -> bool {
    matches!(
        fstype,
        "nfs" | "nfs4" | "cifs" | "smbfs" | "vfat" | "fuseblk" | "ntfs" | "exfat" | "ext4usb"
    )
}

/// `Path::starts_with` already returns `true` for equal paths, so the
/// previous `|| path == mount` was unreachable dead code.
fn longpath_starts_with(path: &Path, mount: &Path) -> bool {
    path.starts_with(mount)
}

/// Returns the list of `(mount_point, filesystem_type)` pairs on this system.
///
/// Linux exposes these in `/proc/mounts` (and the legacy `/etc/mtab`).
/// Non-Linux platforms return an empty list, which degrades the mount-based
/// warning to a no-op rather than a build error.
fn mounts() -> Vec<(PathBuf, String)> {
    let mut out = Vec::new();
    for file in ["/proc/self/mounts", "/etc/mtab"] {
        if let Ok(contents) = std::fs::read_to_string(file) {
            for line in contents.lines() {
                // format: device mount_point fstype options dump pass
                let mut parts = line.split_whitespace();
                let _device = parts.next();
                if let (Some(mount), Some(fstype)) = (parts.next(), parts.next()) {
                    out.push((PathBuf::from(mount), fstype.to_string()));
                }
            }
            return out;
        }
    }
    out
}

/// True if the directory already holds a `nodus.db` or `objects/` from a prior
/// install. Used for the blocking confirmation before we adopt the directory.
pub fn has_prior_install(path: &Path) -> bool {
    if !path.is_dir() {
        return false;
    }
    let names: HashSet<String> = match std::fs::read_dir(path) {
        Ok(entries) => entries
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_lowercase())
            .collect(),
        Err(_) => return false,
    };
    PRIOR_INSTALL_MARKERS.iter().any(|m| names.contains(*m))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use tempfile::tempdir;

    // --- is_inside_cloud_sync ---

    #[test]
    fn cloud_detects_dropbox_child() {
        assert!(is_inside_cloud_sync(&PathBuf::from("/home/user/Dropbox/project")));
    }
    #[test]
    fn cloud_detects_dropbox_itself() {
        assert!(is_inside_cloud_sync(&PathBuf::from("/home/user/dropbox")));
    }
    #[test]
    fn cloud_detects_onedrive() {
        assert!(is_inside_cloud_sync(&PathBuf::from("/home/user/OneDrive/docs")));
    }
    #[test]
    fn cloud_detects_googledrive_macos() {
        assert!(is_inside_cloud_sync(&PathBuf::from(
            "/Users/user/Library/CloudStorage/GoogleDrive-user@gmail.com/MyDrive/data"
        )));
    }
    #[test]
    fn cloud_detects_iclouddrive_macos() {
        assert!(is_inside_cloud_sync(&PathBuf::from(
            "/Users/user/Library/CloudStorage/iCloudDrive/Documents"
        )));
    }
    #[test]
    fn cloud_ignores_normal_paths() {
        assert!(!is_inside_cloud_sync(&PathBuf::from("/home/user/NodusBackup")));
        assert!(!is_inside_cloud_sync(&PathBuf::from("/home/user/Documents/work")));
    }

    // --- has_prior_install ---

    #[test]
    fn prior_detects_nodus_db() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("nodus.db"), b"").unwrap();
        assert!(has_prior_install(dir.path()));
    }
    #[test]
    fn prior_detects_objects_dir() {
        let dir = tempdir().unwrap();
        std::fs::create_dir(dir.path().join("objects")).unwrap();
        assert!(has_prior_install(dir.path()));
    }
    #[test]
    fn prior_clean_dir() {
        let dir = tempdir().unwrap();
        assert!(!has_prior_install(dir.path()));
    }
    #[test]
    fn prior_nonexistent_path() {
        assert!(!has_prior_install(Path::new("/no/such/path/xyz_nodus_test")));
    }

    // --- is_writable ---

    #[test]
    fn writable_normal_dir() {
        let dir = tempdir().unwrap();
        assert!(is_writable(dir.path()));
    }
    #[test]
    fn writable_nonexistent_false() {
        assert!(!is_writable(Path::new("/no/such/path/xyz_nodus_test")));
    }
    #[test]
    fn writable_file_not_dir_false() {
        let dir = tempdir().unwrap();
        let f = dir.path().join("f.txt");
        std::fs::write(&f, b"x").unwrap();
        assert!(!is_writable(&f));
    }

    // --- ensure_dir ---

    #[test]
    fn ensure_creates_nested() {
        let dir = tempdir().unwrap();
        let nested = dir.path().join("a/b/c");
        assert!(!nested.exists());
        ensure_dir(&nested).unwrap();
        assert!(nested.is_dir());
    }
    #[test]
    fn ensure_existing_is_noop() {
        let dir = tempdir().unwrap();
        assert!(ensure_dir(dir.path()).is_ok());
    }

    // --- longpath_starts_with ---

    #[test]
    fn longpath_descendant() {
        assert!(longpath_starts_with(
            &PathBuf::from("/foo/bar/baz"),
            &PathBuf::from("/foo/bar"),
        ));
    }
    #[test]
    fn longpath_equal() {
        let p = PathBuf::from("/foo/bar");
        assert!(longpath_starts_with(&p, &p));
    }
    #[test]
    fn longpath_unrelated() {
        assert!(!longpath_starts_with(
            &PathBuf::from("/foo/bar"),
            &PathBuf::from("/baz"),
        ));
    }
    #[test]
    fn longpath_no_false_string_prefix() {
        // "/foo/bar" must NOT match mount "/foo/b" — component boundary matters
        assert!(!longpath_starts_with(
            &PathBuf::from("/foo/bar"),
            &PathBuf::from("/foo/b"),
        ));
    }
}

