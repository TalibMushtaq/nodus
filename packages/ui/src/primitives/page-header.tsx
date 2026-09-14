import type { ReactNode } from "react";

// Editorial page intro: an optional eyebrow, a display-face title, a short
// description, and a right-aligned action slot. Every routed page opens with
// one so the dashboard reads as a sequence of titled surfaces instead of a
// wall of cards. Kept presentational — no routing or data coupling.
interface PageHeaderProps {
  /** Tiny tracked label above the title (e.g. "Storage"). */
  eyebrow?: string;
  title: string;
  description?: string;
  /** Buttons/controls placed opposite the title. Wraps below on narrow widths. */
  actions?: ReactNode;
}

export function PageHeader({ eyebrow, title, description, actions }: PageHeaderProps) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div className="min-w-0">
        {eyebrow && (
          <div className="mb-2 flex items-center gap-2">
            <span className="h-1 w-1 rounded-full bg-accent" aria-hidden />
            <span className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
              {eyebrow}
            </span>
          </div>
        )}
        <h1 className="font-display text-[26px] font-semibold leading-tight tracking-[-0.02em] text-foreground sm:text-[30px]">
          {title}
        </h1>
        {description && (
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
