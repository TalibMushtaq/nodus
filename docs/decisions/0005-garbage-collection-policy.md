# ADR-0005: Garbage Collection Default Policy

## Status
Accepted

## Context
Plan §29a required default retention numbers before the Rust node's GC background job (TODO Phase 6) could be implemented.

## Decision
v1 defaults (configurable per account later, hardcoded for now):
- Old file versions: keep the **5 most recent versions**, or all versions **younger than 30 days**, whichever retains more.
- Tombstones: retained for **90 days** before compaction.
- Orphaned objects (no metadata reference): **24-hour** grace period before deletion.

## Consequences
- Positive: balanced default that limits storage growth without being aggressive enough to risk losing a version a user still wants.
- Negative: fixed values may not fit every usage pattern (e.g. users who edit the same file dozens of times a day) — flagged as a v2 candidate for per-account configuration, not a v1 requirement.
- Implementation note: run as a periodic background job in the Rust node, never inline with writes (plan §4.7 / TODO Phase 6).
