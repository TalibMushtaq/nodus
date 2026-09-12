import Link from "next/link";

// Root-level 404. Next renders this for unmatched routes and for notFound()
// calls; before this existed, unknown paths showed the default framework 404.
export default function NotFound() {
  return (
    <div className="min-h-dvh flex items-center justify-center bg-background p-6">
      <div className="max-w-sm w-full text-center space-y-3">
        <div className="text-sm font-semibold text-foreground">Page not found</div>
        <p className="text-xs text-muted-foreground">
          The page you requested does not exist or has moved.
        </p>
        <Link href="/" className="inline-block text-xs text-accent hover:opacity-80">
          Go to Nodus
        </Link>
      </div>
    </div>
  );
}
