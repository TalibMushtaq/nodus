import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConfirmDialog } from "@repo/ui/primitives/overlay";

// Confirms the shared dialog gives callers a real accessible gate: labelled
// dialog semantics, wired actions, and a busy state that blocks dismissal.
describe("ConfirmDialog", () => {
  it("labels the dialog with its title and wires confirm/cancel", () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <ConfirmDialog
        title="Revoke device"
        description="This cannot be undone."
        destructive
        confirmLabel="Revoke"
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const labelId = dialog.getAttribute("aria-labelledby");
    expect(labelId).toBeTruthy();
    expect(document.getElementById(labelId as string)).toHaveTextContent("Revoke device");

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("disables actions and blocks Escape while busy", () => {
    const onClose = vi.fn();
    render(
      <ConfirmDialog title="Reset" description="Busy" busy onConfirm={vi.fn()} onClose={onClose} />,
    );

    expect(screen.getByRole("button", { name: "Working…" })).toBeDisabled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
