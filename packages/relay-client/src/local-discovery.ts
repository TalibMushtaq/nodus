//! Client-side helpers for talking to a Storage Node's *local* HTTP listener.
//!
//! Transport split (design decision F): these are HTTP-only contracts over
//! `http://<host>:9378/nodus/*`, deliberately NOT part of the WebSocket
//! envelope catalog — they are the LAN-side trust boundary for pairing and
//! re-authentication against a single node device trusts.

import { ed25519 } from "@noble/curves/ed25519.js";
import {
  type LocalChallengePayload,
  LocalChallengeResponsePayloadSchema,
  type LocalDiscoveryAdvertisement,
  LocalDiscoveryAdvertisementSchema,
  PairingRequestPayloadSchema,
} from "@repo/protocol";

/** Fixed local listener port, mirrors `LOCAL_PORT` in the Rust node. */
export const NODUS_LOCAL_PORT = 9378;

/** Default ad-hoc probe/reachability timeout for LAN requests. */
const LOCAL_TIMEOUT_MS = 3_000;

/**
 * Build the base URL for a discovered/mannually-entered node.
 * Host is whatever the discovery source produced (IP or hostname); the port
 * is fixed by the protocol. DNS-rebinding hardening for browsers is a web-app
 * concern (see apps/web), not something this helper can enforce.
 */
export function nodusBaseUrl(host: string, port: number = NODUS_LOCAL_PORT): string {
  const trimmed = host.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return `http://${trimmed}:${port}`;
}

/**
 * Fetch + validate `GET /nodus/discovery`. Used by discovery UIs (manual IP
 * fallback) and by pairing to confirm the probed node before any token is
 * presented. `pk_fp` (when present) lets a client cross-check against the
 * mDNS TXT record cheaply.
 */
export async function fetchAdvertisement(
  baseUrl: string,
  timeoutMs: number = LOCAL_TIMEOUT_MS,
): Promise<LocalDiscoveryAdvertisement> {
  const res = await fetch(`${baseUrl}/nodus/discovery`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`discovery failed: HTTP ${res.status}: ${await res.text()}`);
  }
  const parsed = LocalDiscoveryAdvertisementSchema.safeParse(await res.json());
  if (!parsed.success) {
    throw new Error(`node returned an invalid advertisement: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** Parse a `nodus://pair?...` QR deep link produced by the pairing UI. */
export interface PairingUrlParts {
  node_id: string;
  /** Raw device pubkey, base64 (matches the QR url spec, decision C) */
  pubkey?: string;
  token: string;
}

export function parsePairingUrl(href: string): PairingUrlParts | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "nodus:" || url.hostname !== "pair") {
    return null;
  }
  const node_id = url.searchParams.get("node_id") ?? "";
  const token = url.searchParams.get("token") ?? "";
  if (!node_id || !token) {
    return null;
  }
  return {
    node_id,
    token,
    pubkey: url.searchParams.get("pubkey") ?? undefined,
  };
}

/** Uniform `{ error, message }` JSON error body the node's HTTP handlers use. */
interface NodeErrorBody {
  error?: string;
  message?: string;
}

export class NodeClientError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "NodeClientError";
    this.code = code;
  }
}

/**
 * Thin typed client over the node's local HTTP API. One instance per node
 * base URL; constructed after discovery or manual entry.
 */
export class NodeClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  /** `GET /nodus/discovery`. */
  discovery(): ReturnType<typeof fetchAdvertisement> {
    return fetchAdvertisement(this.baseUrl);
  }

  /** `POST /nodus/challenge` — obtain a fresh single-use nonce. */
  async challenge(timeoutMs: number = LOCAL_TIMEOUT_MS): Promise<LocalChallengePayload> {
    return this.post<LocalChallengePayload>("/nodus/challenge", {}, timeoutMs);
  }

  /**
   * `POST /nodus/auth` — prove this device's identity on the LAN. The nonce
   * is signed with the device's Ed25519 private key (the whole point is that
   * the private key never leaves the client). The node verifies against the
   * public key recorded at pairing time and consumes the nonce.
   */
  async authenticate(
    deviceId: string,
    privateKey: Uint8Array,
  ): Promise<{ ok: true } & Record<string, unknown>> {
    const { nonce } = await this.challenge();
    const message = new TextEncoder().encode(nonce);
    const signature = toHex(ed25519.sign(message, privateKey));
    // Parsed (not type-cast) so the branded DeviceId is applied by DesignIdSchema.
    const body = LocalChallengeResponsePayloadSchema.parse({
      device_id: deviceId,
      nonce,
      signature,
    });
    return this.post("/nodus/auth", body);
  }

  /**
   * `POST /nodus/pair` — redeem a Relay-issued token and record this device
   * as trusted. The node verifies the presented public key matches the key
   * the token was bound to at issuance (device-mismatch rejection).
   */
  pair(
    token: string,
    nodeId: string,
    deviceId: string,
    publicKey: Uint8Array,
    timeoutMs: number = LOCAL_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    const body = PairingRequestPayloadSchema.parse({
      node_id: nodeId,
      token,
      device_id: deviceId,
      device_public_key: base64Encode(publicKey),
    });
    return this.post("/nodus/pair", body, timeoutMs);
  }

  private async post<T>(
    path: string,
    body: unknown,
    timeoutMs: number = LOCAL_TIMEOUT_MS,
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new NodeClientError(
        "network_error",
        `request to ${path} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      let parsed: NodeErrorBody;
      try {
        parsed = (await res.json()) as NodeErrorBody;
      } catch {
        // Keep the raw text; a non-JSON error is still informative.
        parsed = { message: (await res.text().catch(() => "")) || undefined };
      }
      throw new NodeClientError(
        parsed.error ?? "http_error",
        parsed.message ?? `HTTP ${res.status}`,
      );
    }
    return (await res.json()) as T;
  }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function base64Encode(bytes: Uint8Array): string {
  // Chunked btoa keeps byte count under 2^24 (stack-overflow safe in browsers
  // and workers). Keys here are 32 bytes, but chunking costs nothing and
  // removes a latent footgun if this helper is reused for larger payloads.
  let bin = "";
  for (const b of bytes) {
    bin += String.fromCharCode(b);
  }
  return btoa(bin);
}