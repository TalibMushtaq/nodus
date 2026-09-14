interface StatCardProps {
  label: string;
  value: string;
  sub: string;
  link: string;
  color: string;
  onClick?: () => void;
}

// Overview stat cards. The status color tints the surface and drives a top
// hairline so the four figures stay visually distinct without four loud blocks.
// Tints derive via color-mix so they keep working for both hex colors and the
// per-mode status CSS variables. The value uses the display face: these are the
// headline numbers, and the serif/technical face gives them editorial weight.
export function StatCard({ label, value, sub, link, color, onClick }: StatCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="card-interactive group relative flex flex-col gap-2 overflow-hidden rounded-2xl border p-4 text-left"
      style={{
        background: `color-mix(in srgb, ${color} 7%, var(--color-card))`,
        borderColor: `color-mix(in srgb, ${color} 22%, transparent)`,
      }}
    >
      <span
        aria-hidden
        className="absolute inset-x-0 top-0 h-0.5"
        style={{ background: `color-mix(in srgb, ${color} 60%, transparent)` }}
      />
      <div className="text-[11px] font-medium uppercase tracking-[0.12em]" style={{ color }}>
        {label}
      </div>
      <div className="font-display text-[30px] font-semibold leading-none tabular-nums text-foreground">
        {value}
      </div>
      <div
        className="mt-auto flex items-center justify-between border-t pt-2 text-xs text-muted-foreground"
        style={{ borderColor: `color-mix(in srgb, ${color} 18%, transparent)` }}
      >
        <span>{sub}</span>
        <span
          className="font-medium opacity-0 transition-opacity group-hover:opacity-100"
          style={{ color }}
        >
          {link}
        </span>
      </div>
    </button>
  );
}
