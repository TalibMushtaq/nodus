import { z } from "zod";

/**
 * Current canonical schema version for the Nodus wire protocol.
 * Follows semver: major = breaking, minor = additive-only (new optional fields).
 * Rust and Go implementations must match the major version to interoperate.
 */
export const CURRENT_SCHEMA_VERSION = "1.0" as const;

/**
 * @deprecated Phase 9 moved snapshot chunking to a record-count model. Chunks
 * are now bounded by [`SNAPSHOT_CHUNK_MAX_RECORDS`] (`src/messages/snapshot.ts`)
 * rather than a byte budget. This byte constant is retained only as legacy
 * metadata in the generated protocol manifest for backward compatibility; no
 * runtime path uses it.
 */
export const DEFAULT_SNAPSHOT_CHUNK_SIZE = 256 * 1024;

/** Branded type for schema version strings on the wire. */
export type SchemaVersion = string & { readonly __schemaVersion: unique symbol };

/**
 * Zod schema for schema_version strings — major.minor, optionally followed by
 * a `.patch` segment. The Rust Storage Node and Go Relay emit patch-level
 * versions ("1.0.0"); the TS implementation has always used major.minor. Both
 * interop on the same major version, so accept the trailing segment instead of
 * rejecting real peer traffic (Phase 11 relay-client depends on this).
 */
export const SchemaVersionSchema = z
  .string()
  .regex(
    /^\d+\.\d+(\.\d+)?$/,
    'schema_version must be in major.minor format (e.g. "1.0"; a trailing .patch is tolerated)',
  )
  .brand<SchemaVersion>();

/** Parse a raw string into a structured SchemaVersion (ignores patch). */
export function parseVersion(raw: string): { major: number; minor: number } {
  const match = raw.match(/^(\d+)\.(\d+)(?:\.\d+)?$/);
  if (!match) {
    throw new Error(
      `parseVersion: invalid schema version "${raw}", expected major.minor format`,
    );
  }
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/**
 * Determine whether a received schema_version string is compatible with the
 * version the receiver understands (defaults to CURRENT_SCHEMA_VERSION).
 *
 * Compatibility rules:
 * - Different major versions → incompatible (reject the message).
 * - Same major, higher minor → compatible (additive: new optional fields).
 * - Same major, lower minor → compatible (sender is missing no required fields
 *   because minor bumps only add optional ones).
 *
 * Accepts a plain string (not the branded SchemaVersion) so that the string
 * produced by zod's SchemaVersionSchema can be passed directly.
 */
export function isCompatible(
  received: string,
  expected: string = CURRENT_SCHEMA_VERSION,
): boolean {
  const r = parseVersion(received);
  const e = parseVersion(expected);
  return r.major === e.major;
}
