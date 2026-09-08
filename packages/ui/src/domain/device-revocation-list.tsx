import type { RevocationEntry } from "./types";
import { StatusBadge } from "../primitives/badge";

// Device revocation list: Security page. Shows historical + active paired
// devices with an explicit per-device revoke action.

interface DeviceRevocationListProps {
  devices: RevocationEntry[];
  onRevoke: (id: string) => void;
}

export function DeviceRevocationList({ devices, onRevoke }: DeviceRevocationListProps) {
  return (
    <div className="border border-border rounded-xl overflow-hidden bg-card">
      <div className="px-5 py-3 border-b border-border">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Paired Devices</h3>
      </div>
      <table className="w-full">
        <thead>
          <tr className="border-b border-border text-[10px] text-muted-foreground uppercase tracking-wider">
            <th className="text-left px-5 py-2 font-medium">Name</th>
            <th className="text-left px-3 py-2 font-medium">Device ID</th>
            <th className="text-left px-3 py-2 font-medium">Last active</th>
            <th className="text-center px-3 py-2 font-medium">Status</th>
            <th className="text-right px-5 py-2 font-medium">Action</th>
          </tr>
        </thead>
        <tbody>
          {devices.map((d) => (
            <tr key={d.id} className="hover:bg-secondary/40 transition-colors">
              <td className="px-5 py-2.5 text-xs text-foreground font-medium">{d.name}</td>
              <td className="px-3 py-2.5 text-[10px] font-mono text-muted-foreground">{d.id}</td>
              <td className="px-3 py-2.5 text-[10px] font-mono text-muted-foreground">{d.lastActive}</td>
              <td className="px-3 py-2.5 text-center">
                <StatusBadge status={d.status === "active" ? "synced" : "offline"} variant="inline" />
              </td>
              <td className="px-5 py-2.5 text-right">
                {d.status === "active" ? (
                  <button type="button" onClick={() => onRevoke(d.id)} className="px-2 py-1 text-[10px] border border-destructive/30 text-destructive hover:bg-destructive/10 transition-colors rounded-sm">
                    Revoke
                  </button>
                ) : (
                  <span className="text-[10px] text-muted-foreground">Revoked</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}