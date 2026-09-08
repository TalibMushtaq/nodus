import type { ReactNode } from "react";

// Page section primitive: an uppercase-tracked eyebrow header + optional
// right-aligned action, followed by the section body. Matches the prototype's
// "text-xs font-semibold text-muted-foreground uppercase tracking-wider".
interface SectionProps {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}

export function Section({ title, action, children }: SectionProps) {
  return (
    <section>
      <div className="flex items-center justify-between mb-2 px-1">
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}