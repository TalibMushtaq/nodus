# ADR-0003: Conflict Resolution UX

## Status
Accepted

## Context
Plan §17a required a concrete mechanism for surfacing conflicts to the user, beyond "let the user resolve them."

## Decision
- Conflicted files are kept as siblings using the naming convention `filename (conflicted copy, Device B, YYYY-MM-DD).ext`.
- Conflicts are surfaced via a **persistent inbox/list view** in both clients (not a transient banner/toast) — a dedicated screen/section listing all unresolved conflicts until the user acts on them.

## Consequences
- Positive: conflicts can't be missed or dismissed accidentally the way a toast could be; matches how users expect to triage a backlog of items.
- Negative: requires a small amount of persistent UI (a list screen, a badge/count indicator) in both `apps/web` and `apps/mobile`, rather than a one-off notification component.
- Implementation note: this is a shared UX pattern — worth extracting the conflict-list data model into `packages/core` so both clients render from the same shape.

## Addendum (2026-09-17): choosing a version

### Context

The original decision surfaced conflicts and acknowledged them, but the design's
"Keep A / Keep B / Keep both" choice had no representation: resolving only
cleared the flagged status, so the numerically newest version always stayed
current and the user's intent was lost.

### Decision

- `files.preferred_version` records the version the user chose to keep. The
  Relay returns it from `GET /files`; clients treat
  `preferred_version ?? newest` as the file's current version.
- `CONFLICT_RESOLVED` carries an optional `keep_version`. The Relay's REST
  resolve endpoint accepts `{ "keep_version": N }` and the WebSocket event path
  carries the same field; both validate that the version belongs to the
  caller's file before recording it.
- **No data is deleted.** Every version row and shard is retained, so a choice
  is reversible and either side can still be recovered. "Keep both" is simply
  the absence of a choice (preserve the sibling as before).
- The Rust Storage Node keeps mirroring `conflict_status` and ignores the
  optional field; clients read the catalog from the Relay, so the node does not
  need the pointer to serve shards.

### Consequences

- Positive: the choice is meaningful, additive and non-destructive — no
  shard-deletion path is introduced.
- Negative: a Relay rebuilt purely from node snapshots would not recover
  `preferred_version` (the versions themselves survive). Propagating the
  pointer through the snapshot/rebuild path is a tracked follow-up.

