import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const { mockPush } = vi.hoisted(() => ({ mockPush: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }));

vi.mock("../../../../lib/pairing", () => ({
  listNodes: vi.fn(),
  listDevices: vi.fn(),
  revokeDevice: vi.fn(),
}));

import { listNodes, listDevices, type RelayNode } from "../../../../lib/pairing";
import { DevicesClient } from "../devices-client";

const mockListNodes = vi.mocked(listNodes);
const mockListDevices = vi.mocked(listDevices);

function node(partial: Partial<RelayNode> = {}): RelayNode {
  return {
    node_id: "node-1234567890abcdef",
    account_id: "acct-1",
    public_key: "ab".repeat(32),
    capabilities: ["storage", "sync"],
    status: "ACTIVE",
    is_primary: true,
    last_seen_at: null,
    created_at: "2026-09-11T00:00:00.000Z",
    ...partial,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListNodes.mockResolvedValue([]);
  mockListDevices.mockResolvedValue([]);
});

describe("DevicesClient", () => {
  it("renders the node catalog from the proxy", async () => {
    mockListNodes.mockResolvedValue([node()]);
    render(<DevicesClient publicRelayUrl="https://nodus.example.com" />);

    expect(await screen.findByText("node-123…")).toBeInTheDocument();
    expect(screen.getByText("PRIMARY")).toBeInTheDocument();
  });

  it("warns when PUBLIC_RELAY_URL is unset", async () => {
    render(<DevicesClient publicRelayUrl={null} />);
    expect(await screen.findByTestId("public-relay-url-missing")).toBeInTheDocument();
  });

  it("does not warn when PUBLIC_RELAY_URL is configured", async () => {
    render(<DevicesClient publicRelayUrl="https://nodus.example.com" />);
    // Let the mount effect settle before asserting absence.
    expect(await screen.findByText("No storage nodes yet")).toBeInTheDocument();
    expect(screen.queryByTestId("public-relay-url-missing")).toBeNull();
  });
});
