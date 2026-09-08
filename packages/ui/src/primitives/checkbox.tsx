import type { InputHTMLAttributes } from "react";

export function Checkbox({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input type="checkbox" {...props} className={`accent-accent size-3.5 ${className}`} />
  );
}