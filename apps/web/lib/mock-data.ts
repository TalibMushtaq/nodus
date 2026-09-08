import type { FileRow, VersionInfo, ActivityEvent, StorageNode, ClientDevice, KeyEnvelope, RevocationEntry, DeviceMini } from "@repo/ui/domain/types";
import type { TransferPath } from "@repo/ui/primitives/path-indicator";
import type { FilterOption } from "@repo/ui/primitives/filter-chips";

export const files: FileRow[] = [
  { id: "1", name: "Documents", type: "folder", size: "2.3 GB", modified: "Today 14:22", location: "Home NAS", status: "synced" },
  { id: "2", name: "IMG_2847.heic", type: "file", ext: "HEIC", size: "4.2 MB", modified: "Today 12:10", location: "Home NAS", status: "synced" },
  { id: "3", name: "backup-2024.tar.gz", type: "file", ext: "GZ", size: "1.8 GB", modified: "Yesterday", location: "Relay buffer", status: "pending" },
  { id: "4", name: "project-notes.md", type: "file", ext: "MD", size: "12 KB", modified: "Yesterday 09:30", location: "Home NAS", status: "synced" },
  { id: "5", name: "design-final-v3.fig", type: "file", ext: "FIG", size: "89 MB", modified: "2 days ago", location: "Home NAS", status: "conflict" },
  { id: "6", name: "db-export.sql", type: "file", ext: "SQL", size: "340 MB", modified: "3 days ago", location: "Home NAS", status: "synced" },
  { id: "7", name: "secrets.enc", type: "file", ext: "ENC", size: "2.1 MB", modified: "1 week ago", location: "Local only", status: "local-only" },
];

export const mockVersions: VersionInfo[] = [
  { version: "v3", timestamp: "Today 14:22:07", device: "Home NAS", size: "89 MB" },
  { version: "v2", timestamp: "Yesterday 09:30:12", device: "MacBook Pro", size: "84 MB" },
  { version: "v1", timestamp: "3 days ago 16:45:00", device: "MacBook Pro", size: "72 MB" },
];

export const nodes: StorageNode[] = [
  { id: "n1", name: "Home NAS", statusLabel: "Online \u00B7 Local P2P", status: "synced", used: "1.2 TB", total: "2 TB", lastSeen: "2 min ago", addr: "192.168.1.100:8443" },
  { id: "n2", name: "DigitalOcean droplet", statusLabel: "Online \u00B7 Relay", status: "pending", used: "480 GB", total: "500 GB", lastSeen: "5 min ago", addr: "143.198.42.88:8443" },
  { id: "n3", name: "Office server", statusLabel: "Offline", status: "offline", used: "320 GB", total: "1 TB", lastSeen: "3 days ago", addr: "10.0.0.50:8443" },
];

export const devices: ClientDevice[] = [
  { id: "c1", name: "MacBook Pro", status: "synced", lastActive: "Now" },
  { id: "c2", name: "iPhone 15", status: "pending", lastActive: "2 hours ago" },
  { id: "c3", name: "iPad Air", status: "synced", lastActive: "Yesterday" },
];

export const recentActivity: ActivityEvent[] = [
  { id: "a1", event: "Upload complete", type: "upload", file: "IMG_2847.heic", device: "MacBook Pro", path: "local" as TransferPath, time: "2 min ago", status: "complete" },
  { id: "a2", event: "Syncing...", type: "download", file: "backup-2024.tar.gz", device: "DigitalOcean droplet", path: "relay" as TransferPath, time: "5 min ago", status: "in-progress" },
  { id: "a3", event: "Conflict detected", type: "conflict", file: "design-final-v3.fig", device: "Home NAS", path: "local" as TransferPath, time: "1 hour ago", status: "failed" },
  { id: "a4", event: "File downloaded", type: "download", file: "project-notes.md", device: "Home NAS", path: "local" as TransferPath, time: "2 hours ago", status: "complete" },
  { id: "a5", event: "Upload complete", type: "upload", file: "db-export.sql", device: "MacBook Pro", path: "relay" as TransferPath, time: "3 hours ago", status: "complete" },
  { id: "a6", event: "Rename sync", type: "rename", file: "report.pdf", device: "Home NAS", path: "local" as TransferPath, time: "Yesterday", status: "complete" },
  { id: "a7", event: "Delete sync", type: "delete", file: "old-backup.tar", device: "Home NAS", path: "local" as TransferPath, time: "Yesterday", status: "complete" },
];

export const keyEnvelopes: KeyEnvelope[] = [
  { device: "Home NAS", id: "na-ks-ef92b", files: 1847, updated: "2 min ago" },
  { device: "MacBook Pro", id: "mb-ks-3af1c", files: 1847, updated: "Now" },
  { device: "iPhone 15", id: "ip-ks-7d22a", files: 1847, updated: "2 hours ago" },
];

export const revocationList: RevocationEntry[] = [
  { name: "MacBook Pro", id: "c1", lastActive: "Now", status: "active" },
  { name: "iPhone 15", id: "c2", lastActive: "2 hours ago", status: "active" },
  { name: "iPad Air", id: "c3", lastActive: "Yesterday", status: "active" },
  { name: "Old Pixel 7", id: "c4", lastActive: "2 months ago", status: "revoked" },
];

export const storageNodes: StorageNode[] = nodes;

export const activityFilters: readonly FilterOption[] = [
  { label: "Uploads", color: "var(--color-accent)" },
  { label: "Downloads", color: "#059669" },
  { label: "Conflicts", color: "var(--status-conflict)" },
  { label: "Errors", color: "var(--color-destructive)" },
] as const;

export const topologyNodes: DeviceMini[] = [
  { name: "MacBook Pro", type: "client", status: "synced", detail: "Connected locally", color: "var(--color-accent)" },
  { name: "Home NAS", type: "node", status: "synced", detail: "Online \u00B7 Local P2P", color: "var(--color-accent)" },
  { name: "Go Relay", type: "node", status: "synced", detail: "relay.nodus.dev", color: "#059669" },
  { name: "iPhone 15", type: "client", status: "pending", detail: "Connected via relay", color: "var(--status-pending)" },
];