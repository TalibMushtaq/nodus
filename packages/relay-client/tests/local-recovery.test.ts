import { ed25519 } from "@noble/curves/ed25519.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NodeClient, NodeClientError, createDeviceIdentity, identityPrivateKey, identityPublicKey } from "../src/index.js";

const ORIGINAL_FETCH = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromHex(value: string): Uint8Array {
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

const recovery = ed25519.utils.randomPrivateKey();
const recoveryPublic = ed25519.getPublicKey(recovery);

describe("NodeClient offline recovery", () => {
  it("fetches a recovery challenge", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        nonce: "abc",
        ttl_seconds: 30,
        account_id: "acct-1",
        recovery_public_key: b64(recoveryPublic),
      }),
    );

    const challenge = await new NodeClient("http://192.168.1.10:9378").recoveryChallenge();

    expect(challenge.account_id).toBe("acct-1");
    expect(challenge.recovery_public_key).toBe(b64(recoveryPublic));
    expect(challenge.nonce).toBe("abc");
  });

  it("signs the nonce with the recovery seed when recovering", async () => {
    const device = createDeviceIdentity();
    let body: { nonce: string; signature: string; device_id: string; device_public_key: string } | null = null;
    globalThis.fetch = vi.fn(async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse({ status: "ok", account_id: "acct-1", device_id: device.device_id });
    });

    const result = await new NodeClient("http://192.168.1.10:9378").recover({
      deviceId: device.device_id,
      devicePublicKey: identityPublicKey(device),
      nonce: "nonce-123",
      recoveryPrivateSeed: recovery,
    });

    expect(result.status).toBe("ok");
    expect(body!.device_id).toBe(device.device_id);
    expect(body!.nonce).toBe("nonce-123");
    // The signature must verify against the recovery public key over the nonce.
    const valid = ed25519.verify(fromHex(body!.signature), new TextEncoder().encode("nonce-123"), recoveryPublic);
    expect(valid).toBe(true);
  });

  it("signs the recovery-envelopes request with the device key", async () => {
    const device = createDeviceIdentity();
    let headers: Record<string, string> = {};
    globalThis.fetch = vi.fn(async (_url, init) => {
      headers = (init?.headers ?? {}) as Record<string, string>;
      return jsonResponse({
        file_envelopes: [
          { file_id: "f1", recipient_id: "rec", recipient_kind: "recovery", encrypted_key: "opaque" },
        ],
        folder_envelopes: [],
      });
    });

    const envelopes = await new NodeClient("http://192.168.1.10:9378").recoveryEnvelopes(
      device.device_id,
      identityPrivateKey(device),
    );

    expect(envelopes.file_envelopes[0]!.file_id).toBe("f1");
    // The signed message binds device, purpose and timestamp.
    const timestamp = Number(headers["x-nodus-timestamp"]);
    const message = `${device.device_id}:recovery-envelopes:${timestamp}`;
    const valid = ed25519.verify(
      fromHex(headers["x-nodus-signature"]!),
      new TextEncoder().encode(message),
      identityPublicKey(device),
    );
    expect(valid).toBe(true);
  });

  it("maps a non-ok recovery response to a NodeClientError", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ error: "bad_signature", message: "nope" }, 400),
    );

    await expect(
      new NodeClient("http://192.168.1.10:9378").recover({
        deviceId: "d",
        devicePublicKey: new Uint8Array(32),
        nonce: "n",
        recoveryPrivateSeed: recovery,
      }),
    ).rejects.toBeInstanceOf(NodeClientError);
  });
});
