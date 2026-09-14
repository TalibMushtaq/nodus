//! Content-addressed object store module for Nodus Storage Node (Phase 6).
//!
//! Provides:
//! - Content-addressed shard storage under `<data_dir>/objects/<hash>` (flat)
//! - Atomic writes with sync-then-rename and crash recovery
//! - Physical reconciliation scan (§21 / §21a)
//! - Garbage collection job for version pruning and tombstone compaction (§29a)

pub mod gc;
pub mod layout;
pub mod reconcile;
pub mod write;

// Only the entry points `main.rs` drives through the top-level path are
// re-exported here; `GcReport`/`run_gc` and `ReconcileReport`/`run_reconciliation`
// stay module-local (their spawn wrappers are the crate's callers).
pub use gc::{GcConfig, spawn_gc_task};
pub use reconcile::spawn_reconcile_task;
pub use write::ObjectStore;
