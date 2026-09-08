import { StatusBadge } from "../primitives/badge";
import { Icon } from "../primitives/icons";
import { VersionList } from "./version-list";
import type { FileRow, VersionInfo } from "./types";

// Right-side detail panel for a selected file (Files page). Shows preview,
// metadata, version history, and action buttons.

interface FileDetailPanelProps {
  file: FileRow;
  versions: VersionInfo[];
  onClose: () => void;
  onRestore?: (v: VersionInfo) => void;
}

export function FileDetailPanel({ file, versions, onClose, onRestore }: FileDetailPanelProps) {
  return (
    <div className="w-72 border-l border-border bg-card flex flex-col shrink-0">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <span className="text-sm font-medium text-foreground truncate">{file.name}</span>
        <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors ml-2 shrink-0">
          <Icon name="close" size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Preview placeholder */}
        <div className="bg-secondary border border-border h-32 flex items-center justify-center">
          <span className="text-2xl font-mono text-muted-foreground">{file.ext?.toUpperCase() ?? "\u{1F4C1}"}</span>
        </div>

        {/* Meta rows */}
        <div className="space-y-2">
          {([
            ["Status", <StatusBadge status={file.status} />],
            ["Size", <span className="font-mono text-xs text-foreground">{file.size}</span>],
            ["Modified", <span className="font-mono text-xs text-foreground">{file.modified}</span>],
            ["Location", <span className="text-xs text-foreground">{file.location}</span>],
          ] as const).map(([label, val], i) => (
            <div key={i} className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">{label}</span>
              {val}
            </div>
          ))}
        </div>

        {/* Version history */}
        <VersionList versions={versions} onRestore={onRestore} />

        {/* Actions */}
        <div className="space-y-1.5">
          {["Download", "Share", "Move", "Rename", "Force resync"].map((a) => (
            <button key={a} type="button" className="w-full text-left text-xs px-3 py-2 border border-border hover:bg-secondary hover:border-accent/30 transition-colors text-foreground">{a}</button>
          ))}
          <button type="button" className="w-full text-left text-xs px-3 py-2 border border-destructive/30 hover:bg-destructive/10 transition-colors text-destructive">Delete</button>
        </div>
      </div>
    </div>
  );
}