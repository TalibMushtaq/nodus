// Pure Activity-tab projections: filter selection and per-kind presentation.
//
// Kept free of React and of runtime-only imports (the `../design` import is
// type-only) so it can be unit-tested without a renderer.

import type { TransferPath } from "@repo/transfer-manager";

import type { IconName } from "../design";
import type { TransferLogEntry, TransferLogKind } from "../store/transfer-log";

export type ActivityFilter = "All" | "Uploads" | "Downloads" | "Conflicts" | "Errors";

export const ACTIVITY_FILTERS: ActivityFilter[] = [
  "All",
  "Uploads",
  "Downloads",
  "Conflicts",
  "Errors",
];

/** Icon and verb for each logged action. */
export const KIND_META: Record<TransferLogKind, { icon: IconName; label: string }> = {
  upload: { icon: "upload", label: "Uploaded" },
  download: { icon: "download", label: "Downloaded" },
  delete: { icon: "trash", label: "Deleted" },
  restore: { icon: "refresh", label: "Restored" },
  purge: { icon: "trash", label: "Deleted permanently" },
  rename: { icon: "edit", label: "Renamed" },
  move: { icon: "move", label: "Moved" },
  conflict: { icon: "alert", label: "Conflict resolved" },
};

export function matchesFilter(entry: TransferLogEntry, filter: ActivityFilter): boolean {
  switch (filter) {
    case "Uploads":
      return entry.kind === "upload";
    case "Downloads":
      return entry.kind === "download";
    case "Conflicts":
      return entry.kind === "conflict";
    case "Errors":
      return entry.outcome === "failed";
    default:
      return true;
  }
}

export function filterActivity(
  entries: TransferLogEntry[],
  filter: ActivityFilter,
): TransferLogEntry[] {
  return entries.filter((entry) => matchesFilter(entry, filter));
}

/** A transfer path is one of the four the shared manager emits. */
export function isTransferPath(value: string | null): value is TransferPath {
  return (
    value === "local_signaling" ||
    value === "relay_signaling" ||
    value === "buffer_relay" ||
    value === "local_queue"
  );
}
