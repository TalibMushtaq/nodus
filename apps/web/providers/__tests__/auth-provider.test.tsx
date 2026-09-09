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

// Mock device
vi.mock("../../lib/device", () => ({
  getOrCreateDeviceIdentity: vi.fn().mockReturnValue({
    device_id: "test-device-id",
    public_key: "test-public-key",
    private_key: "test-private-key",
  }),
}));

import { login, register, logout, fetchSession } from "../../lib/auth-client";

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

    expect(mockLogin).toHaveBeenCalledWith("test@example.com", "password123", {
      device_id: "test-device-id",
      public_key: "test-public-key",
      private_key: "test-private-key",
    });
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

    expect(mockRegister).toHaveBeenCalledWith("test@example.com", "password123", {
      device_id: "test-device-id",
      public_key: "test-public-key",
      private_key: "test-private-key",
    });
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
