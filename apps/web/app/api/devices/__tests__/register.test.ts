import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockRelayFetch } = vi.hoisted(() => ({ mockRelayFetch: vi.fn() }));

vi.mock("../../../../lib/relay", () => ({
  relayFetch: mockRelayFetch,
  relayErrorMessage: ({ json }: { json: { error?: string } | null }) =>
    json?.error ?? "Relay request failed",
}));

import { POST as registerDevice } from "../register/route";

beforeEach(() => {
  vi.clearAllMocks();
});

// Guards the Path C E2E contract: scripts/e2e-path-c.sh enrolls its second
// device through this proxy. Without it the device never appears in
// GET /devices, no FEK envelope is sealed for it, and its download fails with
// MissingEnvelopeError — the regression this route fixes.
describe("device register proxy", () => {
  it("forwards the body to the Relay and returns 201", async () => {
    mockRelayFetch.mockResolvedValue({
      status: 201,
      json: { device_id: "dev-b", account_id: "acct-1", status: "ACTIVE" },
      setCookie: null,
    });

    const request = new Request("http://localhost/api/devices/register", {
      method: "POST",
      body: JSON.stringify({ device_id: "dev-b", public_key: "pub-b" }),
    });
    const response = await registerDevice(request as never);

    expect(mockRelayFetch).toHaveBeenCalledWith(
      "/devices/register",
      expect.objectContaining({ method: "POST" }),
    );
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ device_id: "dev-b" });
  });

  it("surfaces the Relay error body on rejection", async () => {
    mockRelayFetch.mockResolvedValue({
      status: 409,
      json: { error: "device belongs to another account" },
      setCookie: null,
    });

    const response = await registerDevice(
      new Request("http://localhost/api/devices/register", {
        method: "POST",
        body: "{}",
      }) as never,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "device belongs to another account",
    });
  });
});
