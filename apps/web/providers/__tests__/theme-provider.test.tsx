import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider, useTheme } from "../theme-provider";

function Probe() {
  const { theme, setTheme, resolvedDark } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <span data-testid="dark">{String(resolvedDark)}</span>
      <button type="button" onClick={() => setTheme("dark")}>
        set-dark
      </button>
      <button type="button" onClick={() => setTheme("light")}>
        set-light
      </button>
    </div>
  );
}

beforeEach(() => {
  // jsdom lacks matchMedia; default to a light OS so "system" is deterministic.
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.classList.remove("dark");
});

describe("ThemeProvider persistence", () => {
  it("stores the chosen theme and restores it on a fresh mount", async () => {
    const first = render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );

    await act(async () => {
      screen.getByText("set-dark").click();
    });
    expect(localStorage.getItem("nodus.theme")).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    first.unmount();

    // A new session (fresh mount) must hydrate from storage, not default back
    // to "system" — and must not overwrite the saved value with the SSR default
    // before reading it.
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(localStorage.getItem("nodus.theme")).toBe("dark");
    expect(await screen.findByText("dark")).toBeInTheDocument();
    expect(localStorage.getItem("nodus.theme")).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("applies the explicit light choice against a dark OS", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: true, // OS prefers dark
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }));

    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    await act(async () => {
      screen.getByText("set-light").click();
    });

    expect(localStorage.getItem("nodus.theme")).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});
