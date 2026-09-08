import type { VersionInfo } from "./types";

// Version history list inside the file detail side panel.

interface VersionListProps {
  versions: VersionInfo[];
  onRestore?: (v: VersionInfo) => void;
}

export function VersionList({ versions, onRestore }: VersionListProps) {
  return (
    <div>
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Version history</h3>
      <div className="space-y-0.5">
        {versions.map((v) => (
          <div key={v.version} className="flex items-center gap-2 py-2 border-b border-border last:border-0">
            <span className="font-mono text-xs text-accent w-6">{v.version}</span>
            <div className="flex-1 min-w-0">
              <div className="text-[10px] font-mono text-muted-foreground">{v.timestamp}</div>
              <div className="text-[10px] text-muted-foreground">{v.device} &middot; {v.size}</div>
            </div>
            <button
              type="button"
              onClick={() => onRestore?.(v)}
              className="text-[10px] px-1.5 py-0.5 border border-border rounded-sm text-muted-foreground hover:border-accent hover:text-accent transition-colors"
            >
              Restore
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}