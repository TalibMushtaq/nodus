import { useId, type InputHTMLAttributes } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
}

export function Input({ label, hint, className = "", id, ...props }: InputProps) {
  // Associate the label with the control via a generated id; a bare <label>
  // next to the input (the previous markup) is not announced by screen readers.
  const generatedId = useId();
  const inputId = id ?? generatedId;
  return (
    <div className="space-y-1.5">
      {label && (
        <label htmlFor={inputId} className="text-xs font-medium text-foreground">
          {label}
        </label>
      )}
      <input
        id={inputId}
        {...props}
        className={`w-full px-3.5 py-2.5 text-sm bg-background border border-border rounded-xl text-foreground placeholder-muted-foreground outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20 ${className}`}
      />
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}
