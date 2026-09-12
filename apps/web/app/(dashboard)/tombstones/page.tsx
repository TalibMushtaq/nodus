import { TombstonesClient } from "./tombstones-client";

// Tombstone (soft-delete) view. Like Files, this is client-side because names
// are decrypted with the device-only FEK.
export default function TombstonesPage() {
  return <TombstonesClient />;
}
