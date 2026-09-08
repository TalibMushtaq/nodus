interface ToggleProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}

export function Toggle({ checked, onChange, disabled }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
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