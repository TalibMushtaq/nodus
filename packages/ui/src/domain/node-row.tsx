import { StatusBadge } from "../primitives/badge";
import { Progress } from "../primitives/progress";
import type { StorageNode } from "./types";

interface NodeRowProps {
  node: StorageNode;
  onManage: () => void;
}

export function NodeRow({ node, onManage }: NodeRowProps) {
  const totalNum = node.total === "2 TB" ? 2000 : parseFloat(node.total);
  const percent = (parseFloat(node.used) / totalNum) * 100;

  return (
    <div className="flex items-center gap-4 px-5 py-3.5 border-b border-border last:border-0 hover:bg-secondary/40 transition-colors">
      <div className="w-9 h-9 border border-border flex items-center justify-center shrink-0 bg-secondary">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
          <rect x="2" y="2" width="14" height="14" rx="1" stroke="currentColor" strokeWidth="1.3" />
          <path d="M5 6h8M5 9h8M5 12h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-sm font-medium text-foreground">{node.name}</span>
          <StatusBadge status={node.status} variant="inline" />
        </div>
        <Progress value={percent} className="max-w-[140px] mt-1" />
        <span className="text-[10px] font-mono text-muted-foreground">{node.used} / {node.total}</span>
      </div>
      <div className="text-[10px] font-mono text-muted-foreground hidden md:block">{node.addr}</div>
      <div className="text-[10px] text-muted-foreground hidden sm:block">{node.lastSeen}</div>
      <button type="button" onClick={onManage} className="px-3 py-1.5 text-xs border border-border hover:border-accent hover:text-accent transition-colors text-foreground shrink-0">
        Manage
      </button>
    </div>
  );
}