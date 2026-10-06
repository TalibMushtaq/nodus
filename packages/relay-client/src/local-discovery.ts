//! Client-side helpers for talking to a Storage Node's *local* HTTP listener.
//!
//! Transport split (design decision F): these are HTTP-only contracts over
//! `http://<host>:9378/nodus/*`, deliberately NOT part of the WebSocket
//! envelope catalog — they are the LAN-side trust boundary for pairing and
//! re-authentication against a single node device trusts.

import { ed25519 } from "@noble/curves/ed25519.js";
import {
  type ActivityRecord,
  ActivityListSchema,
  type LocalChallengePayload,
  LocalChallengePayloadSchema,
  LocalChallengeResponsePayloadSchema,
  localNodeAuthMessage,
  LocalDiscoveryAdvertisementSchema,
  localPairConfirmMessage,
  localWebRtcAnswerMessage,
  type LocalDiscoveryAdvertisement,
  type LocalRecoveryChallenge,
  type LocalRecoveryEnvelopes,
  LocalRecoveryEnvelopesSchema,
  type LocalRecoveryResult,
  type LocalRecoveryRequest,
  PairingRequestPayloadSchema,
} from "@repo/protocol";

/** Fixed local listener port, mirrors `LOCAL_PORT` in the Rust node. */
export const NODUS_LOCAL_PORT = 9378;

/** Default ad-hoc probe/reachability timeout for LAN requests. */
const LOCAL_TIMEOUT_MS = 3_000;

/**
 * Idle window for a LAN shard download (`fetchShard`). Unlike a total deadline,
 * this resets on every chunk, so a multi-MiB shard may take as long as it needs
 * while a stalled connection still fails. The plain 3 s probe budget was used as
 * a hard total timeout here, aborting large shards mid-body and pushing them
 * onto the Relay fallback (which buffers the whole shard before sending).
 */
const SHARD_IDLE_TIMEOUT_MS = 15_000;

/**
 * Signs a message's UTF-8 bytes and returns a hex-encoded Ed25519 signature.
 * Web passes a non-extractable WebCrypto handle (ADR-0008); mobile passes a
 * noble-based wrapper over its keychain seed.
 */
export type DeviceMessageSigner = (message: string) => string | Promise<string>;

/**
 * Build the base URL for a discovered/mannually-entered node.
 * Host is whatever the discovery source produced (IP or hostname); the port
 * is fixed by the protocol. A path/query and any userinfo are stripped because
 * `device@other` would otherwise redirect signed requests to `other`; only a
 * bare host survives. DNS-rebinding hardening for browsers is a web-app concern
 * (see apps/web), not something this helper can enforce.
 */
export function nodusBaseUrl(host: string, port: number = NODUS_LOCAL_PORT): string {
  const trimmed = host
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/[/?#].*$/, "")
    .replace(/\/+$/, "");
  if (!trimmed || trimmed.includes("@")) {
    throw new Error(`invalid node host: ${host}`);
  }
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
 * The node's `node_id` is defined as the lowercase hex of its Ed25519 public
 * key (Rust `identity::load_or_generate`). Checking that invariant is what
 * binds an advertisement to the key it presents: an actively spoofing host
 * cannot claim the real node's id without also presenting the real public key,
 * which it cannot sign with.
 */
export function nodeIdMatchesPublicKey(nodeId: string, publicKey: string): boolean {
  return nodeId.toLowerCase() === publicKey.toLowerCase();
}

/**
 * Verify a `POST /nodus/challenge` response proves the responder holds the
 * node's private key. Throws `NodeClientError` when the response is unsigned,
 * self-inconsistent (`node_id !== public_key`), names a different key than
 * `expectedNodePublicKey`, or carries an invalid signature.
 *
 * This is the missing half of the LAN trust model: `/nodus/auth` proves the
 * *device* to the node, and this proves the *node* to the device, so a rogue
 * host on the LAN cannot impersonate a real node.
 */
export function verifyNodeChallenge(
  challenge: Pick<
    LocalChallengePayload,
    "nonce" | "node_id" | "public_key" | "node_signature"
  >,
  expectedNodePublicKey?: string | null,
): void {
  const { nonce, node_id, public_key, node_signature } = challenge;
  if (!node_id || !public_key || !node_signature) {
    throw new NodeClientError(
      "node_unauthenticated",
      "node did not prove its identity (unsigned challenge)",
    );
  }
  if (!nodeIdMatchesPublicKey(node_id, public_key)) {
    throw new NodeClientError(
      "node_identity_mismatch",
      "node challenge is self-inconsistent (node_id does not match its public key)",
    );
  }
  if (expectedNodePublicKey && !nodeIdMatchesPublicKey(expectedNodePublicKey, public_key)) {
    throw new NodeClientError(
      "node_identity_mismatch",
      "node presented a different public key than expected",
    );
  }
  const message = new TextEncoder().encode(localNodeAuthMessage(nonce));
  if (!verifyHexSignature(node_signature, message, public_key)) {
    throw new NodeClientError("node_identity_mismatch", "node challenge signature is invalid");
  }
}

/**
 * Verify the node's signature over a `POST /nodus/pair` confirm. Like
 * [`verifyNodeChallenge`], this makes the node prove key possession; a rogue
 * host cannot sign the confirm even though it can redeem the Relay-issued,
 * device-bound token.
 */
export function verifyPairConfirm(
  confirm: {
    node_id?: string;
    device_id?: string;
    device_public_key?: string;
    node_signature?: string;
  },
  expectedNodePublicKey?: string | null,
): void {
  const { node_id, device_id, device_public_key, node_signature } = confirm;
  if (!node_id || !device_id || !device_public_key || !node_signature) {
    throw new NodeClientError(
      "node_unauthenticated",
      "node pairing confirm was not signed",
    );
  }
  if (expectedNodePublicKey && !nodeIdMatchesPublicKey(node_id, expectedNodePublicKey)) {
    throw new NodeClientError(
      "node_identity_mismatch",
      "node pairing confirm named a different node",
    );
  }
  // The node_id *is* the hex public key, so the signature verifies against it
  // when the caller has no independently pinned key.
  const verifyKey = expectedNodePublicKey ?? node_id;
  const message = new TextEncoder().encode(
    localPairConfirmMessage(node_id, device_id, device_public_key),
  );
  if (!verifyHexSignature(node_signature, message, verifyKey)) {
    throw new NodeClientError(
      "node_identity_mismatch",
      "node pairing confirm signature is invalid",
    );
  }
}

/**
 * Verify the node's signature over a `POST /nodus/webrtc/offer` answer. The
 * signed body binds `session_id` + SDP, so a rogue host answering the offer
 * cannot impersonate the node on the direct path. The node's id is the hex of
 * its public key, so `expectedNodePublicKey` may simply be the node id.
 */
export function verifyWebRtcAnswer(
  answer: { sdp?: string; node_id?: string; node_signature?: string },
  sessionId: string,
  expectedNodePublicKey?: string | null,
): void {
  const { sdp, node_id, node_signature } = answer;
  if (!sdp) {
    throw new NodeClientError("node_unauthenticated", "WebRTC answer is missing its SDP");
  }
  if (!node_id || !node_signature) {
    throw new NodeClientError(
      "node_unauthenticated",
      "WebRTC answer was not signed by the node",
    );
  }
  if (expectedNodePublicKey && !nodeIdMatchesPublicKey(expectedNodePublicKey, node_id)) {
    throw new NodeClientError(
      "node_identity_mismatch",
      "WebRTC answer named a different node than expected",
    );
  }
  const verifyKey = expectedNodePublicKey ?? node_id;
  const message = new TextEncoder().encode(localWebRtcAnswerMessage(sessionId, sdp));
  if (!verifyHexSignature(node_signature, message, verifyKey)) {
    throw new NodeClientError(
      "node_identity_mismatch",
      "WebRTC answer signature is invalid",
    );
  }
}

/**
 * Whether a discovery advertisement genuinely belongs to `expectedNodeId`.
 *
 * A Storage Node's `node_id` *is* the hex of its Ed25519 public key, so a
 * well-formed advertisement must have `public_key === node_id`. Checking that
 * invariant (plus the expected id when known) rejects naive/self-contradictory
 * spoofs. It is not sufficient alone — the caller still verifies a node
 * signature with [`verifyNodeChallenge`]/[`verifyPairConfirm`] — but it is the
 * cheap binding check before any key material is exchanged.
 */
export function advertisementBindsNode(
  adv: { node_id: string; public_key: string },
  expectedNodeId?: string | null,
): boolean {
  const publicKey = adv.public_key.toLowerCase();
  const nodeId = adv.node_id.toLowerCase();
  if (nodeId !== publicKey) return false;
  if (expectedNodeId && nodeId !== expectedNodeId.toLowerCase()) return false;
  return true;
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
    const raw = await this.post<unknown>("/nodus/challenge", {}, timeoutMs);
    // Parse (not cast) so the optional node-identity fields are validated and
    // a malformed body is rejected before it reaches signature verification.
    return LocalChallengePayloadSchema.parse(raw);
  }

  /**
   * `POST /nodus/auth` — prove this device's identity on the LAN. The nonce
   * is signed by the injected signer (a non-extractable key handle on web,
   * ADR-0008); the node verifies against the public key recorded at pairing
   * time and consumes the nonce.
   *
   * Before signing, the node's own identity is verified from the challenge
   * (see [`verifyNodeChallenge`]); pass `expectedNodePublicKey` (the pinned
   * public key for this node) to reject a challenge from a different key.
   */
  async authenticate(
    deviceId: string,
    sign: DeviceMessageSigner,
    expectedNodePublicKey?: string | null,
  ): Promise<{ ok: true } & Record<string, unknown>> {
    const challenge = await this.challenge();
    // Authenticate the node *before* the device commits its signature, so a
    // rogue responder never even receives a device proof.
    verifyNodeChallenge(challenge, expectedNodePublicKey);
    // The signer signs the nonce's exact UTF-8 bytes.
    const signature = await sign(challenge.nonce);
    // Parsed (not type-cast) so the branded DeviceId is applied by DesignIdSchema.
    const body = LocalChallengeResponsePayloadSchema.parse({
      device_id: deviceId,
      nonce: challenge.nonce,
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

  /**
   * `POST /nodus/recovery/challenge` — offline (LAN) recovery challenge
   * (ADR-0002). Returns the account id, the account recovery public key, and a
   * single-use nonce the phrase must sign.
   */
  recoveryChallenge(timeoutMs: number = LOCAL_TIMEOUT_MS): Promise<LocalRecoveryChallenge> {
    return this.post<LocalRecoveryChallenge>("/nodus/recovery/challenge", {}, timeoutMs);
  }

  /**
   * `POST /nodus/recovery` — prove the recovery phrase and register this
   * device locally. Signs the challenge nonce with the phrase-derived recovery
   * seed; the node verifies it against the key it holds.
   */
  recover(
    params: {
      /** The new device's id + Ed25519 public key. */
      deviceId: string;
      devicePublicKey: Uint8Array;
      nonce: string;
      /** Ed25519 seed derived from the recovery phrase. */
      recoveryPrivateSeed: Uint8Array;
    },
    timeoutMs: number = LOCAL_TIMEOUT_MS,
  ): Promise<LocalRecoveryResult> {
    const signature = toHex(ed25519.sign(new TextEncoder().encode(params.nonce), params.recoveryPrivateSeed));
    const body: LocalRecoveryRequest = {
      nonce: params.nonce,
      signature,
      device_id: params.deviceId as LocalRecoveryRequest["device_id"],
      device_public_key: base64Encode(params.devicePublicKey),
    };
    return this.post<LocalRecoveryResult>("/nodus/recovery", body, timeoutMs);
  }

  /**
   * `GET /nodus/recovery/envelopes` — fetch the account's recovery-sealed
   * envelopes using the same stateless signed request as shard fetch, with the
   * message `"{device_id}:recovery-envelopes:{timestamp_ms}"`.
   */
  async recoveryEnvelopes(
    deviceId: string,
    privateKey: Uint8Array,
    timeoutMs: number = LOCAL_TIMEOUT_MS,
  ): Promise<LocalRecoveryEnvelopes> {
    const timestamp = Date.now();
    const message = new TextEncoder().encode(`${deviceId}:recovery-envelopes:${timestamp}`);
    const signature = toHex(ed25519.sign(message, privateKey));
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/nodus/recovery/envelopes`, {
        headers: {
          "x-nodus-device-id": deviceId,
          "x-nodus-timestamp": String(timestamp),
          "x-nodus-signature": signature,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new NodeClientError(
        "network_error",
        `recovery envelope fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      let parsed: NodeErrorBody;
      try {
        parsed = (await res.json()) as NodeErrorBody;
      } catch {
        parsed = { message: (await res.text().catch(() => "")) || undefined };
      }
      throw new NodeClientError(
        parsed.error ?? "http_error",
        parsed.message ?? `HTTP ${res.status}`,
      );
    }
    return LocalRecoveryEnvelopesSchema.parse(await res.json());
  }

  /**
   * `GET /nodus/activities` — the account's activity feed over the LAN, the
   * offline counterpart to the Relay's `GET /activities`. Uses the same
   * stateless signed request as the recovery envelopes, with the message
   * `"{device_id}:activities:{timestamp_ms}"`.
   */
  async listActivities(
    deviceId: string,
    sign: DeviceMessageSigner,
    limit = 200,
    timeoutMs: number = LOCAL_TIMEOUT_MS,
  ): Promise<ActivityRecord[]> {
    const timestamp = Date.now();
    const signature = await sign(`${deviceId}:activities:${timestamp}`);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/nodus/activities?limit=${encodeURIComponent(String(limit))}`, {
        headers: {
          "x-nodus-device-id": deviceId,
          "x-nodus-timestamp": String(timestamp),
          "x-nodus-signature": signature,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new NodeClientError(
        "network_error",
        `activity fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      let parsed: NodeErrorBody;
      try {
        parsed = (await res.json()) as NodeErrorBody;
      } catch {
        parsed = { message: (await res.text().catch(() => "")) || undefined };
      }
      throw new NodeClientError(
        parsed.error ?? "http_error",
        parsed.message ?? `HTTP ${res.status}`,
      );
    }
    return ActivityListSchema.parse(await res.json()).activities;
  }

  /**
   * `GET /nodus/shard/{objectId}` — download a stored encrypted shard
   * (Phase 14 F2b). Uses the same stateless signed request as node-to-node
   * backhaul, but authenticated as a device: the message
   * `"{device_id}:{object_id}:{timestamp_ms}"` is signed with the device's
   * Ed25519 key. The returned bytes are still ciphertext; the caller verifies
   * the BLAKE3 hash and decrypts.
   *
   * `timeoutMs` is an idle window (reset per chunk), not a total deadline, so a
   * large shard can run as long as it keeps making progress.
   */
  async fetchShard(
    deviceId: string,
    sign: DeviceMessageSigner,
    objectId: string,
    onProgress?: (receivedBytes: number, totalBytes: number) => void,
    signal?: AbortSignal,
    timeoutMs: number = SHARD_IDLE_TIMEOUT_MS,
  ): Promise<Uint8Array> {
    const timestamp = Date.now();
    const signature = await sign(`${deviceId}:${objectId}:${timestamp}`);
    // Idle timeout: reset on every chunk so a large shard is not cut off by a
    // fixed budget, but a connection that sends nothing for `timeoutMs` fails.
    // The caller's cancellation signal aborts the same controller immediately;
    // using a manual controller (instead of `AbortSignal.timeout` + `.any`)
    // keeps this working on React Native runtimes that lack `AbortSignal.any`.
    const controller = new AbortController();
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(), timeoutMs);
    };
    const onCallerAbort = () => controller.abort();
    if (signal?.aborted) {
      throw new NodeClientError("network_error", "shard fetch aborted");
    }
    signal?.addEventListener("abort", onCallerAbort);
    armIdle();
    try {
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}/nodus/shard/${encodeURIComponent(objectId)}`, {
          headers: {
            "x-nodus-device-id": deviceId,
            "x-nodus-timestamp": String(timestamp),
            "x-nodus-signature": signature,
          },
          signal: controller.signal,
        });
      } catch (err) {
        throw new NodeClientError(
          "network_error",
          `shard fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!res.ok) {
        let parsed: NodeErrorBody;
        try {
          parsed = (await res.json()) as NodeErrorBody;
        } catch {
          parsed = { message: (await res.text().catch(() => "")) || undefined };
        }
        throw new NodeClientError(
          parsed.error ?? "http_error",
          parsed.message ?? `HTTP ${res.status}`,
        );
      }
      // Stream the body when the runtime exposes a reader (browsers do; React
      // Native's fetch may not), so a large shard reports bytes as they arrive
      // instead of after the whole body lands. A missing reader falls back to the
      // buffered read, which is still correct — just coarse.
      const reader = res.body?.getReader?.();
      if (!reader) {
        return new Uint8Array(await res.arrayBuffer());
      }
      const total = Number(res.headers.get("content-length")) || 0;
      const chunks: Uint8Array[] = [];
      let received = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          // Any chunk is progress: push the idle deadline out.
          armIdle();
          if (value) {
            chunks.push(value);
            received += value.byteLength;
            try {
              onProgress?.(received, total);
            } catch {
              // Advisory only: a throwing subscriber must not abort the read.
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
      const out = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return out;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      signal?.removeEventListener("abort", onCallerAbort);
    }
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

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Verify a hex-encoded Ed25519 signature over `message`. Returns false on any
 * malformed input (bad hex, wrong length, invalid point) instead of throwing,
 * so every node-auth verifier fails closed with the same error path.
 */
function verifyHexSignature(
  signatureHex: string,
  message: Uint8Array,
  publicKeyHex: string,
): boolean {
  try {
    return ed25519.verify(hexToBytes(signatureHex), message, hexToBytes(publicKeyHex));
  } catch {
    return false;
  }
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