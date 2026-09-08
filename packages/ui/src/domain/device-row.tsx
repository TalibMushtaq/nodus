import { StatusBadge } from "../primitives/badge";
import type { ClientDevice } from "./types";

interface DeviceRowProps {
  device: ClientDevice;
  onRevoke: () => void;
}

export function DeviceRow({ device, onRevoke }: DeviceRowProps) {
  return (
    <div className="flex items-center gap-4 px-5 py-3.5 border-b border-border last:border-0 hover:bg-secondary/40 transition-colors">
      <div className="w-9 h-9 border border-border flex items-center justify-center shrink-0 bg-secondary">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
          <rect x="5" y="1.5" width="8" height="15" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
          <path d="M7.5 4h3M9 14h0" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{device.name}</span>
          <StatusBadge status={device.status} variant="inline" />
        </div>
        <div className="text-[10px] font-mono text-muted-foreground mt-0.5">{device.id}</div>
      </div>
      <div className="text-[10px] text-muted-foreground hidden sm:block">{device.lastActive}</div>
      <button type="button" onClick={onRevoke} className="px-3 py-1.5 text-xs border border-destructive/30 text-destructive hover:bg-destructive/10 transition-colors shrink-0">
        Revoke
      </button>
    </div>
  );
}