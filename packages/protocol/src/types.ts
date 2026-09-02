import { z } from "zod";

// ── Branded identity types ─────────────────────────────────────────
//
// All branded identity types for the wire protocol live here — a leaf module
// with no imports from sibling modules, so there are zero circular dependency
// risks. Message modules and envelope.ts both import from this file.

/** Branded string for account identifiers. */
export type AccountId = string & { readonly __accountId: unique symbol };
export const AccountId = z.string().brand<AccountId>();

/** Branded string for device identifiers. */
export type DeviceId = string & { readonly __deviceId: unique symbol };
export const DeviceId = z.string().brand<DeviceId>();

/** Branded string for storage node identifiers. */
export type NodeId = string & { readonly __nodeId: unique symbol };
export const NodeId = z.string().brand<NodeId>();

/** Branded string for message identifiers (UUID). */
export type MessageId = string & { readonly __messageId: unique symbol };
export const MessageId = z.string().brand<MessageId>();

/** Branded string for file identifiers. */
export type ProtocolFileId = string & { readonly __protocolFileId: unique symbol };
export const ProtocolFileId = z.string().brand<ProtocolFileId>();

/** Branded string for event identifiers (UUID). */
export type EventId = string & { readonly __eventId: unique symbol };
export const EventIdSchema = z.string().brand<EventId>();

/** Branded string for transfer identifiers (UUID). */
export type TransferId = string & { readonly __transferId: unique symbol };
export const TransferId = z.string().brand<TransferId>();

/** Branded string for snapshot identifiers. */
export type SnapshotId = string & { readonly __snapshotId: unique symbol };
export const SnapshotId = z.string().brand<SnapshotId>();

// ── Mapping helpers ────────────────────────────────────────────────
//
// `packages/protocol` is deliberately zero-dependency on `@repo/core`, so it
// cannot reuse core's branded types (FileId, ShardIndex, etc.). These thin
// adapters exist at the boundary where the two packages actually meet. They
// are branded casts — callers MUST only use them with values already known to
// be valid identifiers; they perform no validation.

/** Map a core FileId (or any string) into the protocol's branded FileId. */
export function toProtocolFileId(value: string): ProtocolFileId {
  return value as ProtocolFileId;
}

/** Map a protocol FileId back into a plain string for core consumers. */
export function fromProtocolFileId(value: ProtocolFileId): string {
  return value;
}
