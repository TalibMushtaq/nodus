//! Content-addressed object store module for Nodus Storage Node (Phase 6).
//!
//! Provides:
//! - Content-addressed shard storage under `<data_dir>/objects/<prefix>/<hash>`
//! - Atomic writes with sync-then-rename and crash recovery
//! - Physical reconciliation scan (§21 / §21a)
//! - Garbage collection job for version pruning and tombstone compaction (§29a)

pub mod gc;
pub mod layout;
pub mod reconcile;
pub mod write;

#[allow(unused_imports)]
pub use gc::{GcConfig, GcReport, run_gc, spawn_gc_task};
#[allow(unused_imports)]
pub use reconcile::{ReconcileReport, run_reconciliation, spawn_reconcile_task};
pub use write::ObjectStore;
