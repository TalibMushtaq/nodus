# Schema Versioning

This document is the canonical reference for how `packages/protocol` versions its
wire schema. The Rust node and Go relay hand-write their own equivalent structs
(see below), so this strategy must be readable by all three languages.

## Where the version lives

The `schema_version` field appears **on every message envelope**:

```json
{
  "type": "heartbeat",
  "schema_version": "1.0",
  "message_id": "uuid",
  "payload": {...}
}
```

It is **per-message**, not negotiated once at connection time. Reasons:

- Messages are **self-describing** — a receiver can validate/dispatch each
  message independently without connection state.
- The negotiation message itself would need a version, creating a chicken-and-egg
  problem.
- Per-message versioning means a connection can carry a mix of versions during
  a rolling upgrade without terminating the session.

## Format: `major.minor`

`schema_version` is a string in `major.minor` form, e.g. `"1.0"`.

- **Major bump** = breaking change. Any of: removing a field, renaming a field,
  changing a field's type, changing the meaning of an existing value, or adding a
  new *required* field to an existing message.
- **Minor bump** = additive-only change. Only: adding a new **optional** field,
  widening an enum with new values, or adding a brand-new message type. A minor
  bump must never make an existing, previously-valid message invalid.

## What counts as compatible

Given a received `schema_version` and the version the receiver understands:

| Received major == expected major? | Compatible? |
|---|---|
| Different | **No** — reject the message |
| Same major, `received.minor >= expected.minor` | **Yes** — sender may include new optional fields; the receiver ignores unknown optional fields |
| Same major, `received.minor < expected.minor` | **Yes** — the sender is running an older build but additive changes mean nothing required is missing |

The TS implementation enforces exactly this rule in `isCompatible()` in
`src/version.ts`, which `parseMessage()` calls before dispatch.

## What the receiver does with an unsupported version

`parseMessage()` in `src/envelope.ts` follows this policy:

1. **Envelope-level failures** (missing/malformed `schema_version`) → results in a
   `validation_error` in the `ParseResult`. Log and drop.
2. **Major version mismatch** → results in `incompatible_version`. Log the mismatch
   and drop the message. This is the only version-related case that rejects a
   message outright.
3. **Unknown `type`** at a compatible version → results in `unknown_message_type`.
   Log and drop.

`parseMessage` never throws on any of these paths — it returns a structured
`ParseResult` so relay-client and any consumer can decide whether to renegotiate,
retry, or surface the error. When the version is incompatible, the peer should
signal a version upgrade via the `error` message (with `error_code:
incompatible_version`) or by closing/renotiating the connection.

## Interop with Rust and Go

The TS package is the **source of truth** for the wire format, but Rust and Go do
not literally import TS. They keep equivalents in sync via two artifacts generated
from the zod schemas (decision #1):

- **JSON Schema files** — `pnpm generate:schemas` emits `schemas/*.schema.json`
  (one per message payload, plus the event envelope) from
  `z.toJSONSchema()`. Rust (`serde_json`/`jsonschema`) and Go (`sigs.k8s.io/yaml`
  or a JSON-schema validator) can validate messages against these files, or codegen
  structs from them.
- **These docs** — the human-readable `message-catalog.md` and `event-types.md`
  describe each field, its type, and its purpose in language-neutral terms.

Because minor bumps are additive-only, Rust/Go structs that were written against
version `X` remain wire-compatible with version `X.Y` messages as long as they
match the major version — this is exactly the contract `isCompatible` enforces on
the TS side.

### Keeping the three implementations in sync

Any protocol change MUST:

1. Update the zod schema in `packages/protocol` (the source of truth).
2. Regenerate the JSON Schema artifacts (`pnpm generate:schemas`).
3. Update `message-catalog.md` / `event-types.md` as needed.
4. Mirror the change in the Rust and Go equivalents, respecting the major/minor
   compatibility rules defined here.

## Starting defaults

- `CURRENT_SCHEMA_VERSION = "1.0"` (see `src/version.ts`).
- `DEFAULT_SNAPSHOT_CHUNK_SIZE = 256 KB` (see `src/version.ts`). This is a starting
  point for snapshot traffic (§20, Relay ↔ Rust node only), **not** a
  protocol-enforced ceiling — implementations may negotiate or override it.
