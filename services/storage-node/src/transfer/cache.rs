use anyhow::Context;
use sqlx::SqlitePool;

use super::types::TransferPath;

/// Path cache backed by the `trusted_nodes` table.
/// Updates `last_successful_path` and `last_success_at` on cache writes.
pub struct SqlitePathCache {
    pool: SqlitePool,
}

impl SqlitePathCache {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// Expose the inner pool for creating new cache instances in spawned tasks.
    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    /// Look up the last successful path for a node.
    pub async fn get(&self, node_id: &str) -> anyhow::Result<Option<TransferPath>> {
        let row: Option<(String,)> = sqlx::query_as(
            "SELECT last_successful_path FROM trusted_nodes WHERE node_id = ? AND last_successful_path IS NOT NULL",
        )
        .bind(node_id)
        .fetch_optional(&self.pool)
        .await
        .context("path cache get")?;

        Ok(row.and_then(|(path,)| TransferPath::from_str(&path)))
    }

    /// Write/update the path cache entry on successful transfer.
    pub async fn set(&self, node_id: &str, path: TransferPath) -> anyhow::Result<()> {
        let now = chrono::Utc::now().to_rfc3339();
        sqlx::query(
            "UPDATE trusted_nodes SET last_successful_path = ?, last_success_at = ? WHERE node_id = ?",
        )
        .bind(path.as_str())
        .bind(&now)
        .bind(node_id)
        .execute(&self.pool)
        .await
        .context("path cache set")?;
        Ok(())
    }

    /// Evict the path cache entry (called when a cached path fails).
    pub async fn evict(&self, node_id: &str) -> anyhow::Result<()> {
        sqlx::query(
            "UPDATE trusted_nodes SET last_successful_path = NULL, last_success_at = NULL WHERE node_id = ?",
        )
        .bind(node_id)
        .execute(&self.pool)
        .await
        .context("path cache evict")?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn get_returns_none_for_unknown_node() {
        let dir = tempfile::tempdir().unwrap();
        let pool = crate::db::open(dir.path()).await.unwrap();
        let cache = SqlitePathCache::new(pool);
        assert!(cache.get("nonexistent").await.unwrap().is_none());
    }
}
