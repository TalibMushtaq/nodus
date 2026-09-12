import { ActivityClient } from "./activity-client";

// Server wrapper. Activity is derived from this device's local transfer log
// (there is no server-side history endpoint); see lib/transfer-log.ts.
export default function ActivityPage() {
  return <ActivityClient />;
}
