import type { ReactNode } from "react";
import { Icon, type IconName } from "./icons";

// Generic empty state pattern (Devices, Files, etc.). An optional icon sits in a
// dashed plate so an empty section still communicates what belongs there; the
// title uses the display face to keep empty and populated states typographically
// consistent.
interface EmptyStateProps {
  title: string;
  description: string;
  action?: ReactNode;
  icon?: IconName;
}

export function EmptyState({ title, description, action, icon }: EmptyStateProps) {
  return (
    <div className="rise flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border px-6 py-16 text-center">
      {icon && (
        <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-dashed border-border text-muted-foreground">
          <Icon name={icon} size={20} />
        </span>
      )}
      <div className="font-display text-sm font-semibold text-foreground">{title}</div>
      <div className="max-w-xs text-xs leading-relaxed text-muted-foreground">{description}</div>
      {action}
    </div>
  );
}
