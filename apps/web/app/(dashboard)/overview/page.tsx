import { publicRelayUrl } from "../../../lib/relay";
import { OverviewClient } from "./overview-client";

// Server component: resolve the operator-configured PUBLIC_RELAY_URL here (via
// the server-only accessor) and hand it to the client view as a prop, matching
// the Devices page. The internal RELAY_URL/localhost default never reaches the
// client bundle.
export default function OverviewPage() {
  return <OverviewClient publicRelayUrl={publicRelayUrl()} />;
}
