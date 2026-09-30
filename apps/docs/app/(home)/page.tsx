import Link from "next/link";

export default function HomePage() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col items-center justify-center gap-8 px-6 py-24 text-center">
      <p className="rounded-full border border-fd-border bg-fd-muted px-3 py-1 text-xs font-medium tracking-wide text-fd-muted-foreground">
        Hybrid offline-first P2P storage
      </p>
      <h1 className="max-w-3xl text-balance text-4xl font-semibold tracking-tight sm:text-6xl">
        Nodus Documentation
      </h1>
      <p className="max-w-2xl text-pretty text-lg text-fd-muted-foreground">
        Files live on a Storage Node you control, sync directly between your
        devices over the local network, and use the Internet only as an
        enhancement — never a dependency.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/docs"
          className="rounded-lg bg-fd-primary px-5 py-2.5 text-sm font-medium text-fd-primary-foreground transition-opacity hover:opacity-90"
        >
          Read the docs
        </Link>
        <Link
          href="/docs/getting-started/quickstart"
          className="rounded-lg border border-fd-border bg-fd-card px-5 py-2.5 text-sm font-medium transition-colors hover:bg-fd-accent"
        >
          Quickstart
        </Link>
      </div>
    </main>
  );
}
