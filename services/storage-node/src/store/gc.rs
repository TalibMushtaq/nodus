//! Garbage collection background job (§29a, ADR-0005).
//!
//! Prunes:
//! 1. Old file versions beyond `max_versions` (5) and older than `max_version_age_days` (30).
//! 2. Unreferenced storage objects on disk and in DB after versions are deleted.
//! 3. Expired tombstones older than `tombstone_retention_days` (90).

use std::fs;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use chrono::{DateTime, Utc};

use super::layout;
use super::write::ObjectStore;

/// Configuration for the garbage collection policy.
#[derive(Debug, Clone)]
pub struct GcConfig {
    /// Maximum number of recent versions to keep per file (default: 5).
    pub max_versions: usize,
    /// Maximum age in days for keeping versions beyond `max_versions` (default: 30).
    pub max_version_age_days: i64,
    /// Number of days to retain tombstones before compaction (default: 90).
    pub tombstone_retention_days: i64,
}

impl Default for GcConfig {
    fn default() -> Self {
        Self {
            max_versions: 5,
            max_version_age_days: 30,
            tombstone_retention_days: 90,
        }
    }
}

/// Summary report of actions performed during a garbage collection cycle.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct GcReport {
    pub versions_pruned: usize,
    pub objects_deleted: usize,
    pub tombstones_compacted: usize,
}

/// Run a single garbage collection cycle against the given `ObjectStore`.
pub async fn run_gc(store: &ObjectStore, cfg: &GcConfig) -> anyhow::Result<GcReport> {
    let mut report = GcReport::default();
    let pool = store.pool();
    let now = Utc::now();

    // ── Step 1: Version Pruning ────────────────────────────────────────────
    let file_ids: Vec<(String,)> = sqlx::query_as("SELECT DISTINCT file_id FROM file_versions")
        .fetch_all(pool)
        .await
        .context("fetching distinct file_ids for GC")?;

    for (file_id,) in file_ids {
        // Fetch versions ordered newest to oldest
        let versions: Vec<(i64, String)> = sqlx::query_as(
            "SELECT version_number, created_at FROM file_versions WHERE file_id = ? ORDER BY version_number DESC"
        )
        .bind(&file_id)
        .fetch_all(pool)
        .await
        .context("fetching versions for file")?;

        let max_age_duration = chrono::Duration::days(cfg.max_version_age_days);

        for (rank, (version_num, created_at_str)) in versions.into_iter().enumerate() {
            let rank_1based = rank + 1;
            let within_version_limit = rank_1based <= cfg.max_versions;

            let parsed_created_at = DateTime::parse_from_rfc3339(&created_at_str)
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or(now);

            let age = now.signed_duration_since(parsed_created_at);
            let within_age_limit = age <= max_age_duration;

            // Retain if either condition is met (whichever retains more, per ADR-0005)
            if !within_version_limit && !within_age_limit {
                // Prune this version
                prune_version(store, &file_id, version_num, &mut report).await?;
            }
        }
    }

    // ── Step 2: Purge tombstoned entities past retention ───────────────────
    // A tombstone only records the deletion; the data must be removed here or
    // a deleted file's objects stay on disk forever (their shard rows keep them
    // referenced, so the orphan sweep never collects them).
    let tombstone_cutoff =
        (now - chrono::Duration::days(cfg.tombstone_retention_days)).to_rfc3339();
    let expired: Vec<(String, String)> =
        sqlx::query_as("SELECT entity_type, entity_id FROM tombstones WHERE deleted_at < ?")
            .bind(&tombstone_cutoff)
            .fetch_all(pool)
            .await
            .context("fetching expired tombstones")?;
    for (entity_type, entity_id) in &expired {
        if entity_type == "file" {
            purge_file(store, entity_id).await?;
        } else {
            purge_folder(store, entity_id).await?;
        }
    }

    // ── Step 3: Tombstone Compaction ───────────────────────────────────────
    let res = sqlx::query("DELETE FROM tombstones WHERE deleted_at < ?")
        .bind(&tombstone_cutoff)
        .execute(pool)
        .await
        .context("compacting tombstones")?;

    report.tombstones_compacted = res.rows_affected() as usize;

    Ok(report)
}

/// Permanently remove a file and every version/shard/object it references, and
/// the object files that become unreferenced. Used by the Relay's tombstone
/// purge command and by retention GC.
pub async fn purge_file(store: &ObjectStore, file_id: &str) -> anyhow::Result<()> {
    let pool = store.pool();
    let data_dir = store.data_dir();

    let object_ids: Vec<(String,)> =
        sqlx::query_as("SELECT DISTINCT object_id FROM shards WHERE file_id = ?")
            .bind(file_id)
            .fetch_all(pool)
            .await
            .context("fetching shard object_ids for purge")?;

    // file_versions deletion cascades to shards (FK ON DELETE CASCADE).
    sqlx::query("DELETE FROM file_versions WHERE file_id = ?")
        .bind(file_id)
        .execute(pool)
        .await
        .context("deleting file_versions for purge")?;
    sqlx::query("DELETE FROM files WHERE file_id = ?")
        .bind(file_id)
        .execute(pool)
        .await
        .context("deleting file row for purge")?;

    for (object_id,) in object_ids {
        let (ref_count,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM shards WHERE object_id = ?")
                .bind(&object_id)
                .fetch_one(pool)
                .await
                .context("counting remaining shard references during purge")?;
        if ref_count == 0 {
            sqlx::query("DELETE FROM storage_objects WHERE object_id = ?")
                .bind(&object_id)
                .execute(pool)
                .await
                .context("deleting storage_objects row during purge")?;
            let dest = layout::object_path(data_dir, &object_id);
            if dest.exists() {
                let _ = fs::remove_file(&dest);
            }
        }
    }
    Ok(())
}

/// Permanently remove a folder row (folders hold no objects of their own).
pub async fn purge_folder(store: &ObjectStore, folder_id: &str) -> anyhow::Result<()> {
    sqlx::query("DELETE FROM folders WHERE folder_id = ?")
        .bind(folder_id)
        .execute(store.pool())
        .await
        .context("deleting folder row for purge")?;
    Ok(())
}

async fn prune_version(
    store: &ObjectStore,
    file_id: &str,
    version_num: i64,
    report: &mut GcReport,
) -> anyhow::Result<()> {
    let pool = store.pool();
    let data_dir = store.data_dir();

    // 1. Gather all shard object_ids referenced by this version
    let object_ids: Vec<(String,)> = sqlx::query_as(
        "SELECT DISTINCT object_id FROM shards WHERE file_id = ? AND version_number = ?",
    )
    .bind(file_id)
    .bind(version_num)
    .fetch_all(pool)
    .await
    .context("fetching shard object_ids for pruned version")?;

    // 2. Delete version row (cascades to shards)
    sqlx::query("DELETE FROM file_versions WHERE file_id = ? AND version_number = ?")
        .bind(file_id)
        .bind(version_num)
        .execute(pool)
        .await
        .context("deleting pruned file_version")?;

    report.versions_pruned += 1;

    // 3. For each object_id, check if still referenced by ANY shard in DB
    for (object_id,) in object_ids {
        let (ref_count,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM shards WHERE object_id = ?")
                .bind(&object_id)
                .fetch_one(pool)
                .await
                .context("counting remaining shard references")?;

        if ref_count == 0 {
            // No other version references this physical object; delete it
            sqlx::query("DELETE FROM storage_objects WHERE object_id = ?")
                .bind(&object_id)
                .execute(pool)
                .await
                .context("deleting unreferenced storage_objects row")?;

            let dest = layout::object_path(data_dir, &object_id);
            if dest.exists() {
                let _ = fs::remove_file(&dest);
            }
            report.objects_deleted += 1;
        }
    }

    Ok(())
}

/// Spawns a background task running the GC job every `interval`.
pub fn spawn_gc_task(
    store: Arc<ObjectStore>,
    cfg: GcConfig,
    interval: Duration,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut timer = tokio::time::interval(interval);
        // Skip immediate first tick to allow startup and boot reconciliation to complete first
        timer.tick().await;

        loop {
            timer.tick().await;
            match run_gc(&store, &cfg).await {
                Ok(report) => {
                    if report.versions_pruned > 0
                        || report.objects_deleted > 0
                        || report.tombstones_compacted > 0
                    {
                        println!(
                            "[gc] completed: versions_pruned={}, objects_deleted={}, tombstones_compacted={}",
                            report.versions_pruned,
                            report.objects_deleted,
                            report.tombstones_compacted
                        );
                    }
                }
                Err(e) => {
                    eprintln!("[gc] error during run: {e}");
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
    async fn gc_prunes_versions_beyond_limit() {
        let dir = tempdir().unwrap();
        let pool = create_test_db(dir.path()).await;
        let store = ObjectStore::new(dir.path().to_path_buf(), pool.clone())
            .await
            .unwrap();

        let file_id = "test-file-1";
        let now = Utc::now();
        let old_time = (now - chrono::Duration::days(40)).to_rfc3339();

        sqlx::query("INSERT INTO files (file_id, created_at, updated_at) VALUES (?, ?, ?)")
            .bind(file_id)
            .bind(&old_time)
            .bind(&old_time)
            .execute(&pool)
            .await
            .unwrap();

        // Create 7 versions all 40 days old
        for v in 1..=7 {
            let data = format!("version-{v}-content");
            let hash = store.put(data.as_bytes()).await.unwrap();

            sqlx::query(
                "INSERT INTO file_versions (file_id, version_number, version_hash, shard_count, created_at) VALUES (?, ?, ?, 1, ?)"
            )
            .bind(file_id)
            .bind(v)
            .bind(&hash)
            .bind(&old_time)
            .execute(&pool)
            .await
            .unwrap();

            sqlx::query(
                "INSERT INTO shards (file_id, version_number, shard_index, object_id, size_bytes) VALUES (?, ?, 0, ?, ?)"
            )
            .bind(file_id)
            .bind(v)
            .bind(&hash)
            .bind(data.len() as i64)
            .execute(&pool)
            .await
            .unwrap();
        }

        let cfg = GcConfig {
            max_versions: 5,
            max_version_age_days: 30,
            tombstone_retention_days: 90,
        };

        let report = run_gc(&store, &cfg).await.unwrap();
        assert_eq!(report.versions_pruned, 2); // Versions 1 and 2 should be pruned
        assert_eq!(report.objects_deleted, 2);

        let remaining: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM file_versions WHERE file_id = ?")
                .bind(file_id)
                .fetch_one(&pool)
                .await
                .unwrap();

        assert_eq!(remaining.0, 5);
    }

    #[tokio::test]
    async fn gc_keeps_recent_versions_regardless_of_count() {
        let dir = tempdir().unwrap();
        let pool = create_test_db(dir.path()).await;
        let store = ObjectStore::new(dir.path().to_path_buf(), pool.clone())
            .await
            .unwrap();

        let file_id = "test-file-2";
        let now_str = Utc::now().to_rfc3339();

        sqlx::query("INSERT INTO files (file_id, created_at, updated_at) VALUES (?, ?, ?)")
            .bind(file_id)
            .bind(&now_str)
            .bind(&now_str)
            .execute(&pool)
            .await
            .unwrap();

        // Create 8 versions all created just now (within 30 days)
        for v in 1..=8 {
            let data = format!("v{v}");
            let hash = store.put(data.as_bytes()).await.unwrap();

            sqlx::query(
                "INSERT INTO file_versions (file_id, version_number, version_hash, shard_count, created_at) VALUES (?, ?, ?, 1, ?)"
            )
            .bind(file_id)
            .bind(v)
            .bind(&hash)
            .bind(&now_str)
            .execute(&pool)
            .await
            .unwrap();

            sqlx::query(
                "INSERT INTO shards (file_id, version_number, shard_index, object_id, size_bytes) VALUES (?, ?, 0, ?, ?)"
            )
            .bind(file_id)
            .bind(v)
            .bind(&hash)
            .bind(data.len() as i64)
            .execute(&pool)
            .await
            .unwrap();
        }

        let cfg = GcConfig::default();
        let report = run_gc(&store, &cfg).await.unwrap();
        assert_eq!(report.versions_pruned, 0);

        let remaining: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM file_versions WHERE file_id = ?")
                .bind(file_id)
                .fetch_one(&pool)
                .await
                .unwrap();

        assert_eq!(remaining.0, 8);
    }

    #[tokio::test]
    async fn gc_compacts_old_tombstones() {
        let dir = tempdir().unwrap();
        let pool = create_test_db(dir.path()).await;
        let store = ObjectStore::new(dir.path().to_path_buf(), pool.clone())
            .await
            .unwrap();

        let now = Utc::now();
        let old_time = (now - chrono::Duration::days(95)).to_rfc3339();
        let recent_time = (now - chrono::Duration::days(10)).to_rfc3339();

        sqlx::query("INSERT INTO tombstones (entity_type, entity_id, deleted_at) VALUES ('file', 'old-file', ?)")
            .bind(&old_time)
            .execute(&pool)
            .await
            .unwrap();

        sqlx::query("INSERT INTO tombstones (entity_type, entity_id, deleted_at) VALUES ('file', 'recent-file', ?)")
            .bind(&recent_time)
            .execute(&pool)
            .await
            .unwrap();

        let cfg = GcConfig::default();
        let report = run_gc(&store, &cfg).await.unwrap();
        assert_eq!(report.tombstones_compacted, 1);

        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM tombstones")
            .fetch_one(&pool)
            .await
            .unwrap();

        assert_eq!(count.0, 1);
    }

    #[tokio::test]
    async fn purge_file_removes_versions_shards_and_objects() {
        let dir = tempdir().unwrap();
        let pool = create_test_db(dir.path()).await;
        let store = ObjectStore::new(dir.path().to_path_buf(), pool.clone())
            .await
            .unwrap();

        let file_id = "purge-file";
        let now = Utc::now().to_rfc3339();
        sqlx::query("INSERT INTO files (file_id, created_at, updated_at) VALUES (?, ?, ?)")
            .bind(file_id)
            .bind(&now)
            .bind(&now)
            .execute(&pool)
            .await
            .unwrap();

        let data = b"purge-me";
        let object_id = store.put(data).await.unwrap();
        sqlx::query(
            "INSERT INTO file_versions (file_id, version_number, version_hash, shard_count, created_at) VALUES (?, 1, ?, 1, ?)",
        )
        .bind(file_id)
        .bind(&object_id)
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO shards (file_id, version_number, shard_index, object_id, size_bytes) VALUES (?, 1, 0, ?, ?)",
        )
        .bind(file_id)
        .bind(&object_id)
        .bind(data.len() as i64)
        .execute(&pool)
        .await
        .unwrap();

        purge_file(&store, file_id).await.unwrap();

        let files: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM files WHERE file_id = ?")
            .bind(file_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        let versions: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM file_versions WHERE file_id = ?")
                .bind(file_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        let objects: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM storage_objects WHERE object_id = ?")
                .bind(&object_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(files.0, 0);
        assert_eq!(versions.0, 0);
        assert_eq!(objects.0, 0);
        assert!(!layout::object_path(dir.path(), &object_id).exists());
    }

    #[tokio::test]
    async fn gc_purges_tombstoned_file_data() {
        let dir = tempdir().unwrap();
        let pool = create_test_db(dir.path()).await;
        let store = ObjectStore::new(dir.path().to_path_buf(), pool.clone())
            .await
            .unwrap();

        let file_id = "expired-file";
        let old = (Utc::now() - chrono::Duration::days(95)).to_rfc3339();
        sqlx::query("INSERT INTO files (file_id, created_at, updated_at) VALUES (?, ?, ?)")
            .bind(file_id)
            .bind(&old)
            .bind(&old)
            .execute(&pool)
            .await
            .unwrap();
        let object_id = store.put(b"expired-bytes").await.unwrap();
        sqlx::query(
            "INSERT INTO file_versions (file_id, version_number, version_hash, shard_count, created_at) VALUES (?, 1, ?, 1, ?)",
        )
        .bind(file_id)
        .bind(&object_id)
        .bind(&old)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO shards (file_id, version_number, shard_index, object_id, size_bytes) VALUES (?, 1, 0, ?, 16)",
        )
        .bind(file_id)
        .bind(&object_id)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO tombstones (entity_type, entity_id, deleted_at) VALUES ('file', ?, ?)",
        )
        .bind(file_id)
        .bind(&old)
        .execute(&pool)
        .await
        .unwrap();

        run_gc(&store, &GcConfig::default()).await.unwrap();

        let files: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM files WHERE file_id = ?")
            .bind(file_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        let objects: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM storage_objects WHERE object_id = ?")
                .bind(&object_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(files.0, 0);
        assert_eq!(objects.0, 0);
    }
}
