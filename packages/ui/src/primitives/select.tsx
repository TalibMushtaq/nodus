import type { SelectHTMLAttributes } from "react";

export function Select({ className = "", ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={`text-xs bg-secondary border border-border px-2.5 py-1.5 text-foreground rounded-lg outline-none transition-colors focus:border-accent ${className}`}
    />
  );
}