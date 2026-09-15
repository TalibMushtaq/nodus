import { describe, expect, it } from "vitest";
import { createAuthClient } from "../src/auth.js";
import type { RelayHttp, RelayRequestInit, RelayResponse } from "../src/adapters.js";
import type { StoredDeviceIdentity } from "@repo/relay-client";

const device: StoredDeviceIdentity = {
  device_id: "dev-1",
  public_key: "cHVi",
  private_key: "cHJp",
};

/** Records requests and replays a canned response so we can assert the wire shape. */
function fakeHttp(handler: (path: string, init?: RelayRequestInit) => RelayResponse): RelayHttp {
  return {
    async request<T>(path: string, init?: RelayRequestInit): Promise<RelayResponse<T>> {
      return handler(path, init) as RelayResponse<T>;
    },
    publicRelayUrl: () => "https://relay.example",
  };
}

describe("auth client", () => {
  it("sends device id + public key in the login body and returns the session", async () => {
    let seen: { path: string; init?: RelayRequestInit } | null = null;
    const client = createAuthClient(
      fakeHttp((path, init) => {
        seen = { path, init };
        return {
          status: 200,
          ok: true,
          json: {
            account_id: "acct-1",
            device_id: "dev-1",
            session_expires_at: "2030-01-01T00:00:00Z",
          },
        };
      }),
    );

    const result = await client.login("a@b.com", "password", device);

    expect(result.ok).toBe(true);
    expect(result.session?.account_id).toBe("acct-1");
    expect(seen!.path).toBe("/auth/login");
    expect(seen!.init?.body).toMatchObject({
      email: "a@b.com",
      password: "password",
      device_id: "dev-1",
      device_public_key: "cHVi",
    });
  });

  it("maps a Relay {error} body onto AuthResult.error", async () => {
    const client = createAuthClient(
      fakeHttp(() => ({ status: 401, ok: false, json: { error: "invalid credentials" } })),
    );
    const result = await client.login("a@b.com", "nope", device);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid credentials");
  });

  it("returns null from fetchSession on 401 instead of throwing", async () => {
    const client = createAuthClient(fakeHttp(() => ({ status: 401, ok: false })));
    expect(await client.fetchSession()).toBeNull();
  });

  it("returns the session body from fetchSession on 200", async () => {
    const client = createAuthClient(
      fakeHttp(() => ({
        status: 200,
        ok: true,
        json: {
          account_id: "acct-1",
          device_id: "dev-1",
          session_expires_at: "2030-01-01T00:00:00Z",
        },
      })),
    );
    const session = await client.fetchSession();
    expect(session?.device_id).toBe("dev-1");
  });
});
