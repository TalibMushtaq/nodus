// Fallback rendered inside the dashboard shell while a route segment loads.
// A low-contrast skeleton mirrors the page header + stat-card rhythm so the
// swap to real content does not jump the layout.
export default function DashboardLoading() {
  return (
    <div className="w-full space-y-8 p-6" role="status" aria-live="polite">
      <div className="animate-pulse space-y-3">
        <span className="block h-3 w-20 rounded-full bg-border" />
        <span className="block h-7 w-52 rounded-lg bg-border" />
        <span className="block h-3 w-80 max-w-full rounded-full bg-border" />
      </div>
      <div className="grid animate-pulse grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <span key={index} className="block h-28 rounded-2xl bg-border/60" />
        ))}
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}
