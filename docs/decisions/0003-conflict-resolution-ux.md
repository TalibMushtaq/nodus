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
