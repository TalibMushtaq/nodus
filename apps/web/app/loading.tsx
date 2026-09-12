// Route transition fallback for the root. Kept minimal so navigating between
// pages does not flash a large skeleton.
export default function Loading() {
  return (
    <div className="min-h-dvh flex items-center justify-center bg-background" role="status" aria-live="polite">
      <span className="text-xs text-muted-foreground">Loading…</span>
    </div>
  );
}
