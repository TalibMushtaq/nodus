//! Physical reconciliation scan (§21) and repair actions (§21a).
//!
//! Reconciles SQLite metadata against actual files in `<data_dir>/objects/`.
//! - Missing on disk -> marked DEGRADED
//! - Hash mismatch (corruption) -> marked DEGRADED
//! - Orphan on disk (no DB row):
//!   - Within 24-hour grace period -> kept (pending)
//!   - Past 24-hour grace period -> deleted

use std::fs;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use anyhow::Context;
use walkdir::WalkDir;

use super::layout;
use super::write::ObjectStore;

/// Summary report of actions performed during a reconciliation scan.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ReconcileReport {
    /// Objects registered as STORED in SQLite but not found on disk.
    pub missing: Vec<String>,
    /// Objects on disk whose BLAKE3 content hash does not match their object_id.
    pub corrupted: Vec<String>,
    /// Orphaned files on disk (no DB row) older than 24h that were deleted.
    pub orphans_deleted: Vec<String>,
    /// Orphaned files on disk within the 24h grace period that were left in place.
    pub orphans_pending: Vec<String>,
}

/// Run a full reconciliation scan over the given `ObjectStore`.
///
/// This function does not block normal operations (designed to be run in a spawned task).
pub async fn run_reconciliation(store: &ObjectStore) -> anyhow::Result<ReconcileReport> {
    let mut report = ReconcileReport::default();
    let data_dir = store.data_dir();
    let pool = store.pool();

    // ── Phase A: Metadata -> Disk ──────────────────────────────────────────
    let rows: Vec<(String,)> =
        sqlx::query_as("SELECT object_id FROM storage_objects WHERE status = 'STORED'")
            .fetch_all(pool)
            .await
            .context("fetching storage_objects for reconciliation")?;

    for (object_id,) in rows {
        let path = layout::object_path(data_dir, &object_id);
        if !path.exists() {
            // Marked STORED in DB, missing on disk -> DEGRADED
            sqlx::query("UPDATE storage_objects SET status = 'DEGRADED' WHERE object_id = ?")
                .bind(&object_id)
                .execute(pool)
                .await
                .context("marking missing object DEGRADED")?;

            report.missing.push(object_id);
        } else {
            // Check hash integrity
            match fs::read(&path) {
                Ok(bytes) => {
                    let actual_hash = blake3::hash(&bytes).to_hex().to_string();
                    if actual_hash != object_id {
                        sqlx::query(
                            "UPDATE storage_objects SET status = 'DEGRADED' WHERE object_id = ?",
                        )
                        .bind(&object_id)
                        .execute(pool)
                        .await
                        .context("marking corrupted object DEGRADED")?;

                        report.corrupted.push(object_id);
                    }
                }
                Err(e) => {
                    eprintln!(
                        "[reconcile] warning: failed to read {} for integrity check: {e}",
                        path.display()
                    );
                }
            }
        }
    }

    // ── Phase B: Disk -> Metadata (Orphan scan) ────────────────────────────
    let objects_root = layout::objects_dir(data_dir);
    if objects_root.exists() {
        let grace_period = Duration::from_secs(24 * 3600); // 24 hours per ADR-0005

        for entry in WalkDir::new(&objects_root)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            if !entry.file_type().is_file() {
                continue;
            }

            let file_name = entry.file_name().to_string_lossy().to_string();
            // In layout, the filename is the full BLAKE3 hex hash
            let (count,): (i64,) =
                sqlx::query_as("SELECT COUNT(*) FROM storage_objects WHERE object_id = ?")
                    .bind(&file_name)
                    .fetch_one(pool)
                    .await
                    .context("checking object_id presence in storage_objects")?;

            if count == 0 {
                // Orphan candidate
                let modified = entry
                    .metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .unwrap_or_else(SystemTime::now);

                let age = SystemTime::now()
                    .duration_since(modified)
                    .unwrap_or(Duration::ZERO);

                if age >= grace_period {
                    let path = entry.path();
                    if let Err(e) = fs::remove_file(path) {
                        eprintln!(
                            "[reconcile] warning: failed to remove orphan {}: {e}",
                            path.display()
                        );
                    } else {
                        report.orphans_deleted.push(file_name);
                    }
                } else {
                    report.orphans_pending.push(file_name);
                }
            }
        }
    }

    Ok(report)
}

/// Spawns a background task that runs reconciliation at boot and periodically every `interval`.
pub fn spawn_reconcile_task(
    store: Arc<ObjectStore>,
    interval: Duration,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        // Run immediately on boot
        match run_reconciliation(&store).await {
            Ok(report) => {
                if !report.missing.is_empty()
                    || !report.corrupted.is_empty()
                    || !report.orphans_deleted.is_empty()
                {
                    println!(
                        "[reconcile] boot scan found divergence: missing={}, corrupted={}, orphans_deleted={}, orphans_pending={}",
                        report.missing.len(),
                        report.corrupted.len(),
                        report.orphans_deleted.len(),
                        report.orphans_pending.len()
                    );
                } else {
                    println!("[reconcile] boot scan clean (no divergence)");
                }
            }
            Err(e) => {
                eprintln!("[reconcile] boot scan error: {e}");
            }
        }

        let mut timer = tokio::time::interval(interval);
        // The first tick completes immediately in tokio interval, so consume it
        timer.tick().await;

        loop {
            timer.tick().await;
            match run_reconciliation(&store).await {
                Ok(report) => {
                    println!(
                        "[reconcile] periodic scan completed: missing={}, corrupted={}, orphans_deleted={}, orphans_pending={}",
                        report.missing.len(),
                        report.corrupted.len(),
                        report.orphans_deleted.len(),
                        report.orphans_pending.len()
                    );
                }
                Err(e) => {
                    eprintln!("[reconcile] periodic scan error: {e}");
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    async fn create_test_db(data_dir: &std::path::Path) -> sqlx::SqlitePool {
        crate::db::open(data_dir).await.unwrap()
    }

    #[tokio::test]
    async fn missing_object_marked_degraded() {
        let dir = tempdir().unwrap();
        let pool = create_test_db(dir.path()).await;
        let store = ObjectStore::new(dir.path().to_path_buf(), pool.clone())
            .await
            .unwrap();

        let object_id = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let now = chrono::Utc::now().to_rfc3339();

        // Insert row in DB, but don't create file
        sqlx::query(
            "INSERT INTO storage_objects (object_id, size_bytes, status, created_at) VALUES (?, 100, 'STORED', ?)"
        )
        .bind(object_id)
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();

        let report = run_reconciliation(&store).await.unwrap();
        assert!(report.missing.contains(&object_id.to_string()));

        let (status,): (String,) =
            sqlx::query_as("SELECT status FROM storage_objects WHERE object_id = ?")
                .bind(object_id)
                .fetch_one(&pool)
                .await
                .unwrap();

        assert_eq!(status, "DEGRADED");
    }

    #[tokio::test]
    async fn corrupted_object_marked_degraded() {
        let dir = tempdir().unwrap();
        let pool = create_test_db(dir.path()).await;
        let store = ObjectStore::new(dir.path().to_path_buf(), pool.clone())
            .await
            .unwrap();

        let valid_data = b"correct shard data";
        let hash = store.put(valid_data).await.unwrap();

        // Overwrite file with corrupt data
        let dest = layout::object_path(dir.path(), &hash);
        fs::write(&dest, b"tampered corrupt data").unwrap();

        let report = run_reconciliation(&store).await.unwrap();
        assert!(report.corrupted.contains(&hash));

        let (status,): (String,) =
            sqlx::query_as("SELECT status FROM storage_objects WHERE object_id = ?")
                .bind(&hash)
                .fetch_one(&pool)
                .await
                .unwrap();

        assert_eq!(status, "DEGRADED");
    }

    #[tokio::test]
    async fn orphan_within_grace_kept() {
        let dir = tempdir().unwrap();
        let pool = create_test_db(dir.path()).await;
        let store = ObjectStore::new(dir.path().to_path_buf(), pool.clone())
            .await
            .unwrap();

        let orphan_data = b"orphan file content";
        let hash = blake3::hash(orphan_data).to_hex().to_string();
        let dest = layout::object_path(dir.path(), &hash);
        fs::create_dir_all(dest.parent().unwrap()).unwrap();
        fs::write(&dest, orphan_data).unwrap();

        let report = run_reconciliation(&store).await.unwrap();
        assert!(report.orphans_pending.contains(&hash));
        assert!(dest.exists());
    }

    #[tokio::test]
    async fn orphan_past_grace_deleted() {
        let dir = tempdir().unwrap();
        let pool = create_test_db(dir.path()).await;
        let store = ObjectStore::new(dir.path().to_path_buf(), pool.clone())
            .await
            .unwrap();

        let orphan_data = b"old orphan file content";
        let hash = blake3::hash(orphan_data).to_hex().to_string();
        let dest = layout::object_path(dir.path(), &hash);
        fs::create_dir_all(dest.parent().unwrap()).unwrap();
        fs::write(&dest, orphan_data).unwrap();

        // Set modification time to 25 hours ago
        let old_time = SystemTime::now() - Duration::from_secs(25 * 3600);
        let file = fs::File::options().write(true).open(&dest).unwrap();
        file.set_times(fs::FileTimes::new().set_modified(old_time))
            .unwrap();

        let report = run_reconciliation(&store).await.unwrap();
        assert!(report.orphans_deleted.contains(&hash));
        assert!(!dest.exists());
    }
}
