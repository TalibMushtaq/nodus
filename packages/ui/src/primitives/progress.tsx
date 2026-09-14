interface ProgressProps {
  value: number; // 0–100
  className?: string;
}

// Thin determinate bar. Uses the accent gradient so in-flight work reads as the
// same brand gesture as primary buttons rather than a flat fill.
export function Progress({ value, className = "" }: ProgressProps) {
  return (
    <div className={`h-1 overflow-hidden rounded-full bg-border ${className}`}>
      <div
        className="h-full rounded-full accent-gradient transition-[width] duration-300 ease-out"
        style={{ width: `${Math.min(value, 100)}%` }}
      />
    </div>
  );
}
