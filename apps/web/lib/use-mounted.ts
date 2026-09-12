"use client";

import { useSyncExternalStore } from "react";

// The "store" never changes; we only care which environment React is rendering
// in. Passing a distinct server snapshot is the documented way to render a
// client-only value without a hydration mismatch: during SSR and hydration React
// uses `getServerSnapshot` (false), then immediately re-renders with the client
// snapshot (true).
const subscribe = () => () => {};

/** False during SSR and the hydration pass; true once running on the client. */
export function useMounted(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
