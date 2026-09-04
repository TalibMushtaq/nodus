//! Atomic write operations, retrieval, deletion, and crash recovery for storage objects.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, bail};
use sqlx::SqlitePool;

use super::layout;

/// Content-addressed object store backed by on-disk files and SQLite metadata.
#[derive(Clone)]
pub struct ObjectStore {
    data_dir: PathBuf,
    pool: SqlitePool,
}

impl ObjectStore {
    /// Initialize the object store, ensuring `objects/` and `temp/` directories exist.
    pub async fn new(data_dir: PathBuf, pool: SqlitePool) -> anyhow::Result<Self> {
        let objects_dir = layout::objects_dir(&data_dir);
        let temp_dir = layout::temp_dir(&data_dir);

        fs::create_dir_all(&objects_dir)
            .with_context(|| format!("creating objects dir: {}", objects_dir.display()))?;
        fs::create_dir_all(&temp_dir)
            .with_context(|| format!("creating temp dir: {}", temp_dir.display()))?;

        Ok(Self { data_dir, pool })
    }

    /// Returns a reference to the store data directory.
    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    /// Returns a reference to the SQLite database pool.
    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    /// Write raw encrypted bytes to the content-addressed store.
    ///
    /// The write protocol:
    /// 1. Compute BLAKE3 hash of bytes.
    /// 2. If object already exists on disk, ensure DB state is STORED and return hash.
    /// 3. Otherwise write to `<data_dir>/temp/<uuid>`.
    /// 4. `sync_all` the temp file for durability.
    /// 5. Atomically rename the temp file to `<data_dir>/objects/<ab>/<hash>`.
    /// 6. Insert or update `storage_objects` in SQLite to 'STORED'.
    #[allow(dead_code)]
    pub async fn put(&self, bytes: &[u8]) -> anyhow::Result<String> {
        let hash_hex = blake3::hash(bytes).to_hex().to_string();
        let dest = layout::object_path(&self.data_dir, &hash_hex);
        let now = chrono::Utc::now().to_rfc3339();
        let size = bytes.len() as i64;

        if dest.exists() {
            // Already on disk; ensure metadata matches.
            sqlx::query(
                r#"
                INSERT INTO storage_objects (object_id, size_bytes, status, created_at)
                VALUES (?, ?, 'STORED', ?)
                ON CONFLICT(object_id) DO UPDATE SET
                    status = 'STORED',
                    size_bytes = excluded.size_bytes
                "#,
            )
            .bind(&hash_hex)
            .bind(size)
            .bind(&now)
            .execute(&self.pool)
            .await
            .context("updating existing storage_objects row to STORED")?;

            return Ok(hash_hex);
        }

        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("creating bucket dir: {}", parent.display()))?;
        }

        let temp_id = uuid::Uuid::new_v4().to_string();
        let temp_file_path = layout::temp_path(&self.data_dir, &temp_id);

        // Write to temp file with sync
        {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp_file_path)
                .with_context(|| format!("creating temp file: {}", temp_file_path.display()))?;

            file.write_all(bytes)
                .with_context(|| format!("writing to temp file: {}", temp_file_path.display()))?;

            file.sync_all()
                .with_context(|| format!("syncing temp file: {}", temp_file_path.display()))?;
        }

        // Atomic rename
        if let Err(e) = fs::rename(&temp_file_path, &dest) {
            let _ = fs::remove_file(&temp_file_path);
            return Err(e).with_context(|| {
                format!(
                    "renaming {} to {}",
                    temp_file_path.display(),
                    dest.display()
                )
            });
        }

        // Commit metadata
        sqlx::query(
            r#"
            INSERT INTO storage_objects (object_id, size_bytes, status, created_at)
            VALUES (?, ?, 'STORED', ?)
            ON CONFLICT(object_id) DO UPDATE SET
                status = 'STORED',
                size_bytes = excluded.size_bytes
            "#,
        )
        .bind(&hash_hex)
        .bind(size)
        .bind(&now)
        .execute(&self.pool)
        .await
        .context("inserting storage_objects row")?;

        Ok(hash_hex)
    }

    /// Read raw bytes for an object by its BLAKE3 hash.
    ///
    /// Verifies content hash upon reading. If mismatched, marks status in SQLite as DEGRADED.
    #[allow(dead_code)]
    pub async fn get(&self, hash_hex: &str) -> anyhow::Result<Vec<u8>> {
        let dest = layout::object_path(&self.data_dir, hash_hex);
        if !dest.exists() {
            bail!("object {} does not exist on disk", hash_hex);
        }

        let bytes =
            fs::read(&dest).with_context(|| format!("reading object from {}", dest.display()))?;

        let actual_hash = blake3::hash(&bytes).to_hex().to_string();
        if actual_hash != hash_hex {
            // Mark DEGRADED in DB
            let _ =
                sqlx::query("UPDATE storage_objects SET status = 'DEGRADED' WHERE object_id = ?")
                    .bind(hash_hex)
                    .execute(&self.pool)
                    .await;

            bail!(
                "object integrity failure for {}: actual hash {}",
                hash_hex,
                actual_hash
            );
        }

        Ok(bytes)
    }

    /// Check if an object exists on disk at its content-addressed path.
    #[allow(dead_code)]
    pub fn exists(&self, hash_hex: &str) -> bool {
        layout::object_path(&self.data_dir, hash_hex).exists()
    }

    /// Delete an object from disk and remove its row from `storage_objects`.
    #[allow(dead_code)]
    pub async fn delete(&self, hash_hex: &str) -> anyhow::Result<()> {
        let dest = layout::object_path(&self.data_dir, hash_hex);
        if dest.exists() {
            fs::remove_file(&dest)
                .with_context(|| format!("removing object file {}", dest.display()))?;
        }

        sqlx::query("DELETE FROM storage_objects WHERE object_id = ?")
            .bind(hash_hex)
            .execute(&self.pool)
            .await
            .context("deleting storage_objects row")?;

        Ok(())
    }

    /// Recover any temp files left by an interrupted or crashed write.
    ///
    /// Scans `<data_dir>/temp/`:
    /// - If the target content-addressed file already exists, deletes the temp file.
    /// - If not, attempts to complete the rename to `<data_dir>/objects/<prefix>/<hash>`.
    ///   If corrupted or failed, removes the temp file.
    pub async fn recover_temp_writes(&self) -> anyhow::Result<()> {
        let temp_dir = layout::temp_dir(&self.data_dir);
        if !temp_dir.exists() {
            return Ok(());
        }

        let entries = match fs::read_dir(&temp_dir) {
            Ok(entries) => entries,
            Err(e) => {
                eprintln!("[store] warning: failed to read temp dir: {e}");
                return Ok(());
            }
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Ok(bytes) = fs::read(&path) {
                    let hash_hex = blake3::hash(&bytes).to_hex().to_string();
                    let dest = layout::object_path(&self.data_dir, &hash_hex);

                    if dest.exists() {
                        let _ = fs::remove_file(&path);
                    } else {
                        if let Some(parent) = dest.parent() {
                            let _ = fs::create_dir_all(parent);
                        }
                        if fs::rename(&path, &dest).is_ok() {
                            let now = chrono::Utc::now().to_rfc3339();
                            let size = bytes.len() as i64;
                            let _ = sqlx::query(
                                r#"
                                INSERT INTO storage_objects (object_id, size_bytes, status, created_at)
                                VALUES (?, ?, 'STORED', ?)
                                ON CONFLICT(object_id) DO UPDATE SET
                                    status = 'STORED',
                                    size_bytes = excluded.size_bytes
                                "#,
                            )
                            .bind(&hash_hex)
                            .bind(size)
                            .bind(&now)
                            .execute(&self.pool)
                            .await;
                        } else {
                            let _ = fs::remove_file(&path);
                        }
                    }
                } else {
                    let _ = fs::remove_file(&path);
                }
            }
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    async fn create_test_db(data_dir: &Path) -> SqlitePool {
        crate::db::open(data_dir).await.unwrap()
    }

    #[tokio::test]
    async fn put_then_get_roundtrip() {
        let dir = tempdir().unwrap();
        let pool = create_test_db(dir.path()).await;
        let store = ObjectStore::new(dir.path().to_path_buf(), pool)
            .await
            .unwrap();

        let data = b"encrypted shard payload test";
        let hash = store.put(data).await.unwrap();

        assert_eq!(hash, blake3::hash(data).to_hex().to_string());
        assert!(store.exists(&hash));

        let retrieved = store.get(&hash).await.unwrap();
        assert_eq!(retrieved, data);
    }

    #[tokio::test]
    async fn put_deduplicates_identical_content() {
        let dir = tempdir().unwrap();
        let pool = create_test_db(dir.path()).await;
        let store = ObjectStore::new(dir.path().to_path_buf(), pool)
            .await
            .unwrap();

        let data = b"duplicate test payload";
        let hash1 = store.put(data).await.unwrap();
        let hash2 = store.put(data).await.unwrap();

        assert_eq!(hash1, hash2);

        let row: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM storage_objects WHERE object_id = ?")
                .bind(&hash1)
                .fetch_one(store.pool())
                .await
                .unwrap();

        assert_eq!(row.0, 1);
    }

    #[tokio::test]
    async fn delete_removes_file_and_db_row() {
        let dir = tempdir().unwrap();
        let pool = create_test_db(dir.path()).await;
        let store = ObjectStore::new(dir.path().to_path_buf(), pool)
            .await
            .unwrap();

        let data = b"delete me";
        let hash = store.put(data).await.unwrap();
        assert!(store.exists(&hash));

        store.delete(&hash).await.unwrap();
        assert!(!store.exists(&hash));

        let row: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM storage_objects WHERE object_id = ?")
                .bind(&hash)
                .fetch_one(store.pool())
                .await
                .unwrap();

        assert_eq!(row.0, 0);
    }

    #[tokio::test]
    async fn temp_cleanup_on_boot_redundant() {
        let dir = tempdir().unwrap();
        let pool = create_test_db(dir.path()).await;
        let store = ObjectStore::new(dir.path().to_path_buf(), pool)
            .await
            .unwrap();

        let data = b"some data";
        let hash = store.put(data).await.unwrap();

        // Seed a temp file with same data
        let temp_file = layout::temp_path(dir.path(), "crash-temp-1");
        fs::write(&temp_file, data).unwrap();
        assert!(temp_file.exists());

        store.recover_temp_writes().await.unwrap();
        assert!(!temp_file.exists());
        assert!(store.exists(&hash));
    }

    #[tokio::test]
    async fn temp_cleanup_on_boot_uncommitted_rename() {
        let dir = tempdir().unwrap();
        let pool = create_test_db(dir.path()).await;
        let store = ObjectStore::new(dir.path().to_path_buf(), pool)
            .await
            .unwrap();

        let data = b"uncommitted data";
        let hash = blake3::hash(data).to_hex().to_string();

        let temp_file = layout::temp_path(dir.path(), "crash-temp-2");
        fs::write(&temp_file, data).unwrap();
        assert!(temp_file.exists());

        store.recover_temp_writes().await.unwrap();
        assert!(!temp_file.exists());
        assert!(store.exists(&hash));

        let (status,): (String,) =
            sqlx::query_as("SELECT status FROM storage_objects WHERE object_id = ?")
                .bind(&hash)
                .fetch_one(store.pool())
                .await
                .unwrap();
        assert_eq!(status, "STORED");
    }

    #[tokio::test]
    async fn get_corrupted_errors_and_marks_degraded() {
        let dir = tempdir().unwrap();
        let pool = create_test_db(dir.path()).await;
        let store = ObjectStore::new(dir.path().to_path_buf(), pool.clone())
            .await
            .unwrap();

        let data = b"valid data";
        let hash = store.put(data).await.unwrap();

        // Tamper with file
        let dest = layout::object_path(dir.path(), &hash);
        fs::write(&dest, b"tampered corrupt").unwrap();

        let res = store.get(&hash).await;
        assert!(res.is_err());

        let (status,): (String,) =
            sqlx::query_as("SELECT status FROM storage_objects WHERE object_id = ?")
                .bind(&hash)
                .fetch_one(&pool)
                .await
                .unwrap();

        assert_eq!(status, "DEGRADED");
    }

    #[tokio::test]
    async fn get_nonexistent_fails() {
        let dir = tempdir().unwrap();
        let pool = create_test_db(dir.path()).await;
        let store = ObjectStore::new(dir.path().to_path_buf(), pool)
            .await
            .unwrap();

        let res = store
            .get("0000000000000000000000000000000000000000000000000000000000000000")
            .await;
        assert!(res.is_err());
    }
}
