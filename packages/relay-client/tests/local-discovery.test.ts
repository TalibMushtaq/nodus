import { ed25519 } from "@noble/curves/ed25519.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NodeClient,
  NodeClientError,
  nodusBaseUrl,
  parsePairingUrl,
} from "../src/index.js";

import {
  createDeviceIdentity,
  deriveDeviceId,
  identityPrivateKey,
  identityPublicKey,
} from "../src/index.js";

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

const ORIGINAL_FETCH = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("nodusBaseUrl", () => {
  it("normalizes hosts to the fixed local port", () => {
    expect(nodusBaseUrl("192.168.1.10")).toBe("http://192.168.1.10:9378");
    expect(nodusBaseUrl("  http://node.local/ ")).toBe("http://node.local:9378");
  });
});

describe("parsePairingUrl", () => {
  it("parses a valid nodus://pair deep link", () => {
    const parts = parsePairingUrl(
      "nodus://pair?node_id=abc123&pubkey=c2hvcnQ=&token=tok-1",
    );
    expect(parts).toEqual({
      node_id: "abc123",
      pubkey: "c2hvcnQ=",
      token: "tok-1",
    });
  });

  it("rejects malformed links", () => {
    expect(parsePairingUrl("https://example.com/not-nodus")).toBeNull();
    expect(parsePairingUrl("nodus://pair?token=only-token")).toBeNull();
    expect(parsePairingUrl("not a url")).toBeNull();
  });
});

describe("device identity", () => {
  it("produces a stable, derivable device id from the public key", () => {
    const id = createDeviceIdentity();
    const pub = identityPublicKey(id);
    expect(id.device_id).toHaveLength(16);
    expect(id.device_id).toBe(deriveDeviceId(pub));
  });

  it("round-trips the private key through storage strings", () => {
    const id = createDeviceIdentity();
    const priv = identityPrivateKey(id);
    expect(priv.length).toBe(32);
    expect(ed25519.getPublicKey(priv)).toEqual(identityPublicKey(id));
  });
});

describe("NodeClient", () => {
  it("pair posts the base64 device key and parses the confirm", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          node_id: "n1",
          account_id: "local_push",
          device_id: "d1",
          device_public_key: hex(new Uint8Array(32).fill(1)),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchMock;

    const client = new NodeClient("http://192.168.1.10:9378");
    const pubkey = new Uint8Array(32).fill(1);
    const result = await client.pair("tok-9", "n1", "d1", pubkey);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://192.168.1.10:9378/nodus/pair");
    const body = JSON.parse(String(init.body)) as Record<string, string>;
    expect(body.token).toBe("tok-9");
    expect(body.device_public_key).toBe(b64(pubkey));
    expect(result).toHaveProperty("node_id", "n1");
  });

  it("authenticate signs the issued nonce with the device key", async () => {
    const privateKey = ed25519.utils.randomPrivateKey();
    const publicKey = ed25519.getPublicKey(privateKey);
    const nonce = "0123456789abcdef0123456789abcdef";

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ nonce, ttl_seconds: 30 }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "ok", node_id: "n1" }), {
          status: 200,
        }),
      );
    globalThis.fetch = fetchMock;

    const client = new NodeClient("http://192.168.1.10:9378");
    // ADR-0008: callers supply a signer, not a private key.
    await client.authenticate("d1", (message) =>
      hex(ed25519.sign(new TextEncoder().encode(message), privateKey)),
    );

    // 1st call : challenge, 2nd: auth with a signature over the nonce bytes.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const authCall = fetchMock.mock.calls[1] as [string, RequestInit];
    const auth = JSON.parse(String(authCall[1].body)) as {
      device_id: string;
      nonce: string;
      signature: string;
    };
    expect(authCall[0]).toBe("http://192.168.1.10:9378/nodus/auth");
    expect(auth.device_id).toBe("d1");
    expect(auth.nonce).toBe(nonce);
    const sig = new Uint8Array(
      auth.signature.match(/../g)!.map((b) => parseInt(b, 16)),
    );
    expect(ed25519.verify(sig, new TextEncoder().encode(nonce), publicKey)).toBe(
      true,
    );
  });

  it("maps node error bodies to NodeClientError with the error code", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: "key_mismatch", message: "nope" }), {
          status: 400,
        }),
      );
    const client = new NodeClient("http://192.168.1.10:9378");
    await expect(client.pair("t", "n1", "d1", new Uint8Array(32))).rejects.toMatchObject({
      code: "key_mismatch",
      message: "nope",
    });
  });
});

describe("NodeClient.fetchShard idle timeout", () => {
  const sign = async () => "00";

  /**
   * Mock `fetch` with a body stream built from the request's AbortSignal. A real
   * fetch errors the body stream when its signal aborts; mirroring that lets the
   * idle-timeout abort interrupt a pending `reader.read()`.
   */
  function mockFetchStream(
    makeStream: (signal: AbortSignal) => ReadableStream<Uint8Array>,
    contentLength: number,
  ): void {
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const signal = init?.signal ?? new AbortController().signal;
      return new Response(makeStream(signal), {
        headers: { "content-length": String(contentLength) },
      });
    }) as unknown as typeof fetch;
  }

  function signalAwareStream(
    signal: AbortSignal,
    pull: (controller: ReadableStreamDefaultController<Uint8Array>) => Promise<void>,
  ): ReadableStream<Uint8Array> {
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
    signal.addEventListener("abort", () => {
      controllerRef?.error(new DOMException("aborted", "AbortError"));
    });
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef = controller;
      },
      pull,
    });
  }

  it("is an idle timeout: a slow shard that keeps making progress completes", async () => {
    vi.useFakeTimers();
    const chunks = [new Uint8Array([0]), new Uint8Array([1]), new Uint8Array([2])];
    let sent = 0;
    mockFetchStream(
      (signal) =>
        signalAwareStream(signal, async (controller) => {
          if (sent >= chunks.length) {
            controller.close();
            return;
          }
          const chunk = chunks[sent++];
          // 4 s between chunks is under the 15 s idle window, even though the
          // whole transfer (8 s) exceeds the old 3 s fixed budget.
          if (sent > 1) await new Promise((resolve) => setTimeout(resolve, 4_000));
          controller.enqueue(chunk);
        }),
      chunks.length,
    );
    const client = new NodeClient("http://node.test:9378");
    const promise = client.fetchShard("dev-1", sign, "a".repeat(64));

    await vi.advanceTimersByTimeAsync(20_000);

    await expect(promise).resolves.toEqual(new Uint8Array([0, 1, 2]));
  });

  it("fails a shard that stops making progress", async () => {
    vi.useFakeTimers();
    let sent = false;
    mockFetchStream(
      (signal) =>
        signalAwareStream(signal, async (controller) => {
          if (!sent) {
            sent = true;
            controller.enqueue(new Uint8Array([0]));
            return;
          }
          // Never resolve: the connection stalls with no further bytes.
          await new Promise(() => {});
        }),
      5,
    );
    const client = new NodeClient("http://node.test:9378");
    const promise = client.fetchShard("dev-1", sign, "a".repeat(64));
    const rejection = expect(promise).rejects.toThrow(/abort/i);

    await vi.advanceTimersByTimeAsync(20_000);

    await rejection;
  });

  it("rejects immediately when the caller signal is already aborted", async () => {
    mockFetchStream((signal) => signalAwareStream(signal, async () => {}), 1);
    const client = new NodeClient("http://node.test:9378");
    const controller = new AbortController();
    controller.abort();

    await expect(
      client.fetchShard("dev-1", sign, "a".repeat(64), undefined, controller.signal),
    ).rejects.toBeInstanceOf(NodeClientError);
  });
});