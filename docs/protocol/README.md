# Protocol

The canonical protocol specification for Nodus — message schemas, the shard
format, sync protocol, and versioning strategy. Implemented in
`packages/protocol` and consumed by the Rust node, Go relay, and web/mobile
clients.

## Reference documents

| Document | Purpose |
|---|---|
| [`schema-versioning.md`](./schema-versioning.md) | Where `schema_version` lives, compatibility rules, and cross-language sync. **Required by `Todo.md` Phase 4.** |
| [`message-catalog.md`](./message-catalog.md) | Human-readable reference for every wire message type. |
| [`event-types.md`](./event-types.md) | Canonical list of sync event types and their payload shapes. |

## The TypeScript package

`packages/protocol` (`@repo/protocol`) is the **source of truth** for the wire
format. It is a pure schema/type package with:

- no dependency on `packages/core`, `relay-client`, or `webrtc-transport`
- zod runtime validation of every message (not just TS types)
- a single `parseMessage(raw)` entry point that validates the envelope, dispatches
  to the type-specific payload schema, and returns a typed result or a structured
  error (never throws on malformed input)
- protocol-local branded types (`ProtocolFileId`, etc.) with thin mapping helpers
  (`toProtocolFileId`, `fromProtocolFileId`) at the boundary with `packages/core`

### Generating the JSON Schema artifacts

Rust and Go don't import the TS types. They reference generated JSON Schema:

```bash
cd packages/protocol
pnpm generate:schemas   # emits schemas/*.schema.json + manifest.json
```

Generated artifacts are deterministic and committed so Rust/Go can treat them as
the canonical wire contract.

## Phases

- **Phase 4 status:** package, runtime validation, docs, and JSON Schema generation
  are complete.
