use sqlx::{Row, SqlitePool};
use std::path::Path;

/// Checks whether a newly received or created version branches off a parent that already has a sibling version.
/// Returns `Some(existing_version_number)` if a conflict is detected.
pub async fn detect_branch_conflict(
    db: &SqlitePool,
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
    .fetch_optional(db)
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
    let short_origin = if origin_id.len() > 8 {
        &origin_id[..8]
    } else {
        origin_id
    };

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
}
