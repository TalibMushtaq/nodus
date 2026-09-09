interface StatCardProps {
  label: string;
  value: string;
  sub: string;
  link: string;
  color: string;
  onClick?: () => void;
}

// Overview stat cards: each has a distinctive color tint from the status palette.
// A hint link appears on hover, matching the prototype's reveal-on-hover pattern.
// Tints and hairlines derive from the color via color-mix so they keep working
// for both hex colors and CSS variable tokens (per-mode status palette).
export function StatCard({ label, value, sub, link, color, onClick }: StatCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="p-4 flex flex-col gap-2 text-left cursor-pointer group rounded-xl border transition-all hover:scale-[1.02] hover:shadow-md"
      style={{
        background: `color-mix(in srgb, ${color} 9%, transparent)`,
        borderColor: `color-mix(in srgb, ${color} 25%, transparent)`,
      }}
    >
      <div className="text-xs font-medium" style={{ color }}>{label}</div>
      <div className="text-3xl font-bold tabular-nums text-foreground">{value}</div>
      <div className="text-xs text-muted-foreground mt-auto pt-2 border-t flex items-center justify-between" style={{ borderColor: `color-mix(in srgb, ${color} 19%, transparent)` }}>
        <span>{sub}</span>
        <span className="opacity-0 group-hover:opacity-100 transition-opacity text-xs font-medium" style={{ color }}>{link}</span>
      </div>
    </button>
  );
}