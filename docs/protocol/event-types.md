# Event Types

This is the canonical list of sync event types and their payload shapes. It
finalizes the "exact sync event schema" open item from `Todo.md` (needed by
Phase 8). The source of truth is `packages/protocol/src/events/event-types.ts`;
the generated `schemas/event.schema.json` is the machine-readable equivalent.

## The canonical event envelope

```json
{
  "event_id": "uuid",
  "origin_id": "node_abc",
  "origin_sequence": 1042,
  "type": "FILE_CREATED",
  "payload": { "...": "..." },
  "timestamp": "2026-09-02T12:00:00Z"
}
```

| Field | Type | Notes |
|---|---|---|
| `event_id` | string (uuid) | Globally unique; used for idempotent application (§8 dedupe) |
| `origin_id` | string | The node/device that created the event |
| `origin_sequence` | integer ≥ 0 | Monotonically increasing, scoped to the origin. Together with `origin_id` this provides total ordering per origin and enables cursor-based sync (§18). |
| `type` | enum | One of the canonical types below |
| `payload` | object | Validated against the schema for `type` |
| `timestamp` | ISO 8601 string | When the event was created at the origin |

### Ordering guarantees

- **Within one origin:** `origin_sequence` is strictly increasing. Events from a
  single origin are strictly ordered.
- **Across origins:** there is no global total order. Each side tracks a cursor
  per origin (`{ origin_id, sequence }`) and computes the diff (§18). Event
  application is idempotent by `event_id`, so out-of-order or duplicated delivery
  across origins cannot create duplicate state.

## Canonical `event_type` values

### `FILE_CREATED`

A file was created.

| Field | Type | Required | Notes |
|---|---|---|---|
| `file_id` | string | yes | Logical file identifier |
| `parent_folder_id` | string \| null | no | Omitted for root-level files |
| `encrypted_name` | string | no | Encrypted filename (opaque to the relay) |
| `content_hash` | string | no | BLAKE3 of the latest version |

### `FILE_DELETED`

A file was deleted (represented with a tombstone, §17).

Same payload shape as `FILE_CREATED`.

### `FILE_VERSION_ADDED`

A new immutable version was added to an existing file.

| Field | Type | Required | Notes |
|---|---|---|---|
| `file_id` | string | yes | Logical file identifier |
| `version_number` | integer ≥ 1 | yes | Monotonic version for this file |
| `shard_count` | integer ≥ 1 | yes | Total shard count for this version |
| `version_hash` | string | yes | BLAKE3 content hash of this version |
| `parent_folder_id` | string \| null | no | Omitted for root-level files |
| `encrypted_name` | string | no | Encrypted filename |
| `content_hash` | string | no | Also accepted; redundant with `version_hash` |

### `FILE_MODIFIED`

A file's content changed. Same payload shape as `FILE_VERSION_ADDED` (immutable
versions model an edit as a new version).

### `DEVICE_REVOKED`

A device lost access (revocation removes only its key envelope, per
ADR-0001 — file keys are not rotated).

| Field | Type | Required | Notes |
|---|---|---|---|
| `device_id` | string | yes | The revoked device |
| `revoked_at` | ISO 8601 string | yes | When the revocation happened |

### `TOMBSTONE_CREATED`

Records that an entity was deleted, preventing resurrection by a long-offline
device (§17). Retention is governed by the GC policy (§29a).

| Field | Type | Required | Notes |
|---|---|---|---|
| `entity_type` | enum | yes | `file` or `folder` |
| `entity_id` | string | yes | The deleted entity's ID |
| `deleted_at` | ISO 8601 string | yes | When the deletion happened |

### `FOLDER_CREATED`

A folder was created.

| Field | Type | Required | Notes |
|---|---|---|---|
| `folder_id` | string | yes | Folder identifier |
| `parent_folder_id` | string \| null | no | Omitted for root-level folders |
| `encrypted_name` | string | no | Encrypted folder name |

### `FOLDER_DELETED`

A folder was deleted.

Same payload shape as `FOLDER_CREATED`.

## Adding a new event type

1. Add a literal to `EventTypes` in `src/events/event-types.ts`.
2. Add it to `EventTypeSchema` (the zod enum).
3. Define a payload schema and register it in `EventPayloadMap`.
4. Regenerate `schemas/` and update this document.
5. Mirror in Rust/Go per the cross-language sync rules in `schema-versioning.md`.
