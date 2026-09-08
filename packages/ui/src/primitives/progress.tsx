interface ProgressProps {
  value: number; // 0–100
  className?: string;
}

export function Progress({ value, className = "" }: ProgressProps) {
  return (
    <div className={`h-1 bg-border rounded-full overflow-hidden ${className}`}>
      <div className="h-full bg-accent rounded-full" style={{ width: `${Math.min(value, 100)}%` }} />
    </div>
  );
}