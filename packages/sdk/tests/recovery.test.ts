import { describe, expect, it } from "vitest";
import { generateFileEncryptionKey, normalizeRecoveryPhrase, recoveryIdentityFromPhrase } from "@repo/core";
import { createDeviceIdentity } from "@repo/relay-client";

import { createRecoveryClient, type RecoveryStore } from "../src/recovery/recovery.js";
import { sealFekForRecipientIdentity } from "../src/envelopes/envelopes.js";
import type { RelayHttp, RelayRequestInit, RelayResponse } from "../src/adapters.js";

function fakeHttp(handler: (path: string, init?: RelayRequestInit) => RelayResponse): RelayHttp {
  return {
    async request<T>(path: string, init?: RelayRequestInit): Promise<RelayResponse<T>> {
      return handler(path, init) as RelayResponse<T>;
    },
    publicRelayUrl: () => "https://relay.example",
  };
}

function memoryStore() {
  const saved = new Map<string, string>();
  const store: RecoveryStore = {
    async save(accountId, phrase) {
      saved.set(accountId, phrase);
    },
    async load(accountId) {
      return saved.get(accountId) ?? null;
    },
    async clear(accountId) {
      saved.delete(accountId);
    },
  };
  return { store, saved };
}

describe("recovery client", () => {
  it("recovers with the matching phrase and normalizes the stored phrase", async () => {
    const device = createDeviceIdentity();
    const { store, saved } = memoryStore();
    const keys = new Map<string, Uint8Array>();

    let phrase = "";
    const client = createRecoveryClient({
      http: fakeHttp((path) => {
        if (path === "/auth/recovery/challenge") {
          return { status: 200, ok: true, json: { nonce: "deadbeef", recovery_public_key: client.publicKey(phrase) } };
        }
        if (path === "/auth/recovery") {
          return {
            status: 200,
            ok: true,
            json: { account_id: "acct-1", device_id: device.device_id, session_expires_at: "2030-01-01T00:00:00Z" },
          };
        }
        return { status: 404, ok: false, error: "not found" };
      }),
      store,
      putFileKey: async (id, key) => void keys.set(id, key),
      putFolderKey: async (id, key) => void keys.set(id, key),
    });

    phrase = client.createPhrase();
    const result = await client.recover("a@b.com", phrase, device);
    expect(result.ok).toBe(true);
    expect(result.session?.account_id).toBe("acct-1");

    await client.save("acct-1", phrase);
    expect(saved.get("acct-1")).toBe(normalizeRecoveryPhrase(phrase));
  });

  it("rejects a phrase that does not match the account's recovery key", async () => {
    const device = createDeviceIdentity();
    const { store } = memoryStore();
    const client = createRecoveryClient({
      // Challenge advertises a key that is not the one the user entered.
      http: fakeHttp(() => ({
        status: 200,
        ok: true,
        json: { nonce: "n", recovery_public_key: "not-the-entered-key" },
      })),
      store,
      putFileKey: async () => undefined,
      putFolderKey: async () => undefined,
    });

    const result = await client.recover("a@b.com", client.createPhrase(), device);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/does not match/i);
  });

  it("materializes recovery-sealed file keys from the envelope backup", async () => {
    const { store } = memoryStore();
    const keys = new Map<string, Uint8Array>();
    const fek = generateFileEncryptionKey();

    let phrase = "";
    const recoveryPublic = () => recoveryIdentityFromPhrase(phrase).publicKey;

    const client = createRecoveryClient({
      http: fakeHttp((path) => {
        if (path === "/envelopes/export") {
          return {
            status: 200,
            ok: true,
            json: {
              account_id: "acct-1",
              generated_at: "x",
              file_envelopes: [
                {
                  file_id: "file-1",
                  recipient_id: "recovery",
                  recipient_kind: "recovery",
                  encrypted_key: sealFekForRecipientIdentity(fek, recoveryPublic()),
                },
              ],
              folder_envelopes: [],
            },
          };
        }
        return { status: 404, ok: false };
      }),
      store,
      putFileKey: async (id, key) => void keys.set(id, key),
      putFolderKey: async () => undefined,
    });

    phrase = client.createPhrase();
    const unlocked = await client.materialize(phrase);

    expect(unlocked.files).toBe(1);
    expect(keys.get("file-1")).toEqual(fek);
  });

  it("sends the account password with the recovery key so the Relay can re-authorize", async () => {
    const { store } = memoryStore();
    let body: { recovery_public_key?: string; current_password?: string } | undefined;
    const client = createRecoveryClient({
      http: fakeHttp((path, init) => {
        if (path === "/account/recovery") {
          body = init?.body as typeof body;
          return { status: 200, ok: true, json: {} };
        }
        return { status: 404, ok: false };
      }),
      store,
      putFileKey: async () => undefined,
      putFolderKey: async () => undefined,
    });

    const phrase = client.createPhrase();
    // The Relay drops the previous key's envelope coverage on every rotation, so
    // the password must travel with the request or the Relay rejects the rotation.
    await client.enroll(client.publicKey(phrase), "hunter2-correct");

    expect(body?.current_password).toBe("hunter2-correct");
    expect(body?.recovery_public_key).toBe(client.publicKey(phrase));
  });

  it("surfaces the Relay's error when enrollment is rejected", async () => {
    const { store } = memoryStore();
    const client = createRecoveryClient({
      http: fakeHttp(() => ({ status: 401, ok: false, error: "current password is incorrect" })),
      store,
      putFileKey: async () => undefined,
      putFolderKey: async () => undefined,
    });

    await expect(client.enroll(client.publicKey(client.createPhrase()), "wrong")).rejects.toThrow(
      /current password is incorrect/i,
    );
  });
});
