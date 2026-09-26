import { z } from "zod";

// ── Error codes ────────────────────────────────────────────────────

/**
 * Machine-readable error codes for the generic `error` message envelope.
 * Each code maps to a distinct failure category so consumers can route
 * retry/fallback logic without parsing free-text messages.
 *
 * The set is the union of the generic envelope vocabulary and every code the
 * Relay actually emits. It has to be that union: `ErrorCodeSchema` is closed, so
 * a code the Relay sends but this list omits makes a client that validates
 * `ErrorPayloadSchema` reject an envelope it should have understood.
 *
 * `AUTH_FAILURE` keeps this category's name but carries the Relay's wire value,
 * `auth_failed`. The Relay has always sent that spelling; only the docs said
 * `auth_failure`, and no client could have been depending on it because the value
 * was not in this schema to begin with. See `errorCodesEmittedByRelay` in
 * `services/relay/internal/handler/error_codes_test.go`, which fails if the Relay
 * emits a code that is not listed here.
 */
export const ErrorCodes = {
  // Generic envelope vocabulary.
  VALIDATION_ERROR: "validation_error",
  UNKNOWN_MESSAGE_TYPE: "unknown_message_type",
  INCOMPATIBLE_VERSION: "incompatible_version",
  NOT_FOUND: "not_found",
  RATE_LIMITED: "rate_limited",
  INTERNAL_ERROR: "internal_error",
  // Emitted by the Relay. AUTH_FAILURE's value is the Relay's, not the docs'.
  AUTH_FAILURE: "auth_failed",
  // Snapshot transfer and rebuild.
  INVALID_CURSOR_MAP: "invalid_cursor_map",
  INVALID_SNAPSHOT_SEQUENCE: "invalid_snapshot_sequence",
  STALE_SNAPSHOT: "stale_snapshot",
  REBUILD_IN_PROGRESS: "rebuild_in_progress",
} as const;

export const ErrorCodeSchema = z.enum([
  ErrorCodes.VALIDATION_ERROR,
  ErrorCodes.UNKNOWN_MESSAGE_TYPE,
  ErrorCodes.INCOMPATIBLE_VERSION,
  ErrorCodes.NOT_FOUND,
  ErrorCodes.RATE_LIMITED,
  ErrorCodes.INTERNAL_ERROR,
  ErrorCodes.AUTH_FAILURE,
  ErrorCodes.INVALID_CURSOR_MAP,
  ErrorCodes.INVALID_SNAPSHOT_SEQUENCE,
  ErrorCodes.STALE_SNAPSHOT,
  ErrorCodes.REBUILD_IN_PROGRESS,
]);

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

// ── Error payload ──────────────────────────────────────────────────

export const ErrorPayloadSchema = z.object({
  /** message_id of the original message that caused this error, for correlation */
  correlation_id: z.string(),
  error_code: ErrorCodeSchema,
  /** Human-readable description; not for programmatic routing */
  error_message: z.string(),
  /** Whether the sender should retry the original request */
  retryable: z.boolean().optional(),
});

export type ErrorPayload = z.infer<typeof ErrorPayloadSchema>;

// ── Error message envelope ─────────────────────────────────────────

/**
 * Generic error/rejection envelope. When a receiver cannot process a message
 * (validation failure, unknown type, version mismatch, auth rejection, etc.)
 * it sends this message back instead of a type-specific response.
 *
 * This avoids forcing every ack/message type to double as an error carrier,
 * giving Rust/Go/TS consumers a single, consistent error handling path.
 */
export const ErrorMessageSchema = z.object({
  type: z.literal("error"),
  schema_version: z.string(),
  message_id: z.string(),
  timestamp: z.string().datetime().optional(),
  payload: ErrorPayloadSchema,
});

export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;

// ── ProtocolError class ────────────────────────────────────────────

/**
 * Typed error class wrapping a structured protocol error.
 * Thrown by `parseMessage` when the error is fatal and the message cannot be
 * dispatched at all (e.g. unknown type, version mismatch). For validation
 * errors on individual fields, `parseMessage` returns a structured result
 * instead of throwing.
 */
export class ProtocolError extends Error {
  readonly code: ErrorCode;
  readonly correlationId?: string;
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    opts?: { correlationId?: string; retryable?: boolean },
  ) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
    this.correlationId = opts?.correlationId;
    this.retryable = opts?.retryable ?? false;
  }
}
