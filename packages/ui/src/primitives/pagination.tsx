interface PaginationProps {
  total: number;
  current: number;
  totalPages: number;
  onPage: (p: number) => void;
}

export function Pagination({ total, current, totalPages, onPage }: PaginationProps) {
  return (
    <div className="flex items-center justify-between px-5 py-2.5 border-t border-border shrink-0">
      <span className="text-xs text-muted-foreground font-mono">{total} items</span>
      <div className="flex items-center gap-1">
        {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onPage(p)}
            className={`w-7 h-7 text-xs rounded-sm ${
              p === current ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-secondary"
            }`}
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}