import { describe, expect, it } from "vitest";
import {
  ErrorCodeSchema,
  ErrorCodes,
  ErrorPayloadSchema,
  ProtocolError,
} from "../src/errors.js";

// The codes the Relay can put on the wire. Kept in step with
// `errorCodesEmittedByRelay` in
// `services/relay/internal/handler/error_codes_test.go`, which reads them out of
// the Relay's source and fails if one is missing from the enum.
const RELAY_ERROR_CODES = [
  "auth_failed",
  "incompatible_version",
  "internal_error",
  "invalid_cursor_map",
  "invalid_snapshot_sequence",
  "rebuild_in_progress",
  "stale_snapshot",
] as const;

// The generic envelope vocabulary any peer may use.
const GENERIC_ERROR_CODES = [
  "validation_error",
  "unknown_message_type",
  "not_found",
  "rate_limited",
] as const;

describe("ErrorCodeSchema", () => {
  it("accepts every code the Relay emits", () => {
    for (const code of RELAY_ERROR_CODES) {
      expect(
        ErrorCodeSchema.safeParse(code).success,
        `${code} is not in the enum`,
      ).toBe(true);
    }
  });

  it("accepts the generic envelope vocabulary", () => {
    for (const code of GENERIC_ERROR_CODES) {
      expect(
        ErrorCodeSchema.safeParse(code).success,
        `${code} is not in the enum`,
      ).toBe(true);
    }
  });

  it("rejects a code it does not list", () => {
    // The schema is closed on purpose: a code nobody has agreed on should fail
    // loudly rather than pass through as if it were understood.
    expect(ErrorCodeSchema.safeParse("something_new").success).toBe(false);
  });

  it("carries the Relay's spelling for the auth category", () => {
    // The docs used to say `auth_failure`. The Relay sends `auth_failed`, and the
    // key keeps the readable category name, so `ErrorCodes.AUTH_FAILURE` is the
    // name in code and `auth_failed` is the name on the wire.
    expect(ErrorCodes.AUTH_FAILURE).toBe("auth_failed");
  });
});

describe("ErrorPayloadSchema", () => {
  const base = {
    correlation_id: "msg-1",
    error_message: "snapshot signature verification failed",
  };

  it("parses a Relay error the way a strict client would", () => {
    const parsed = ErrorPayloadSchema.parse({
      ...base,
      error_code: "auth_failed",
      retryable: false,
    });
    expect(parsed.error_code).toBe("auth_failed");
    expect(parsed.retryable).toBe(false);
  });

  it.each(RELAY_ERROR_CODES)("parses %s", (code) => {
    expect(() =>
      ErrorPayloadSchema.parse({ ...base, error_code: code }),
    ).not.toThrow();
  });
});

describe("ProtocolError", () => {
  it("carries a code the schema accepts", () => {
    const err = new ProtocolError(ErrorCodes.STALE_SNAPSHOT, "too old", {
      correlationId: "msg-1",
    });
    expect(() => ErrorCodeSchema.parse(err.code)).not.toThrow();
    expect(err.correlationId).toBe("msg-1");
    expect(err.retryable).toBe(false);
  });
});
