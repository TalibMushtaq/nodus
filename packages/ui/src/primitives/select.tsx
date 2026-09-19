import type { SelectHTMLAttributes } from "react";

type SelectSize = "sm" | "md" | "lg";

// Size scales the control's text and padding together so a toolbar can raise
// all of them consistently. `sm` stays the default to preserve existing callers.
const sizes: Record<SelectSize, string> = {
  sm: "text-xs px-2.5 py-1.5",
  md: "text-sm px-3 py-2",
  lg: "text-base px-3.5 py-2.5",
};

export function Select({
  className = "",
  size = "sm",
  ...props
}: // `size` is also a native select attribute (row count); omit it so our
// visual-size variant can reuse the name.
Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> & { size?: SelectSize }) {
  return (
    <select
      {...props}
      className={`${sizes[size]} bg-secondary border border-border text-foreground rounded-lg outline-none transition-colors focus:border-accent ${className}`}
    />
  );
}
