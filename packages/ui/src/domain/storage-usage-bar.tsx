interface StorageUsageBarProps {
  used: string;
  total: string;
  /** Numeric percentage of used/total to render the bar. */
  percent: number;
}

export function StorageUsageBar({ used, total, percent }: StorageUsageBarProps) {
  return (
    <div className="flex-1 max-w-[140px]">
      <div className="h-1 bg-border rounded-full overflow-hidden">
        <div className="h-full bg-accent rounded-full" style={{ width: `${Math.min(percent, 100)}%` }} />
      </div>
      <span className="text-[10px] font-mono text-muted-foreground mt-0.5 block">{used} / {total}</span>
    </div>
  );
}