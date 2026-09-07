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
///
/// When a `TransferManager` is provided, DEGRADED shards found by a scan are
/// submitted for re-fetch-from-peer repair (§21a) through the manager, so the
/// repair inherits the same fallback/backoff/path-cache behavior as any other
/// transfer.
pub fn spawn_reconcile_task(
    store: Arc<ObjectStore>,
    interval: Duration,
    manager: Option<crate::transfer::manager::TransferManager>,
) -> tokio::task::JoinHandle<()> {
    let run_repairs =
        async |store: &ObjectStore, manager: &Option<crate::transfer::manager::TransferManager>| {
            let manager = match manager {
                Some(m) => m,
                None => return,
            };
            // Best-effort repair: failures are logged, objects stay DEGRADED,
            // and the next scan re-attempts them.
            let shards = match find_degraded_shards(store).await {
                Ok(s) if !s.is_empty() => s,
                Ok(_) => return,
                Err(e) => {
                    eprintln!("[reconcile] repair scan error: {e}");
                    return;
                }
            };
            let peers = match crate::store::reconcile::trusted_peers_for_repair(store).await {
                Ok(p) if !p.is_empty() => p,
                Ok(_) => {
                    eprintln!(
                        "[reconcile] no trusted peers for repair; leaving {} shards DEGRADED",
                        shards.len()
                    );
                    return;
                }
                Err(e) => {
                    eprintln!("[reconcile] trusted peer query error: {e}");
                    return;
                }
            };
            println!(
                "[reconcile] submitting repair for {} degraded shards across {} trusted peers",
                shards.len(),
                peers.len()
            );
            for rx in submit_repairs(manager, shards, peers) {
                match rx.await {
                    Ok(r) if r.success => {
                        // The object_id is the BLAKE3 hash of the shard bytes;
                        // verify before touching disk so a malicious/wrong peer
                        // can't plant arbitrary content under a known hash.
                        // Failures leave the object DEGRADED for the next scan.
                        if blake3::hash(&r.data).to_hex().to_string() != r.object_id {
                            eprintln!(
                                "[reconcile] repair fetch for {} returned bytes not matching the object_id; ignoring",
                                r.object_id
                            );
                            continue;
                        }
                        match restore_object(store, &r.object_id, &r.data).await {
                            Ok(()) => println!(
                                "[reconcile] repair restored object {} via {:?} (transfer={})",
                                r.object_id, r.path, r.transfer_id
                            ),
                            Err(e) => eprintln!(
                                "[reconcile] repair obtained valid bytes for {} but restore failed: {e:#}",
                                r.object_id
                            ),
                        }
                    }
                    Ok(r) => println!(
                        "[reconcile] repair failed for transfer {}: {}",
                        r.transfer_id,
                        r.error.unwrap_or_else(|| "unknown error".to_string())
                    ),
                    Err(_) => {
                        eprintln!("[reconcile] repair task aborted before reporting")
                    }
                }
            }
        };

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
        run_repairs(&store, &manager).await;

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
            run_repairs(&store, &manager).await;
        }
    })
}

/// A shard whose backing object is DEGRADED and eligible for repair. Only the
/// `object_id` matters for restoration: `fetch_shard` targets it as the content
/// hash, and the write-back restores under it.
#[derive(Debug, Clone)]
pub struct DegradedShard {
    pub object_id: String,
}

/// Find all storage objects that are DEGRADED (missing or corrupted) and still
/// referenced by a shard, so the repair path knows which objects need
/// re-fetching from a peer (§21a re-fetch-from-peer repair action).
pub async fn find_degraded_shards(store: &ObjectStore) -> anyhow::Result<Vec<DegradedShard>> {
    let pool = store.pool();
    let rows: Vec<(String,)> = sqlx::query_as(
        r#"
        SELECT DISTINCT s.object_id
        FROM shards s
        JOIN storage_objects o ON o.object_id = s.object_id
        WHERE o.status = 'DEGRADED'
        "#,
    )
    .fetch_all(pool)
    .await
    .context("querying DEGRADED shards for repair")?;

    Ok(rows
        .into_iter()
        .map(|(object_id,)| DegradedShard { object_id })
        .collect())
}

/// Trusted peer node IDs ordered for repair: path-cache hits first, then by
/// last successful transfer recency. Brute-force try-all per the v1 spec —
/// no peer location index (see spec §"Re-fetch-from-peer").
pub async fn trusted_peers_for_repair(
    store: &ObjectStore,
) -> anyhow::Result<Vec<(String, Option<String>)>> {
    let pool = store.pool();
    let rows: Vec<(String, Option<String>)> = sqlx::query_as(
        r#"
        SELECT node_id, last_successful_path
        FROM trusted_nodes
        ORDER BY (last_successful_path IS NOT NULL) DESC, last_success_at DESC
        "#,
    )
    .fetch_all(pool)
    .await
    .context("querying trusted peers for repair")?;
    Ok(rows)
}

/// Submit one repair fetch per DEGRADED shard through the Transfer Manager,
/// to the best-candidate peer only. `peers` arrives ordered (path-cache hit
/// first, then last_success_at desc), so the first entry is the most likely
/// holder of the shard.
///
/// ponytail: v1 submits a single best-peer fetch instead of fanning out to
/// every peer — the executor has no peer-fallback loop, so N×M fetches would
/// merely burn pool slots on duplicative requests for the same shard.
/// Failed repairs are retried by the next reconciliation scan; add sequential
/// peer fallback (try the next peer after the first fails) once a node→node
/// receive path exists to feed that loop.
pub fn submit_repairs(
    manager: &crate::transfer::manager::TransferManager,
    degraded: Vec<DegradedShard>,
    peers: Vec<(String, Option<String>)>,
) -> Vec<tokio::sync::oneshot::Receiver<crate::transfer::types::TransferResult>> {
    let mut receivers = Vec::new();
    let Some((peer, _path)) = peers.first() else {
        return receivers;
    };
    for shard in degraded {
        receivers.push(manager.fetch_shard(peer, &shard.object_id));
    }
    receivers
}

/// Write restored repair bytes to disk atomically and flip the object's row
/// DEGRADED → STORED. The caller hash-verifies `bytes` before calling.
async fn restore_object(store: &ObjectStore, object_id: &str, bytes: &[u8]) -> anyhow::Result<()> {
    let dest = layout::object_path(store.data_dir(), object_id);
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("creating object directory {}", parent.display()))?;
    }
    let tmp = dest.with_extension("repair.tmp");
    fs::write(&tmp, bytes)?;
    // Same-directory rename is atomic within the filesystem: a crash mid-way
    // leaves either the old state (missing file) or the new file, never a
    // torn write.
    fs::rename(&tmp, &dest)?;
    sqlx::query("UPDATE storage_objects SET status = 'STORED' WHERE object_id = ?")
        .bind(object_id)
        .execute(store.pool())
        .await
        .context("marking repaired object STORED")?;
    Ok(())
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

    // ── §21a re-fetch-from-peer: DEGRADED shard → trusted-peer repair ──

    /// Seeds a DEGRADED shard + trusted peers and exercises the full repair
    /// selection path: what the reconcile scan considers broken, which peers
    /// it would ask (path-cache hits first, then recency), and that the repair
    /// fan-out produces one fetch per (shard, peer).
    #[tokio::test]
    async fn degraded_shards_select_trusted_peers_for_repair() {
        let dir = tempdir().unwrap();
        let pool = create_test_db(dir.path()).await;
        let now = chrono::Utc::now().to_rfc3339();

        // Minimal file -> version -> shard -> DEGRADED object chain.
        sqlx::query("INSERT INTO files (file_id, created_at, updated_at) VALUES ('f1', ?, ?)")
            .bind(&now)
            .bind(&now)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO file_versions (file_id, version_number, version_hash, shard_count, created_at) VALUES ('f1', 1, 'vh', 2, ?)",
        )
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO storage_objects (object_id, size_bytes, status, created_at) VALUES (?, 100, 'DEGRADED', ?)",
        )
        .bind("obj-degraded")
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO shards (file_id, version_number, shard_index, object_id, size_bytes) VALUES ('f1', 1, 0, 'obj-degraded', 100)",
        )
        .execute(&pool)
        .await
        .unwrap();

        // Two trusted peers: one with a fresh cached path, one without.
        sqlx::query("INSERT INTO trusted_nodes (node_id, public_key_bytes, created_at, last_successful_path, last_success_at) VALUES (?, ?, ?, 'relay_signaling', ?)")
            .bind("peer-cached")
            .bind(vec![0u8; 32])
            .bind(&now)
            .bind(&now)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO trusted_nodes (node_id, public_key_bytes, created_at) VALUES (?, ?, ?)",
        )
        .bind("peer-plain")
        .bind(vec![0u8; 32])
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();

        let store = ObjectStore::new(dir.path().to_path_buf(), pool.clone())
            .await
            .unwrap();

        let degraded = find_degraded_shards(&store).await.unwrap();
        assert_eq!(degraded.len(), 1);
        assert_eq!(degraded[0].object_id, "obj-degraded");

        // peer-cached (has last_successful_path) ranks ahead of peer-plain.
        let peers = trusted_peers_for_repair(&store).await.unwrap();
        assert_eq!(peers[0].0, "peer-cached");
        assert_eq!(peers[0].1.as_deref(), Some("relay_signaling"));
        assert_eq!(peers[1].0, "peer-plain");
        assert_eq!(peers[1].1, None);

        // One DEGRADED shard × 2 peers: v1 submits one fetch to the best peer
        // only (peer-cached ranks first), not both.
        let identity_dir = tempdir().unwrap();
        let identity =
            std::sync::Arc::new(crate::identity::load_or_generate(identity_dir.path()).unwrap());
        let manager = crate::transfer::manager::TransferManager::new(
            crate::transfer::config::TransferConfig::default(),
            crate::transfer::cache::SqlitePathCache::new(pool.clone()),
            std::sync::Arc::new(crate::transfer::node_attempter::NodePathAttempter::new(
                pool,
                std::sync::Arc::new(store),
                identity,
            )),
        );
        let receivers = submit_repairs(&manager, degraded, peers);
        assert_eq!(receivers.len(), 1);
    }
}
