import { publicRelayUrl } from "../../../lib/relay";
import { DevicesClient } from "./devices-client";

// Server component: resolve the operator-configured PUBLIC_RELAY_URL here (via
// the server-only accessor) and hand it to the client view as a prop. The
// internal RELAY_URL/localhost default never crosses into the client bundle.
export default function DevicesPage() {
  return <DevicesClient publicRelayUrl={publicRelayUrl()} />;
}
