// Serialize async work by a string key.
//
// The catalog/folder refreshes are fetch → upsert-many → prune. Two overlapping
// runs interleave those phases: an older snapshot's prune can delete rows a
// newer run just upserted, and both then write the same cache. Chaining each
// key's runs guarantees no interleave, while still letting every caller get its
// own fresh fetch (unlike coalescing onto one in-flight promise, which would
// hand a later caller an older snapshot).

const chains = new Map<string, Promise<unknown>>();

/** Run `work` after any same-key work already queued; failures don't block the chain. */
export function serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  // Run regardless of whether the previous link resolved or rejected.
  const run = previous.then(work, work);
  // Keep the chain alive on both success and failure so a later call still runs.
  chains.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}
