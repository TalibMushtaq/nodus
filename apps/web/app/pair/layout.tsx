import type { ReactNode } from "react";
import { requireAuth } from "../../lib/session";

// Phase 7a §4: pairing needs an account session (the Relay issues device-bound
// tokens to the authenticated account). Unauthenticated users are redirected
// to /auth before the pairing UI renders.
export default async function PairLayout({ children }: { children: ReactNode }) {
  await requireAuth();
  return children;
}