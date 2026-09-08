import type { ReactNode } from "react";

// Breadcrumb — the Files toolbar's folder context. Current segment is
// foreground/medium, ancestors are muted.
interface BreadcrumbProps {
  items: string[];
  separator?: ReactNode;
}

export function Breadcrumb({ items, separator = "/" }: BreadcrumbProps) {
  return (
    <nav className="flex items-center gap-1 text-xs text-muted-foreground">
      {items.map((item, i) => {
        const last = i === items.length - 1;
        const key = `${item}-${i}`;
        return (
          <span key={key} className="flex items-center gap-1">
            {i > 0 && <span aria-hidden>{separator}</span>}
            <span className={last ? "text-foreground font-medium" : ""}>{item}</span>
          </span>
        );
      })}
    </nav>
  );
}