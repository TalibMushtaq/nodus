import type { SelectHTMLAttributes } from "react";

export function Select({ className = "", ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={`text-xs bg-secondary border border-border px-2 py-1.5 text-foreground rounded-sm outline-none focus:border-accent ${className}`}
    />
  );
}