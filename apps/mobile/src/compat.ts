/**
 * Hermes on RN 0.86 does not ship every browser/Node global the
 * `@repo/relay-client` package assumes (it is shared with the web app):
 * `btoa`/`atob`, `TextEncoder`, and the static `AbortSignal.timeout`.
 *
 * Each shim is installed only when the global is actually missing, so a future
 * RN that grows native implementations wins. Everything here is pure JS — no
 * extra native dependency needed to talk to a LAN storage node.
 */

import { getRandomValues, randomUUID } from "expo-crypto";
import SSEEventSource from "react-native-sse";

const g = globalThis as Record<PropertyKey, unknown>;

// ── base64 (RFC 4648) ───────────────────────────────────────────────────────
// The wire format for device public keys is base64; relay-client encodes with
// `btoa` and decodes with `atob`, neither of which ships with Hermes.
const B64_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

if (typeof g.btoa !== "function") {
  g.btoa = (input: string) => {
    const bytes = new Uint8Array(input.length);
    for (let i = 0; i < input.length; i += 1) {
      bytes[i] = input.charCodeAt(i) & 0xff;
    }
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i];
      const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
      const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
      out += B64_CHARS[b0 >> 2];
      out += B64_CHARS[((b0 & 0x03) << 4) | (b1 >> 4)];
      out += i + 1 < bytes.length ? B64_CHARS[((b1 & 0x0f) << 2) | (b2 >> 6)] : "=";
      out += i + 2 < bytes.length ? B64_CHARS[b2 & 0x3f] : "=";
    }
    return out;
  };
}

if (typeof g.atob !== "function") {
  g.atob = (input: string): string => {
    const clean = input.replace(/=+$/, "");
    const lookup = new Map<string, number>();
    for (let i = 0; i < B64_CHARS.length; i += 1) {
      lookup.set(B64_CHARS[i], i);
    }
    const out: number[] = [];
    for (let i = 0; i < clean.length; i += 4) {
      const c0 = lookup.get(clean[i]) ?? 0;
      const c1 = lookup.get(clean[i + 1] ?? "") ?? 0;
      const c2 = lookup.get(clean[i + 2] ?? "") ?? 0;
      const c3 = lookup.get(clean[i + 3] ?? "") ?? 0;
      out.push((c0 << 2) | (c1 >> 4));
      if (i + 2 < clean.length) out.push(((c1 & 0x0f) << 4) | (c2 >> 2));
      if (i + 3 < clean.length) out.push(((c2 & 0x03) << 6) | c3);
    }
    return String.fromCharCode(...out);
  };
}

// ── UTF-8 encoder ───────────────────────────────────────────────────────────
// `NodeClient.authenticate` signs the nonce's UTF-8 bytes, so Hermes needs a
// TextEncoder. The signing preimage is ASCII hex, but implement general UTF-8
// so this shim is not loaded with a wrong assumption.
if (typeof g.TextEncoder === "undefined") {
  class TextEncoderImpl {
    readonly encoding = "utf-8";
    encode(input?: string): Uint8Array {
      const str = input ?? "";
      const bytes: number[] = [];
      for (let i = 0; i < str.length; i += 1) {
        let code = str.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
          const next = str.charCodeAt(i + 1);
          if (next >= 0xdc00 && next <= 0xdfff) {
            code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
            i += 1;
          }
        }
        if (code < 0x80) {
          bytes.push(code);
        } else if (code < 0x800) {
          bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
        } else if (code < 0x10000) {
          bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
        } else {
          bytes.push(
            0xf0 | (code >> 18),
            0x80 | ((code >> 12) & 0x3f),
            0x80 | ((code >> 6) & 0x3f),
            0x80 | (code & 0x3f),
          );
        }
      }
      return Uint8Array.from(bytes);
    }
  }
  g.TextEncoder = TextEncoderImpl;
}

// ── AbortSignal.timeout ─────────────────────────────────────────────────────
// relay-client uses `AbortSignal.timeout(ms)` as its request deadline. RN
// ships AbortController/AbortSignal, but not the static `.timeout` helper.
const AbortSignalGlobal = g.AbortSignal as
  | { timeout?: (ms: number) => AbortSignal }
  | undefined;
if (AbortSignalGlobal && typeof AbortSignalGlobal.timeout !== "function") {
  AbortSignalGlobal.timeout = (ms: number): AbortSignal => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(`AbortSignal timed out after ${ms}ms`));
    }, ms);
    const signal = controller.signal;
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
      },
      { once: true },
    );
    return signal;
  };
}

// ── UTF-8 decoder ───────────────────────────────────────────────────────────
// @repo/core's decryptName reads plaintext filenames back out with
// `TextDecoder`, which Hermes does not provide.
if (typeof g.TextDecoder === "undefined") {
  class TextDecoderImpl {
    readonly encoding = "utf-8";
    decode(input?: ArrayBuffer | ArrayBufferView): string {
      if (!input) return "";
      const bytes =
        input instanceof ArrayBuffer
          ? new Uint8Array(input)
          : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      let out = "";
      for (let i = 0; i < bytes.length; ) {
        const byte = bytes[i]!;
        let code: number;
        if (byte < 0x80) {
          code = byte;
          i += 1;
        } else if (byte < 0xe0) {
          code = ((byte & 0x1f) << 6) | (bytes[i + 1]! & 0x3f);
          i += 2;
        } else if (byte < 0xf0) {
          code = ((byte & 0x0f) << 12) | ((bytes[i + 1]! & 0x3f) << 6) | (bytes[i + 2]! & 0x3f);
          i += 3;
        } else {
          code =
            ((byte & 0x07) << 18) |
            ((bytes[i + 1]! & 0x3f) << 12) |
            ((bytes[i + 2]! & 0x3f) << 6) |
            (bytes[i + 3]! & 0x3f);
          i += 4;
        }
        if (code > 0xffff) {
          const adjusted = code - 0x10000;
          out += String.fromCharCode(0xd800 + (adjusted >> 10), 0xdc00 + (adjusted & 0x3ff));
        } else {
          out += String.fromCharCode(code);
        }
      }
      return out;
    }
  }
  g.TextDecoder = TextDecoderImpl;
}

// ── Web Crypto subset ───────────────────────────────────────────────────────
// @noble/* and the SDK call `crypto.getRandomValues` (key generation, UUIDs)
// and `crypto.randomUUID`. Hermes ships neither; expo-crypto provides both.
const cryptoGlobal = (g.crypto as Record<string, unknown> | undefined) ?? {};
if (typeof cryptoGlobal.getRandomValues !== "function") {
  cryptoGlobal.getRandomValues = getRandomValues;
}
if (typeof cryptoGlobal.randomUUID !== "function") {
  cryptoGlobal.randomUUID = randomUUID;
}
g.crypto = cryptoGlobal;

// ── EventSource ─────────────────────────────────────────────────────────────
// Path A trickles inbound ICE candidates over SSE. React Native has no
// EventSource, so @repo/webrtc-transport's local signaling would otherwise
// never open its candidate stream and a direct LAN transfer could not
// negotiate; react-native-sse fills exactly that gap.
if (typeof g.EventSource === "undefined") {
  g.EventSource = SSEEventSource;
}