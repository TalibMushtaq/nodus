import { createContext, useContext, useEffect, useId, useRef, type ReactNode } from "react";
import { Icon } from "./icons";
import { Button } from "./button";

// Shared overlay shell. Modal = centered panel over a blurred scrim;
// Drawer = right-edge sliding panel. Both dismiss on backdrop click and Escape.
//
// Accessibility: each overlay gets a unique generated title id (via context, so
// Modal/Header stay decoupled), traps Tab focus while open, moves focus into the
// panel on open, restores focus to the trigger on close, and locks body scroll.
// Previously the title id was a single shared constant (two overlays would
// collide) and focus/scroll were unmanaged.

const OverlayTitleContext = createContext<string | null>(null);

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Shared dialog behavior: Escape-to-close, focus trap, initial focus, focus
 * restore, and scroll lock. `onClose` is read through a ref so an inline-arrow
 * handler does not re-run the effect (and re-yank focus) on every render.
 */
function useDialogA11y(onClose: () => void) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;

    const focusables = (): HTMLElement[] =>
      panel ? Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) : [];

    // Move focus inside the dialog so keyboard users are not stranded behind it.
    (focusables()[0] ?? panel)?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !panel) return;
      const nodes = focusables();
      if (nodes.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (!first || !last) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    // Prevent the page behind the scrim from scrolling while the dialog is open.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus?.();
    };
  }, []);

  return panelRef;
}

interface ModalProps {
  children: ReactNode;
  onClose: () => void;
  className?: string;
}

export function Modal({ children, onClose, className = "" }: ModalProps) {
  const titleId = useId();
  const panelRef = useDialogA11y(onClose);
  return (
    <div
      role="presentation"
      className="fixed inset-0 bg-foreground/20 backdrop-blur-sm flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={panelRef}
        tabIndex={-1}
        className={`bg-card border border-border mx-4 outline-none ${className}`}
        onClick={(e) => e.stopPropagation()}
      >
        <OverlayTitleContext.Provider value={titleId}>{children}</OverlayTitleContext.Provider>
      </div>
    </div>
  );
}

interface DrawerProps {
  children: ReactNode;
  onClose: () => void;
  className?: string;
}

export function Drawer({ children, onClose, className = "" }: DrawerProps) {
  const titleId = useId();
  const panelRef = useDialogA11y(onClose);
  return (
    <div
      role="presentation"
      className="fixed inset-0 bg-foreground/20 backdrop-blur-sm flex items-center justify-end z-50"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={panelRef}
        tabIndex={-1}
        className={`bg-card border-l border-border h-full flex flex-col outline-none ${className}`}
        onClick={(e) => e.stopPropagation()}
      >
        <OverlayTitleContext.Provider value={titleId}>{children}</OverlayTitleContext.Provider>
      </div>
    </div>
  );
}

interface ModalHeaderProps {
  title: string;
  onClose: () => void;
}

export function ModalHeader({ title, onClose }: ModalHeaderProps) {
  const titleId = useContext(OverlayTitleContext);
  return (
    <div className="flex items-center justify-between px-5 py-4 border-b border-border">
      <h2 id={titleId ?? undefined} className="text-sm font-semibold text-foreground">
        {title}
      </h2>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="text-muted-foreground hover:text-foreground ml-3"
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

interface ConfirmDialogProps {
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Render the confirm button in the destructive style (irreversible action). */
  destructive?: boolean;
  /** Disable both actions and show progress while the action is in flight. */
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * Confirmation gate for irreversible actions (device revocation, data reset).
 * Kept separate from `Modal` so callers do not each re-implement the
 * "destructive action needs a second click" affordance that the revoke flow
 * previously lacked.
 */
export function ConfirmDialog({
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  busy = false,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  return (
    <Modal className="w-[420px] max-w-full" onClose={busy ? () => undefined : onClose}>
      <ModalHeader title={title} onClose={busy ? () => undefined : onClose} />
      <div className="p-5 space-y-4">
        <div className="text-xs text-muted-foreground">{description}</div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? "destructive" : "primary"}
            size="sm"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Working…" : confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
