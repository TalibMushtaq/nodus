import { StatusBadge } from "../primitives/badge";
import type { FileRow as FileRowType } from "./types";

// Render the small file-type extension label (e.g., PDF, TOML) or a folder icon.

function FileIcon({ type, ext }: { type: string; ext?: string }) {
  if (type === "folder") {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M1.5 4.5h4l1.5-2h7.5v9h-13V4.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" className="text-muted-foreground" />
      </svg>
    );
  }
  return (
    <span className="text-[9px] font-mono font-medium text-muted-foreground uppercase tracking-wider w-6 text-center">{ext}</span>
  );
}

interface FileRowProps {
  file: FileRowType;
  selected?: boolean;
  onToggle?: (id: string) => void;
  onResolve?: (id: string) => void;
  onSelect?: (file: FileRowType) => void;
}

export function FileRow({ file, selected, onToggle, onResolve, onSelect }: FileRowProps) {
  return (
    <tr
      className="group hover:bg-secondary/50 cursor-pointer transition-colors"
      onClick={() => onSelect?.(file)}
    >
      <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggle?.(file.id)}
          aria-label={`Select ${file.name}`}
          className="accent-accent size-3.5"
        />
      </td>
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-2.5">
          <div
            className="w-1 h-7 rounded-full shrink-0"
            style={{ backgroundColor: `var(--status-${file.status === "local-only" ? "local" : file.status})` }}
          />
          <FileIcon type={file.type} ext={file.ext} />
          <span className="text-foreground text-sm">{file.name}</span>
          {file.status === "conflict" && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onResolve?.(file.id); }}
              className="px-1.5 py-0.5 text-[10px] font-medium bg-destructive/10 text-destructive border border-destructive/20 rounded-sm hover:bg-destructive/20 transition-colors"
            >
              Resolve
            </button>
          )}
        </div>
      </td>
      <td className="px-3 py-2.5 text-xs font-mono text-muted-foreground hidden md:table-cell">{file.size}</td>
      <td className="px-3 py-2.5 text-xs font-mono text-muted-foreground hidden lg:table-cell">{file.modified}</td>
      <td className="px-3 py-2.5 text-xs text-muted-foreground hidden lg:table-cell">{file.location}</td>
      <td className="px-3 py-2.5"><StatusBadge status={file.status} /></td>
      <td className="px-3 py-2.5">
        <button type="button" aria-label={`More actions for ${file.name}`} className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground transition-all px-1">
          &middot;&middot;&middot;
        </button>
      </td>
    </tr>
  );
}