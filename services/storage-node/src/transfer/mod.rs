//! Transfer Manager — fallback-chain orchestration for per-shard transfers.
//!
//! Mirrors `packages/transfer-manager` (TS); both honor the contract in
//! docs/architecture/transfer-manager-spec.md.
//!
//! ponytail: much of this module is library surface not yet reached from
//! `main.rs` (Path D retry hooks, node→node WebRTC receive). The bin only
//! drives the manager via the §21a reconcile repair path today, so dead-code
//! analysis reports these as unused — they are the API later phases call.
#![allow(dead_code)]

pub mod backoff;
pub mod cache;
pub mod config;
pub mod executor;
pub mod manager;
pub mod node_attempter;
pub mod pool;
pub mod queue;
pub mod types;
pub mod webrtc_client;
