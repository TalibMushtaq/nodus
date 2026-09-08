import type { ActivityEvent } from "./types";
import { PathIndicator } from "../primitives/path-indicator";
import { TransferStatus } from "../primitives/filter-chips";

interface ActivityTableProps {
  events: ActivityEvent[];
  activeFilter: string;
}

// Map the user's filter-chip choice to the event type it hides. "All" is the
// only implicit option; unknown labels simply show every event.
const filterToType: Record<string, string> = {
  Uploads: "upload",
  Downloads: "download",
  Conflicts: "conflict",
  Errors: "error",
};

export function ActivityTable({ events, activeFilter }: ActivityTableProps) {
  const type = filterToType[activeFilter];
  const visible = type ? events.filter((ev) => ev.type === type) : events;
  return (
    <div className="border border-border rounded-xl overflow-hidden bg-card">
      <table className="w-full">
        <thead>
          <tr className="border-b border-border text-[10px] text-muted-foreground uppercase tracking-wider">
            <th className="text-left px-5 py-2 font-medium">Event</th>
            <th className="text-left px-3 py-2 font-medium hidden md:table-cell">Type</th>
            <th className="text-left px-3 py-2 font-medium">File</th>
            <th className="text-left px-3 py-2 font-medium hidden lg:table-cell">Device</th>
            <th className="text-center px-3 py-2 font-medium">Path</th>
            <th className="text-right px-3 py-2 font-medium hidden sm:table-cell">Time</th>
            <th className="text-center px-5 py-2 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((ev) => (
            <tr key={ev.id} className="hover:bg-secondary/40 transition-colors">
              <td className="px-5 py-2.5 text-xs text-foreground">{ev.event}</td>
              <td className="px-3 py-2.5 text-xs text-muted-foreground hidden md:table-cell capitalize">{ev.type}</td>
              <td className="px-3 py-2.5 text-xs text-foreground font-mono">{ev.file}</td>
              <td className="px-3 py-2.5 text-xs text-muted-foreground hidden lg:table-cell">{ev.device}</td>
              <td className="px-3 py-2.5 text-center"><PathIndicator path={ev.path} /></td>
              <td className="px-3 py-2.5 text-[10px] font-mono text-muted-foreground text-right hidden sm:table-cell">{ev.time}</td>
              <td className="px-5 py-2.5 text-center"><TransferStatus status={ev.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}