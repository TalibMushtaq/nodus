import type { ReactNode } from "react";
import { Icon } from "./icons";

// Shared overlay shell. Modal = centered panel over a blurred scrim;
// Drawer = right-edge sliding panel. Both dismiss on backdrop click.

interface ModalProps {
  children: ReactNode;
  onClose: () => void;
  className?: string;
}

export function Modal({ children, onClose, className = "" }: ModalProps) {
  return (
    <div
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
  return (
    <div
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
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}