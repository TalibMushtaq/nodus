//! Local storage reports for the interactive CLI.
//!
//! These read the node's **own** SQLite catalogue and object index — what this
//! node is backing up — not the account-wide Relay catalogue. The node stores
//! `encrypted_name` as opaque ciphertext and, by design, never holds a file's
//! FEK (`20260912000002_key_envelopes.sql`), so file/folder listings show ids,
//! sizes, and counts rather than real names. That is the honest extent of what a
//! storage node can report.

use sqlx::{Row, SqlitePool};

/// Object/shard/file totals for the storage summary.
#[derive(Debug, PartialEq, Eq)]
pub struct StorageSummary {
    pub stored_bytes: i64,
    pub object_count: i64,
    pub stored_objects: i64,
    pub degraded_objects: i64,
    pub pending_objects: i64,
    pub missing_objects: i64,
    pub file_count: i64,
    pub folder_count: i64,
    pub version_count: i64,
    pub shard_count: i64,
}

#[derive(Debug, PartialEq, Eq)]
pub struct FileRow {
    pub file_id: String,
    pub encrypted_name: Option<String>,
    pub parent_folder_id: Option<String>,
    pub updated_at: String,
    pub versions: i64,
    pub shards: i64,
    /// Encrypted bytes of the latest version stored on this node.
    pub bytes: i64,
}

#[derive(Debug, PartialEq, Eq)]
pub struct FolderRow {
    pub folder_id: String,
    pub parent_folder_id: Option<String>,
    pub encrypted_name: Option<String>,
    pub updated_at: String,
}

/// Human-readable binary size.
pub fn format_bytes(bytes: i64) -> String {
    if bytes < 0 {
        return "—".to_string();
    }
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else if value < 10.0 {
        format!("{value:.1} {}", UNITS[unit])
    } else {
        format!("{value:.0} {}", UNITS[unit])
    }
}

/// First `len` chars of an id, ellipsized when longer. Counts characters, not
/// bytes: `encrypted_name` is opaque client-supplied text and a multi-byte
/// code point crossing the byte index would otherwise panic the CLI listing.
fn short(id: &str, len: usize) -> String {
    let truncated: String = id.chars().take(len).collect();
    if id.chars().count() > len {
        format!("{truncated}…")
    } else {
        truncated
    }
}

/// Names are ciphertext to the node; show a short prefix so the listing still
/// conveys "there is a name here" without pretending it is readable.
fn name_hint(encrypted_name: &Option<String>) -> String {
    match encrypted_name {
        Some(name) if !name.is_empty() => short(name, 12),
        _ => "—".to_string(),
    }
}

const SUMMARY_SQL: &str = r#"
SELECT
  (SELECT COALESCE(SUM(size_bytes), 0) FROM storage_objects WHERE status = 'STORED') AS stored_bytes,
  (SELECT COUNT(*) FROM storage_objects) AS object_count,
  (SELECT COUNT(*) FROM storage_objects WHERE status = 'STORED') AS stored_objects,
  (SELECT COUNT(*) FROM storage_objects WHERE status = 'DEGRADED') AS degraded_objects,
  (SELECT COUNT(*) FROM storage_objects WHERE status = 'PENDING') AS pending_objects,
  (SELECT COUNT(*) FROM storage_objects WHERE status = 'PERMANENTLY_MISSING') AS missing_objects,
  (SELECT COUNT(*) FROM files) AS file_count,
  (SELECT COUNT(*) FROM folders) AS folder_count,
  (SELECT COUNT(*) FROM file_versions) AS version_count,
  (SELECT COUNT(*) FROM shards) AS shard_count
"#;

/// Files with per-file version/shard counts and the latest version's bytes.
const FILES_SQL: &str = r#"
SELECT
  f.file_id,
  f.encrypted_name,
  f.parent_folder_id,
  f.updated_at,
  (SELECT COUNT(*) FROM file_versions v WHERE v.file_id = f.file_id) AS versions,
  (SELECT COUNT(*) FROM shards s
     WHERE s.file_id = f.file_id
       AND s.version_number = (SELECT MAX(version_number) FROM file_versions v WHERE v.file_id = f.file_id)
  ) AS shards,
  (SELECT COALESCE(SUM(s.size_bytes), 0) FROM shards s
     WHERE s.file_id = f.file_id
       AND s.version_number = (SELECT MAX(version_number) FROM file_versions v WHERE v.file_id = f.file_id)
  ) AS bytes
FROM files f
ORDER BY f.updated_at DESC
"#;

const FOLDERS_SQL: &str = r#"
SELECT folder_id, parent_folder_id, encrypted_name, updated_at
FROM folders
ORDER BY created_at ASC
"#;

pub async fn summary(pool: &SqlitePool) -> anyhow::Result<StorageSummary> {
    let row = sqlx::query(SUMMARY_SQL).fetch_one(pool).await?;
    Ok(StorageSummary {
        stored_bytes: row.get("stored_bytes"),
        object_count: row.get("object_count"),
        stored_objects: row.get("stored_objects"),
        degraded_objects: row.get("degraded_objects"),
        pending_objects: row.get("pending_objects"),
        missing_objects: row.get("missing_objects"),
        file_count: row.get("file_count"),
        folder_count: row.get("folder_count"),
        version_count: row.get("version_count"),
        shard_count: row.get("shard_count"),
    })
}

pub async fn files(pool: &SqlitePool) -> anyhow::Result<Vec<FileRow>> {
    let rows = sqlx::query(FILES_SQL).fetch_all(pool).await?;
    Ok(rows
        .into_iter()
        .map(|row| FileRow {
            file_id: row.get("file_id"),
            encrypted_name: row.get("encrypted_name"),
            parent_folder_id: row.get("parent_folder_id"),
            updated_at: row.get("updated_at"),
            versions: row.get("versions"),
            shards: row.get("shards"),
            bytes: row.get("bytes"),
        })
        .collect())
}

pub async fn folders(pool: &SqlitePool) -> anyhow::Result<Vec<FolderRow>> {
    let rows = sqlx::query(FOLDERS_SQL).fetch_all(pool).await?;
    Ok(rows
        .into_iter()
        .map(|row| FolderRow {
            folder_id: row.get("folder_id"),
            parent_folder_id: row.get("parent_folder_id"),
            encrypted_name: row.get("encrypted_name"),
            updated_at: row.get("updated_at"),
        })
        .collect())
}

/// One preserved side of a version fork (ADR-0003). The `conflicted_name` is
/// the opaque client-supplied sibling name; the node stores it but cannot read
/// it, so the listing shows a short hint.
#[derive(Debug, PartialEq, Eq)]
pub struct ConflictRow {
    pub file_id: String,
    pub version_number: i64,
    pub conflicted_name: String,
}

pub async fn conflicts(pool: &SqlitePool) -> anyhow::Result<Vec<ConflictRow>> {
    let rows = sqlx::query_as::<_, (String, i64, String)>(
        "SELECT file_id, version_number, conflicted_name FROM file_versions \
         WHERE conflicted_name IS NOT NULL \
         ORDER BY file_id ASC, version_number ASC",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(file_id, version_number, conflicted_name)| ConflictRow {
            file_id,
            version_number,
            conflicted_name,
        })
        .collect())
}

pub async fn print_conflicts(pool: &SqlitePool) -> anyhow::Result<()> {
    let rows = conflicts(pool).await?;
    println!();
    if rows.is_empty() {
        println!("No unresolved conflicted copies on this node.");
        println!();
        return Ok(());
    }
    println!("Conflicted copies ({})", rows.len());
    println!("  {:<14} {:>5}  NAME (encrypted)", "FILE ID", "VER");
    for row in rows {
        println!(
            "  {:<14} {:>5}  {}",
            short(&row.file_id, 14),
            row.version_number,
            short(&row.conflicted_name, 32)
        );
    }
    println!();
    println!("Preserved siblings of a version fork; the client resolves them (ADR-0003).");
    Ok(())
}

pub async fn print_summary(pool: &SqlitePool) -> anyhow::Result<()> {
    let s = summary(pool).await?;
    println!();
    println!("Storage summary (this node)");
    println!("  Stored size:   {}", format_bytes(s.stored_bytes));
    println!(
        "  Objects:       {} (stored {}, degraded {}, pending {}, missing {})",
        s.object_count, s.stored_objects, s.degraded_objects, s.pending_objects, s.missing_objects
    );
    println!(
        "  Files:         {} across {} versions, {} shards",
        s.file_count, s.version_count, s.shard_count
    );
    println!("  Folders:       {}", s.folder_count);
    println!();
    Ok(())
}

pub async fn print_files(pool: &SqlitePool) -> anyhow::Result<()> {
    let rows = files(pool).await?;
    println!();
    if rows.is_empty() {
        println!("No files stored on this node yet.");
        println!();
        return Ok(());
    }
    println!("Files ({})", rows.len());
    println!(
        "  {:<14} {:>10} {:>5} {:>7}  NAME (encrypted)",
        "ID", "SIZE", "VER", "SHARDS"
    );
    for file in rows {
        println!(
            "  {:<14} {:>10} {:>5} {:>7}  {}",
            short(&file.file_id, 12),
            format_bytes(file.bytes),
            file.versions,
            file.shards,
            name_hint(&file.encrypted_name)
        );
    }
    println!();
    println!("Names are end-to-end encrypted; the node stores ciphertext only.");
    println!();
    Ok(())
}

pub async fn print_folders(pool: &SqlitePool) -> anyhow::Result<()> {
    let rows = folders(pool).await?;
    println!();
    if rows.is_empty() {
        println!("No folders stored on this node yet.");
        println!();
        return Ok(());
    }
    println!("Folders ({})", rows.len());
    println!("  {:<14} {:<14}  NAME (encrypted)", "ID", "PARENT");
    for folder in rows {
        let parent = folder
            .parent_folder_id
            .as_deref()
            .map(|p| short(p, 12))
            .unwrap_or_else(|| "—".to_string());
        println!(
            "  {:<14} {:<14}  {}",
            short(&folder.folder_id, 12),
            parent,
            name_hint(&folder.encrypted_name)
        );
    }
    println!();
    println!("Names are end-to-end encrypted; the node stores ciphertext only.");
    println!();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use tempfile::tempdir;

    async fn seed(pool: &SqlitePool) {
        // Two stored objects (10 + 30) and one degraded object (100).
        sqlx::query("INSERT INTO storage_objects (object_id, size_bytes, status, created_at) VALUES ('o1', 10, 'STORED', 'now')")
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO storage_objects (object_id, size_bytes, status, created_at) VALUES ('o2', 30, 'STORED', 'now')")
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO storage_objects (object_id, size_bytes, status, created_at) VALUES ('o3', 100, 'DEGRADED', 'now')")
            .execute(pool)
            .await
            .unwrap();

        // One file with two versions; the latest version's shards sum to 40.
        sqlx::query("INSERT INTO files (file_id, parent_folder_id, encrypted_name, created_at, updated_at) VALUES ('file-1', 'dir-1', 'enc-name', '2026-09-12T00:00:00Z', '2026-09-12T01:00:00Z')")
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO file_versions (file_id, version_number, parent_version_id, version_hash, shard_count, created_at) VALUES ('file-1', 1, NULL, 'h1', 1, '2026-09-12T00:00:00Z')")
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO file_versions (file_id, version_number, parent_version_id, version_hash, shard_count, created_at) VALUES ('file-1', 2, 1, 'h2', 2, '2026-09-12T01:00:00Z')")
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO shards (file_id, version_number, shard_index, object_id, size_bytes) VALUES ('file-1', 1, 0, 'o3', 100)")
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO shards (file_id, version_number, shard_index, object_id, size_bytes) VALUES ('file-1', 2, 0, 'o1', 10)")
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO shards (file_id, version_number, shard_index, object_id, size_bytes) VALUES ('file-1', 2, 1, 'o2', 30)")
            .execute(pool)
            .await
            .unwrap();

        sqlx::query("INSERT INTO folders (folder_id, parent_folder_id, encrypted_name, created_at, updated_at) VALUES ('dir-1', NULL, 'enc-dir', '2026-09-12T00:00:00Z', '2026-09-12T00:00:00Z')")
            .execute(pool)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn summary_counts_and_stored_bytes() {
        let dir = tempdir().unwrap();
        let pool = db::open(dir.path()).await.unwrap();
        seed(&pool).await;

        let s = summary(&pool).await.unwrap();
        assert_eq!(s.stored_bytes, 40, "only STORED objects count toward size");
        assert_eq!(s.object_count, 3);
        assert_eq!(s.stored_objects, 2);
        assert_eq!(s.degraded_objects, 1);
        assert_eq!(s.pending_objects, 0);
        assert_eq!(s.missing_objects, 0);
        assert_eq!(s.file_count, 1);
        assert_eq!(s.folder_count, 1);
        assert_eq!(s.version_count, 2);
        assert_eq!(s.shard_count, 3);
    }

    #[tokio::test]
    async fn files_report_latest_version_metrics() {
        let dir = tempdir().unwrap();
        let pool = db::open(dir.path()).await.unwrap();
        seed(&pool).await;

        let rows = files(&pool).await.unwrap();
        assert_eq!(rows.len(), 1);
        let file = &rows[0];
        assert_eq!(file.file_id, "file-1");
        assert_eq!(file.versions, 2);
        // Only the latest version's shards are counted.
        assert_eq!(file.shards, 2);
        assert_eq!(file.bytes, 40);
        assert_eq!(file.parent_folder_id.as_deref(), Some("dir-1"));
    }

    #[tokio::test]
    async fn folders_report_rows() {
        let dir = tempdir().unwrap();
        let pool = db::open(dir.path()).await.unwrap();
        seed(&pool).await;

        let rows = folders(&pool).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].folder_id, "dir-1");
        assert_eq!(rows[0].encrypted_name.as_deref(), Some("enc-dir"));
    }

    #[test]
    fn format_bytes_scales_units() {
        assert_eq!(format_bytes(0), "0 B");
        assert_eq!(format_bytes(512), "512 B");
        assert_eq!(format_bytes(1536), "1.5 KB");
        assert_eq!(format_bytes(10 * 1024 * 1024), "10 MB");
        assert_eq!(format_bytes(-1), "—");
    }

    #[test]
    fn short_handles_multibyte_ids_without_panicking() {
        // A multi-byte code point straddling the byte index must not panic;
        // `encrypted_name` is opaque client-supplied text.
        let id = "é".repeat(20);
        let out = short(&id, 12);
        assert_eq!(out.chars().filter(|c| *c == 'é').count(), 12);
        assert!(out.ends_with('…'));

        // Short ids are returned whole, with no ellipsis.
        assert_eq!(short("abc", 12), "abc");
        assert_eq!(name_hint(&Some("short".into())), "short");
        assert_eq!(name_hint(&None), "—");
    }

    #[tokio::test]
    async fn conflicts_lists_preserved_siblings() {
        let dir = tempdir().unwrap();
        let pool = db::open(dir.path()).await.unwrap();
        seed(&pool).await;

        // No conflict names yet.
        assert!(conflicts(&pool).await.unwrap().is_empty());

        sqlx::query(
            "UPDATE file_versions SET conflicted_name = 'doc (conflicted copy dev 2026-09-13).pdf' \
             WHERE file_id = 'file-1' AND version_number = 2",
        )
        .execute(&pool)
        .await
        .unwrap();

        let rows = conflicts(&pool).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].file_id, "file-1");
        assert_eq!(rows[0].version_number, 2);
        assert!(rows[0].conflicted_name.contains("conflicted copy"));
    }
}
