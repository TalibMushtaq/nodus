"use client";

import { useEffect, type RefObject } from "react";

/**
 * Keyboard behavior for a menu-button, following the WAI-ARIA APG menu pattern.
 *
 * When `open`: focus moves to the first menu item; ArrowUp/ArrowDown/Home/End
 * move focus among `[role="menuitem"]` children; Escape closes the menu and
 * returns focus to the trigger; Tab closes it so focus can leave normally. The
 * caller keeps its own outside-click handler.
 */
export function useMenuKeyboard({
  open,
  onClose,
  triggerRef,
  menuRef,
}: {
  open: boolean;
  onClose: () => void;
  triggerRef: RefObject<HTMLElement | null>;
  menuRef: RefObject<HTMLElement | null>;
}): void {
  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    if (!menu) return;
    const items = () =>
      Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])'));

    // Move focus into the menu so the next keypress acts on an item.
    items()[0]?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        triggerRef.current?.focus();
        return;
      }
      if (event.key === "Tab") {
        // Let focus move on; just collapse the menu.
        onClose();
        return;
      }
      const list = items();
      if (list.length === 0) return;
      const current = list.indexOf(document.activeElement as HTMLElement);
      if (event.key === "ArrowDown") {
        event.preventDefault();
        list[(current + 1) % list.length]?.focus();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        list[(current - 1 + list.length) % list.length]?.focus();
      } else if (event.key === "Home") {
        event.preventDefault();
        list[0]?.focus();
      } else if (event.key === "End") {
        event.preventDefault();
        list[list.length - 1]?.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose, triggerRef, menuRef]);
}
