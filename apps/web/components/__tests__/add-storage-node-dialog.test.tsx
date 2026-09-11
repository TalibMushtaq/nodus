import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Keep the real `findNewNode` (so polling is exercised end-to-end) and mock only
// the network-facing helpers.
vi.mock("../../lib/pairing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/pairing")>();
  return { ...actual, createPairingCode: vi.fn(), listNodes: vi.fn() };
});

import { createPairingCode, listNodes, type RelayNode } from "../../lib/pairing";
import { AddStorageNodeDialog } from "../add-storage-node-dialog";

const mockCreate = vi.mocked(createPairingCode);
const mockListNodes = vi.mocked(listNodes);

const NOW = new Date("2026-09-11T12:00:00.000Z");
const EXPIRES = new Date(NOW.getTime() + 5000).toISOString();

function node(partial: Partial<RelayNode> = {}): RelayNode {
  return {
    node_id: "node-1",
    account_id: "acct-1",
    public_key: "ab".repeat(32),
    capabilities: ["storage", "sync"],
    status: "ACTIVE",
    is_primary: true,
    last_seen_at: null,
    created_at: NOW.toISOString(),
    ...partial,
  };
}

async function renderDialog(
  overrides: Partial<Parameters<typeof AddStorageNodeDialog>[0]> = {},
) {
  const onClose = vi.fn();
  const onPaired = vi.fn();
  render(
    <AddStorageNodeDialog
      relayUrl="https://nodus.example.com"
      existingNodeIds={[]}
      onClose={onClose}
      onPaired={onPaired}
      {...overrides}
    />,
  );
  // Flush the createPairingCode() promise without advancing the clock.
  await act(async () => {});
  return { onClose, onPaired };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  mockCreate.mockResolvedValue({ code: "NODUS-ABCD-2345", expires_at: EXPIRES });
  mockListNodes.mockResolvedValue([]);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("AddStorageNodeDialog", () => {
  it("renders the relay URL, code, CLI command, and countdown", async () => {
    await renderDialog();

    expect(screen.getByTestId("pairing-relay-url")).toHaveTextContent(
      "https://nodus.example.com",
    );
    expect((screen.getByTestId("pairing-code") as HTMLInputElement).value).toBe(
      "NODUS-ABCD-2345",
    );
    expect(screen.getByTestId("pairing-command")).toHaveTextContent(
      "nodus node pair --relay https://nodus.example.com --code NODUS-ABCD-2345",
    );
    expect(screen.getByTestId("pairing-countdown")).toHaveTextContent("Expires in 00:05");
  });

  it("copies the CLI command and confirms", async () => {
    await renderDialog();
    fireEvent.click(screen.getByTestId("pairing-copy"));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "nodus node pair --relay https://nodus.example.com --code NODUS-ABCD-2345",
    );
  });

  it("counts down and flips to expired with a regenerate action", async () => {
    await renderDialog();
    expect(screen.getByTestId("pairing-countdown")).toHaveTextContent("00:05");

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    expect(screen.getByTestId("pairing-countdown")).toHaveTextContent("Pairing code expired");
    expect(screen.getByTestId("pairing-regenerate")).toBeInTheDocument();
  });

  it("detects the paired node via polling and notifies the caller", async () => {
    // Long expiry so the countdown does not stop the poll mid-test.
    mockCreate.mockResolvedValue({
      code: "NODUS-ABCD-2345",
      expires_at: new Date(NOW.getTime() + 600_000).toISOString(),
    });
    const { onPaired } = await renderDialog({ existingNodeIds: ["node-1"] });
    mockListNodes.mockResolvedValue([node({ node_id: "node-1" })]);
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    // Still the only node: pending, no callback.
    expect(onPaired).not.toHaveBeenCalled();

    mockListNodes.mockResolvedValue([
      node({ node_id: "node-1" }),
      node({ node_id: "node-2" }),
    ]);
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    expect(screen.getByTestId("pairing-status")).toHaveTextContent("Node paired — node-2");
    expect(onPaired).toHaveBeenCalledWith(expect.objectContaining({ node_id: "node-2" }));
  });

  it("shows an error when the poll fails", async () => {
    await renderDialog();
    mockListNodes.mockRejectedValue(new Error("relay unavailable"));
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    expect(screen.getByTestId("pairing-status")).toHaveTextContent("relay unavailable");
    expect(screen.getByTestId("pairing-regenerate")).toBeInTheDocument();
  });

  it("shows an error when code creation fails", async () => {
    mockCreate.mockRejectedValue(new Error("unauthorized"));
    await renderDialog();

    expect(screen.getByTestId("pairing-status")).toHaveTextContent("unauthorized");
    expect(screen.queryByTestId("pairing-code")).toBeNull();
  });

  it("closes via the caller's handler", async () => {
    const { onClose } = await renderDialog();
    fireEvent.click(screen.getByTestId("pairing-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
