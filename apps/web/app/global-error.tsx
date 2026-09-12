"use client";

// Last-resort boundary: replaces the root layout, so it cannot rely on the
// app's CSS or providers and must render its own <html>/<body> with inline
// styles. Only errors that escape app/error.tsx (e.g. a failing root layout or
// provider) land here.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "system-ui, sans-serif",
          background: "#f7f5f2",
          color: "#1c1a17",
          padding: "1.5rem",
        }}
      >
        <div style={{ maxWidth: 360, textAlign: "center" }}>
          <div style={{ fontWeight: 600, marginBottom: "0.5rem" }}>Nodus failed to start</div>
          <p style={{ fontSize: "0.75rem", color: "#6b655e", marginBottom: "1rem" }}>
            {error.message || "An unexpected error occurred."}
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              padding: "0.5rem 0.9rem",
              fontSize: "0.75rem",
              border: "none",
              borderRadius: 6,
              background: "#a94d12",
              color: "#fff",
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
