// Fallback rendered inside the dashboard shell while a route segment loads, so
// the sidebar/topbar stay put and only the content area shows the pending state.
export default function DashboardLoading() {
  return (
    <div className="p-6" role="status" aria-live="polite">
      <span className="text-xs text-muted-foreground">Loading…</span>
    </div>
  );
}
