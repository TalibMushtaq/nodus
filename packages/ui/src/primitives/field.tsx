import type { ReactNode } from "react";

interface FieldProps {
  label: string;
  children: ReactNode;
  hint?: string;
  error?: string;
}

export function Field({ label, children, hint, error }: FieldProps) {
  return (
    <div className="space-y-1.5">
      {label && <label className="text-xs font-medium text-foreground">{label}</label>}
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  );
}