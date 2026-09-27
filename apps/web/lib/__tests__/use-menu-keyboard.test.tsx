import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";

import { useMenuKeyboard } from "../use-menu-keyboard";

function TestMenu() {
  const [open, setOpen] = useState(true);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useMenuKeyboard({ open, onClose: () => setOpen(false), triggerRef, menuRef });
  return (
    <div>
      <button ref={triggerRef}>trigger</button>
      {open && (
        <div ref={menuRef} role="menu">
          <button role="menuitem">one</button>
          <button role="menuitem">two</button>
          <button role="menuitem" disabled>
            three
          </button>
        </div>
      )}
    </div>
  );
}

describe("useMenuKeyboard", () => {
  it("focuses the first item on open and moves with arrows, skipping disabled", () => {
    render(<TestMenu />);
    const [one, two] = screen.getAllByRole("menuitem");
    expect(document.activeElement).toBe(one);

    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(document.activeElement).toBe(two);

    // Wraps around to the first (the disabled third is skipped).
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(document.activeElement).toBe(one);

    fireEvent.keyDown(document, { key: "End" });
    expect(document.activeElement).toBe(two);

    fireEvent.keyDown(document, { key: "Home" });
    expect(document.activeElement).toBe(one);
  });

  it("closes on Escape and restores focus to the trigger", () => {
    render(<TestMenu />);
    const trigger = screen.getByText("trigger");

    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });

    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
