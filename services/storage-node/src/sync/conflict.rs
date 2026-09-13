use sqlx::{Row, SqliteConnection, SqlitePool};
use std::path::Path;

use super::types::FileVersionPayload;

/// The row currently occupying a `(file_id, version_number)` slot, if any.
/// `is_flagged` is true when the occupant was already marked conflicted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlotOccupant {
    pub parent_version_id: Option<i64>,
    pub version_hash: String,
    pub is_flagged: bool,
}

/// Reads the version currently holding the `(file_id, version_number)` slot.
/// The occupant's `parent_version_id` and `version_hash` together distinguish a
/// benign idempotent re-delivery (same parent, same hash) from a genuine fork:
/// two offline branches either reached the same number from different parents,
/// or both edited the same parent into the same number (#10).
pub async fn existing_slot_conn(
    conn: &mut SqliteConnection,
    file_id: &str,
    version_number: i64,
) -> anyhow::Result<Option<SlotOccupant>> {
    let row = sqlx::query(
        r#"
        SELECT parent_version_id, version_hash, conflict_status
        FROM file_versions
        WHERE file_id = ? AND version_number = ?
        "#,
    )
    .bind(file_id)
    .bind(version_number)
    .fetch_optional(&mut *conn)
    .await?;

    let Some(row) = row else {
        return Ok(None);
    };
    Ok(Some(SlotOccupant {
        parent_version_id: row.try_get("parent_version_id")?,
        version_hash: row.try_get("version_hash")?,
        is_flagged: row.try_get::<String, _>("conflict_status")? == "flagged",
    }))
}

/// True when the occupant already in the slot is a *different* version than the
/// incoming one — either branched from a different parent or holds different
/// content. Identical parent+hash means the same version was delivered again
/// and a plain upsert is correct (no data loss, no preserve-both needed).
pub fn is_fork_occupant(occupant: &SlotOccupant, ver: &FileVersionPayload) -> bool {
    occupant.parent_version_id != ver.parent_version_id || occupant.version_hash != ver.version_hash
}

/// Allocates the next free version number for a file (MAX + 1). Used to give a
/// fork-colliding version its own slot so both branches survive (#10). Runs on
/// the caller's transaction and is safe because version numbers are unique per
/// (file_id, version_number) and SQLite writers serialize.
pub async fn next_free_version_number_conn(
    conn: &mut SqliteConnection,
    file_id: &str,
) -> anyhow::Result<i64> {
    let max: Option<i64> =
        sqlx::query_scalar("SELECT MAX(version_number) FROM file_versions WHERE file_id = ?")
            .bind(file_id)
            .fetch_one(&mut *conn)
            .await?;
    Ok(max.map(|m| m + 1).unwrap_or(1))
}

/// Symmetrically flags every version on the incoming branch as conflicted,
/// mirroring the Relay (`sync.go`): when one version conflicts, the whole
/// branch set sharing that parent is marked flagged so the earlier sibling is
/// preserved rather than silently staying "clean".
pub async fn mark_branch_flagged_conn(
    conn: &mut SqliteConnection,
    file_id: &str,
    parent_version_id: Option<i64>,
) -> anyhow::Result<()> {
    let Some(parent) = parent_version_id else {
        return Ok(());
    };
    sqlx::query(
        "UPDATE file_versions SET conflict_status = 'flagged' WHERE file_id = ? AND parent_version_id = ?",
    )
    .bind(file_id)
    .bind(parent)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Checks whether a newly received or created version branches off a parent that already has a sibling version.
/// Returns `Some(existing_version_number)` if a conflict is detected.
pub async fn detect_branch_conflict(
    db: &SqlitePool,
    file_id: &str,
    parent_version_id: Option<i64>,
    version_number: i64,
) -> anyhow::Result<Option<i64>> {
    let mut conn = db.acquire().await?;
    detect_branch_conflict_conn(&mut conn, file_id, parent_version_id, version_number).await
}

/// Connection variant of [`detect_branch_conflict`]. Runs on the caller's
/// transaction so the conflict check and the sibling insert are atomic (#6).
pub async fn detect_branch_conflict_conn(
    conn: &mut SqliteConnection,
    file_id: &str,
    parent_version_id: Option<i64>,
    version_number: i64,
) -> anyhow::Result<Option<i64>> {
    let Some(parent) = parent_version_id else {
        return Ok(None);
    };

    let row = sqlx::query(
        r#"
        SELECT version_number
        FROM file_versions
        WHERE file_id = ? AND parent_version_id = ? AND version_number != ?
        LIMIT 1
        "#,
    )
    .bind(file_id)
    .bind(parent)
    .bind(version_number)
    .fetch_optional(conn)
    .await?;

    Ok(row.map(|r| r.get::<i64, _>("version_number")))
}

/// Generates a §17a conflicted copy filename.
/// Format: `<base> (conflicted copy <short_origin> <date>).<ext>`
pub fn generate_conflicted_filename(
    original_name: &str,
    origin_id: &str,
    timestamp: &str,
) -> String {
    // `origin_id` is remote/attacker-controlled; slice by characters, not
    // bytes, so a multi-byte code point straddling index 8 cannot panic sync.
    let short_origin: String = origin_id.chars().take(8).collect();

    let date_str = if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(timestamp) {
        dt.format("%Y-%m-%d").to_string()
    } else {
        chrono::Utc::now().format("%Y-%m-%d").to_string()
    };

    let path = Path::new(original_name);
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(original_name);
    let extension = path.extension().and_then(|e| e.to_str());

    match extension {
        Some(ext) => format!("{stem} (conflicted copy {short_origin} {date_str}).{ext}"),
        None => format!("{stem} (conflicted copy {short_origin} {date_str})"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use tempfile::tempdir;

    #[test]
    fn test_generate_conflicted_filename() {
        let name = generate_conflicted_filename(
            "document.pdf",
            "node-12345678abcdef",
            "2026-09-04T12:00:00Z",
        );
        assert_eq!(name, "document (conflicted copy node-123 2026-09-04).pdf");

        let name_no_ext =
            generate_conflicted_filename("notes", "node-12345678abcdef", "2026-09-04T12:00:00Z");
        assert_eq!(name_no_ext, "notes (conflicted copy node-123 2026-09-04)");
    }

    #[test]
    fn conflicted_filename_handles_multibyte_origin_without_panicking() {
        // `origin_id` is remote-controlled; a multi-byte char straddling byte 8
        // previously panicked the sync task.
        let name =
            generate_conflicted_filename("document.pdf", "aaaaaaé12345", "2026-09-04T12:00:00Z");
        assert!(
            name.starts_with("document (conflicted copy aaaaaaé1 "),
            "{name}"
        );
    }

    #[tokio::test]
    async fn test_detect_branch_conflict() {
        let dir = tempdir().unwrap();
        let pool = db::open(dir.path()).await.unwrap();

        // Create file
        sqlx::query(
            "INSERT INTO files (file_id, created_at, updated_at) VALUES ('f1', 'now', 'now')",
        )
        .execute(&pool)
        .await
        .unwrap();

        // Insert version 1 (root, parent is NULL)
        sqlx::query(
            "INSERT INTO file_versions (file_id, version_number, parent_version_id, version_hash, shard_count, created_at) VALUES ('f1', 1, NULL, 'hash1', 1, 'now')"
        )
        .execute(&pool)
        .await
        .unwrap();

        // Insert version 2 (parent is 1)
        sqlx::query(
            "INSERT INTO file_versions (file_id, version_number, parent_version_id, version_hash, shard_count, created_at) VALUES ('f1', 2, 1, 'hash2', 1, 'now')"
        )
        .execute(&pool)
        .await
        .unwrap();

        // Check if version 3 with parent 1 conflicts -> yes, version 2 is a sibling!
        let conflict = detect_branch_conflict(&pool, "f1", Some(1), 3)
            .await
            .unwrap();
        assert_eq!(conflict, Some(2));

        // Check if version 3 with parent 2 conflicts -> no sibling exists with parent 2
        let conflict_linear = detect_branch_conflict(&pool, "f1", Some(2), 3)
            .await
            .unwrap();
        assert_eq!(conflict_linear, None);

        // Check root version -> None
        let conflict_root = detect_branch_conflict(&pool, "f1", None, 1).await.unwrap();
        assert_eq!(conflict_root, None);
    }

    #[tokio::test]
    async fn test_slot_occupancy_renumber_and_branch_flagging() {
        let dir = tempdir().unwrap();
        let pool = db::open(dir.path()).await.unwrap();

        sqlx::query(
            "INSERT INTO files (file_id, created_at, updated_at) VALUES ('f-slot', 'now', 'now')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let mut conn = pool.acquire().await.unwrap();

        // Empty slot → no occupant; next-free starts at 1.
        let none = existing_slot_conn(&mut conn, "f-slot", 4).await.unwrap();
        assert_eq!(none, None);
        assert_eq!(
            next_free_version_number_conn(&mut conn, "f-slot")
                .await
                .unwrap(),
            1
        );

        // Version 4/parent 2 (already flagged, mirroring a first branch).
        sqlx::query(
            "INSERT INTO file_versions (file_id, version_number, parent_version_id, conflict_status, version_hash, shard_count, created_at)
             VALUES ('f-slot', 4, 2, 'flagged', 'hash4', 1, 'now')",
        )
        .execute(&mut *conn)
        .await
        .unwrap();

        let occupant = existing_slot_conn(&mut conn, "f-slot", 4)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(occupant.parent_version_id, Some(2));
        assert!(occupant.is_flagged);

        // Next free skips over the occupied slot.
        assert_eq!(
            next_free_version_number_conn(&mut conn, "f-slot")
                .await
                .unwrap(),
            5
        );

        // Flag the whole branch (parent 2): the occupant is symmetric-flagged
        // and a clean 5/parent 2 sibling gets flagged too.
        sqlx::query(
            "INSERT INTO file_versions (file_id, version_number, parent_version_id, conflict_status, version_hash, shard_count, created_at)
             VALUES ('f-slot', 5, 2, 'none', 'hash5', 1, 'now')",
        )
        .execute(&mut *conn)
        .await
        .unwrap();
        mark_branch_flagged_conn(&mut conn, "f-slot", Some(2))
            .await
            .unwrap();

        let flags: Vec<String> = sqlx::query_scalar(
            "SELECT conflict_status FROM file_versions WHERE file_id = 'f-slot' ORDER BY version_number",
        )
        .fetch_all(&mut *conn)
        .await
        .unwrap();
        assert_eq!(flags, vec!["flagged", "flagged"]);

        // Root-parent branch flagging is a no-op (nothing to flag).
        mark_branch_flagged_conn(&mut conn, "f-slot", None)
            .await
            .unwrap();
    }
}
