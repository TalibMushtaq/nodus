"use client";

import { useEffect } from "react";
import { Button } from "@repo/ui/primitives/button";

// Route-level error boundary. Without this, any render/data error in a page
// under the dashboard root fell through to Next's default, unstyled error
// screen. `reset` re-renders the failed segment.
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface the real error in the console; production users see only the UI.
    console.error(error);
  }, [error]);

  return (
    <div className="min-h-dvh flex items-center justify-center bg-background p-6">
      <div className="max-w-sm w-full text-center space-y-4">
        <div className="text-sm font-semibold text-foreground">Something went wrong</div>
        <p className="text-xs text-muted-foreground">
          {error.message || "An unexpected error occurred while rendering this page."}
        </p>
        <Button variant="primary" size="sm" onClick={reset}>
          Try again
        </Button>
      </div>
    </div>
  );
}
