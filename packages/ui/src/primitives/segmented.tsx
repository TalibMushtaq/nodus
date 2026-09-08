interface SegmentedControlProps<T extends string> {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
}

export function SegmentedControl<T extends string>({ options, value, onChange, className = "" }: SegmentedControlProps<T>) {
  return (
    <div className={`flex border border-border rounded-sm overflow-hidden ${className}`}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`px-3 py-1.5 text-xs transition-colors ${
            value === o.value ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}