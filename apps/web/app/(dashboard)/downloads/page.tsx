import { DownloadsClient } from "./downloads-client";

// Server wrapper. Active downloads come live from DownloadProvider; history is
// the download slice of this device's local transfer log, reconciled with the
// account-wide feed (see lib/transfer-log.ts).
export default function DownloadsPage() {
  return <DownloadsClient />;
}
