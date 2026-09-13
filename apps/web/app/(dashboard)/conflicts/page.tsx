import { ConflictsClient } from "./conflicts-client";

// Conflict inbox (ADR-0003). Client-side because names are decrypted with the
// device-only FEK, matching the Files and Tombstone views.
export default function ConflictsPage() {
  return <ConflictsClient />;
}
