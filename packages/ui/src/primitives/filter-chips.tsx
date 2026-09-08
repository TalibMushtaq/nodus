import type { ReactNode } from "react";

// Colored filter pills (Activity page) + a transfer status chip.
// Colors follow the prototype's per-type palette.

export interface FilterOption {
  label: string;
  color: string;
}

interface FilterChipsProps {
  options: readonly FilterOption[];
  value: string;
  onChange: (label: string) => void;
  className?: string;
}

export function FilterChips({ options, value, onChange, className = "" }: FilterChipsProps) {
  return (
    <div className={`flex items-center gap-2 flex-wrap ${className}`}>
      {options.map((o) => {
        const active = value === o.label;
        return (
          <button
            key={o.label}
            type="button"
            onClick={() => onChange(o.label)}
            className="px-3 py-1.5 text-xs rounded-full border transition-all font-medium"
            style={
              active
                ? { background: o.color + "22", borderColor: o.color + "60", color: o.color }
                : { borderColor: "var(--color-border)", color: "var(--color-muted-foreground)" }
            }
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// Upload/download status indicator (Activity table rows).
type TransferStatus = "complete" | "failed" | "in-progress";

const statusStyles: Record<TransferStatus, { color: string; children: ReactNode }> = {
  complete: { color: "var(--status-synced)", children: <span>Complete</span> },
  failed: { color: "var(--status-conflict)", children: <span>Failed</span> },
  "in-progress": {
    color: "var(--status-pending)",
    children: (
      <>
        <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse inline-block" />
        In progress
      </>
    ),
  },
};

export function TransferStatus({ status }: { status: TransferStatus }) {
  const s = statusStyles[status];
  return (
    <span className="text-[10px] font-mono inline-flex items-center gap-1" style={{ color: s.color }}>
      {s.children}
    </span>
  );
}