import { useEffect, type ReactNode } from "react";
import { Icon } from "./icons";

// Shared overlay shell. Modal = centered panel over a blurred scrim;
// Drawer = right-edge sliding panel. Both dismiss on backdrop click and Escape.
// They expose proper dialog semantics (role + aria-modal) and their header
// carries the id that labels the dialog, so screen readers announce the title.

// Single visible overlay at a time in this app, so one shared id per overlay
// kind is safe and keeps ModalHeader/Modal in sync without prop drilling.
export const MODAL_TITLE_ID = "nodus-modal-title";

function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
}

interface ModalProps {
  children: ReactNode;
  onClose: () => void;
  className?: string;
}

export function Modal({ children, onClose, className = "" }: ModalProps) {
  useEscape(onClose);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={MODAL_TITLE_ID}
      className="fixed inset-0 bg-foreground/20 backdrop-blur-sm flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div className={`bg-card border border-border mx-4 ${className}`} onClick={(e) => e.stopPropagation()}>
        {children}
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
  useEscape(onClose);
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 bg-foreground/20 backdrop-blur-sm flex items-center justify-end z-50"
      onClick={onClose}
    >
      <div className={`bg-card border-l border-border h-full flex flex-col ${className}`} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

interface ModalHeaderProps {
  title: string;
  onClose: () => void;
}

export function ModalHeader({ title, onClose }: ModalHeaderProps) {
  return (
    <div className="flex items-center justify-between px-5 py-4 border-b border-border">
      <h2 id={MODAL_TITLE_ID} className="text-sm font-semibold text-foreground">
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