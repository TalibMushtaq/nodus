import type { InputHTMLAttributes } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
}

export function Input({ label, hint, className = "", ...props }: InputProps) {
  return (
    <div className="space-y-1.5">
      {label && <label className="text-xs font-medium text-foreground">{label}</label>}
      <input
        {...props}
        className={`w-full px-3.5 py-2.5 text-sm bg-background border border-border rounded-xl text-foreground placeholder-muted-foreground outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20 ${className}`}
      />
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}