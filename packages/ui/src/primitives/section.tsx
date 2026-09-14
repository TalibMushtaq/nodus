import type { ReactNode } from "react";

// Page section primitive: a display-face section heading + optional right-aligned
// action, followed by the body. Sits one level below PageHeader so the hierarchy
// is page title (H1) → section heading (H2) → card label, all left-aligned.
interface SectionProps {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}

export function Section({ title, description, action, children }: SectionProps) {
  return (
    <section className="rise">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2 px-0.5">
        <div className="min-w-0">
          <h2 className="font-display text-sm font-semibold tracking-[-0.01em] text-foreground">
            {title}
          </h2>
          {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
