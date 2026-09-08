import type { ReactNode } from "react";

// Generic empty state pattern (Devices, Files, etc.).
interface EmptyStateProps {
  title: string;
  description: string;
  action?: ReactNode;
}

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center space-y-4">
      <div className="text-sm text-foreground font-medium">{title}</div>
      <div className="text-xs text-muted-foreground max-w-xs">{description}</div>
      {action}
    </div>
  );
}