import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { AuthProvider, useAuth } from "../auth-provider";
import type { ReactNode } from "react";

// Mock auth-client
vi.mock("../../lib/auth-client", () => ({
  login: vi.fn(),
  register: vi.fn(),
  logout: vi.fn(),
  fetchSession: vi.fn(),
}));

// Mock device (ADR-0008: identity is public-only; signing is a handle)
vi.mock("../../lib/device", () => ({
  getOrCreateDevice: vi.fn().mockResolvedValue({
    identity: { device_id: "test-device-id", public_key: "test-public-key" },
    signer: { deviceId: "test-device-id", publicKey: "test-public-key", sign: vi.fn() },
  }),
  getOrCreateEncryptionIdentity: vi.fn().mockResolvedValue({
    public_key: "test-encryption-public-key",
    private_key: "test-encryption-private-key",
  }),
  getEncryptionPublicKey: vi.fn().mockReturnValue("test-encryption-public-key"),
  clearEncryptionMemory: vi.fn(),
  clearEncryptionIdentity: vi.fn().mockResolvedValue(undefined),
}));

// The account recovery phrase is wiped on logout; mock the SDK-backed client so
// the unit test does not pull in the real envelope/IndexedDB stack.
vi.mock("../../lib/recovery", () => ({
  clearRecoveryPhrase: vi.fn().mockResolvedValue(undefined),
}));

// Pin the auto-detected fingerprint so the auth call assertion is stable.
vi.mock("../../lib/device-info", () => ({
  detectDeviceInfo: () => ({ platform: "linux", browser: "Chrome 126" }),
}));

// The logout key wipe hits real IndexedDB (macrotask-timed under
// fake-indexeddb); mock it so sign-out stays a microtask-flushed unit test.
// The real wipe is covered by lib/__tests__/keys.test.ts.
vi.mock("../../lib/keys", () => ({
  clearFileKeys: vi.fn().mockResolvedValue(undefined),
}));

// Account scoping also clears real IndexedDB stores; mock it so the provider's
// session transitions stay microtask-flushed. The real clearing is covered by
// lib/__tests__/account-scope.test.ts.
vi.mock("../../lib/account-scope", () => ({
  claimAccountScope: vi.fn().mockResolvedValue(undefined),
  releaseAccountScope: vi.fn().mockResolvedValue(undefined),
}));

// Logout dynamically imports preview.ts to revoke decrypted image URLs; mock it
// so the dynamic import resolves without loading the real download stack.
vi.mock("../../lib/preview", () => ({
  revokeAllPreviews: vi.fn(),
}));

import { login, register, logout, fetchSession } from "../../lib/auth-client";
import { claimAccountScope, releaseAccountScope } from "../../lib/account-scope";
import { clearFileKeys } from "../../lib/keys";
import { clearRecoveryPhrase } from "../../lib/recovery";
import { clearEncryptionMemory } from "../../lib/device";
import { revokeAllPreviews } from "../../lib/preview";

const mockLogin = vi.mocked(login);
const mockRegister = vi.mocked(register);
const mockLogout = vi.mocked(logout);
const mockFetchSession = vi.mocked(fetchSession);

const mockSession = {
  account_id: "acct-123",
  device_id: "dev-123",
  session_expires_at: new Date(Date.now() + 3600000).toISOString(),
};

function TestComponent() {
  const { status, session, login: authLogin, register: authRegister, logout: authLogout } = useAuth();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="session">{session ? JSON.stringify(session) : "null"}</span>
      <button onClick={() => authLogin("test@example.com", "password123")}>Login</button>
      <button onClick={() => authRegister("test@example.com", "password123")}>Register</button>
      <button onClick={() => authLogout()}>Logout</button>
    </div>
  );
}

function TestWrapper({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchSession.mockResolvedValue(null);
});

describe("AuthProvider", () => {
  it("starts in loading status", async () => {
    mockFetchSession.mockImplementation(() => new Promise(() => {}));

    await act(async () => {
      render(<TestComponent />, { wrapper: TestWrapper });
    });

    expect(screen.getByTestId("status")).toHaveTextContent("loading");
  });

  it("resolves to unauthenticated when no session", async () => {
    mockFetchSession.mockResolvedValue(null);

    await act(async () => {
      render(<TestComponent />, { wrapper: TestWrapper });
    });

    expect(screen.getByTestId("status")).toHaveTextContent("unauthenticated");
    expect(screen.getByTestId("session")).toHaveTextContent("null");
  });

  it("resolves to authenticated when session exists", async () => {
    mockFetchSession.mockResolvedValue(mockSession);

    await act(async () => {
      render(<TestComponent />, { wrapper: TestWrapper });
    });

    expect(screen.getByTestId("status")).toHaveTextContent("authenticated");
    expect(screen.getByTestId("session")).toHaveTextContent("acct-123");
    // The local stores are reconciled to the account before it is surfaced.
    expect(claimAccountScope).toHaveBeenCalledWith("acct-123");
  });

  it("login updates status to authenticated", async () => {
    mockFetchSession.mockResolvedValue(null);
    mockLogin.mockResolvedValue({ ok: true, session: mockSession });

    await act(async () => {
      render(<TestComponent />, { wrapper: TestWrapper });
    });

    await act(async () => {
      screen.getByText("Login").click();
    });

    expect(mockLogin).toHaveBeenCalledWith(
      "test@example.com",
      "password123",
      {
        device_id: "test-device-id",
        public_key: "test-public-key",
        info: { platform: "linux", browser: "Chrome 126" },
      },
      "test-encryption-public-key",
    );
    expect(screen.getByTestId("status")).toHaveTextContent("authenticated");
  });

  it("register updates status to authenticated", async () => {
    mockFetchSession.mockResolvedValue(null);
    mockRegister.mockResolvedValue({ ok: true, session: mockSession });

    await act(async () => {
      render(<TestComponent />, { wrapper: TestWrapper });
    });

    await act(async () => {
      screen.getByText("Register").click();
    });

    expect(mockRegister).toHaveBeenCalledWith(
      "test@example.com",
      "password123",
      {
        device_id: "test-device-id",
        public_key: "test-public-key",
        info: { platform: "linux", browser: "Chrome 126" },
      },
      undefined,
      "test-encryption-public-key",
    );
    expect(screen.getByTestId("status")).toHaveTextContent("authenticated");
  });

  it("logout clears session and status", async () => {
    mockFetchSession.mockResolvedValue(mockSession);
    mockLogout.mockResolvedValue(undefined);

    await act(async () => {
      render(<TestComponent />, { wrapper: TestWrapper });
    });

    expect(screen.getByTestId("status")).toHaveTextContent("authenticated");

    await act(async () => {
      screen.getByText("Logout").click();
    });

    expect(mockLogout).toHaveBeenCalled();
    expect(screen.getByTestId("status")).toHaveTextContent("unauthenticated");
    expect(screen.getByTestId("session")).toHaveTextContent("null");
    // Sign-out must not leave account-scoped decryption material for a shared
    // browser, but must keep the device X25519 identity so existing envelopes
    // still open on the next sign-in.
    expect(clearFileKeys).toHaveBeenCalled();
    expect(clearEncryptionMemory).toHaveBeenCalled();
    expect(clearRecoveryPhrase).toHaveBeenCalledWith("acct-123");
    expect(revokeAllPreviews).toHaveBeenCalled();
    expect(releaseAccountScope).toHaveBeenCalled();
  });

  it("login returns error on failure", async () => {
    mockFetchSession.mockResolvedValue(null);
    mockLogin.mockResolvedValue({ ok: false, error: "Invalid credentials" });

    await act(async () => {
      render(<TestComponent />, { wrapper: TestWrapper });
    });

    await act(async () => {
      await screen.getByText("Login").click();
    });

    // Status should remain unauthenticated on failure
    expect(screen.getByTestId("status")).toHaveTextContent("unauthenticated");
  });
});

describe("useAuth", () => {
  it("throws when used outside AuthProvider", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    function BadComponent() {
      useAuth();
      return null;
    }

    expect(() => render(<BadComponent />)).toThrow("useAuth must be used within an AuthProvider");

    consoleSpy.mockRestore();
  });
});
