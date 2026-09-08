import type { ReactNode } from "react";

// A labelled setting row: label + optional detail on the left, control on the
// right, hairline separators between rows. Used by Settings and drawers.
interface SettingRowProps {
  label: string;
  detail?: string;
  children?: ReactNode;
}

export function SettingRow({ label, detail, children }: SettingRowProps) {
  return (
    <div className="flex items-center justify-between py-3 border-b border-border last:border-0">
      <div>
        <div className="text-sm text-foreground">{label}</div>
        {detail && <div className="text-xs text-muted-foreground mt-0.5">{detail}</div>}
      </div>
      <div className="ml-4">{children}</div>
    </div>
  );
}