import type { SyncStatus } from "../primitives/badge";
import type { TransferPath } from "../primitives/path-indicator";

export interface FileRow {
  id: string;
  name: string;
  type: "file" | "folder";
  size: string;
  modified: string;
  location: string;
  status: SyncStatus;
  ext?: string;
}

export interface VersionInfo {
  version: string;
  timestamp: string;
  device: string;
  size: string;
}

export interface ActivityEvent {
  id: string;
  event: string;
  type: "upload" | "download" | "conflict" | "error" | "rename" | "delete";
  file: string;
  device: string;
  path: TransferPath;
  time: string;
  status: "complete" | "failed" | "in-progress";
}

export interface StorageNode {
  id: string;
  name: string;
  statusLabel: string;
  status: SyncStatus;
  used: string;
  total: string;
  lastSeen: string;
  addr: string;
}

export interface ClientDevice {
  id: string;
  name: string;
  status: SyncStatus;
  lastActive: string;
}

export interface KeyEnvelope {
  device: string;
  id: string;
  files: number;
  updated: string;
}

export interface RevocationEntry {
  name: string;
  id: string;
  lastActive: string;
  status: "active" | "revoked";
}

export interface DeviceMini {
  name: string;
  type: "node" | "client";
  status: SyncStatus;
  detail: string;
  color: string;
}