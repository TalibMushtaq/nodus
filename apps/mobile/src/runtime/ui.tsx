import * as React from "react";
import { Text, View } from "react-native";

import type { TransferPath } from "@repo/transfer-manager";

import { styles } from "./styles";

/** Titled block used to group the actions on each screen. */
export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

/** Human label for a transfer path (mirrors the web TransferPathBanner text). */
export function transferPathLabel(path: TransferPath): string {
  switch (path) {
    case "local_signaling":
      return "Direct LAN (local signaling)";
    case "relay_signaling":
      return "Direct (Relay signaling)";
    case "buffer_relay":
      return "Relay buffer";
    case "local_queue":
      return "Queued on device";
    default:
      return path;
  }
}
