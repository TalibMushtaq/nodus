interface ToggleProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  "aria-label"?: string;
}

export function Toggle({ checked, onChange, disabled, "aria-label": ariaLabel }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`w-10 h-5 rounded-full flex items-center transition-colors ${
        checked ? "bg-accent justify-end pr-0.5" : "bg-border justify-start pl-0.5"
      } ${disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}`}
    >
      <div className="w-4 h-4 bg-white rounded-full shadow-sm" />
    </button>
  );
}