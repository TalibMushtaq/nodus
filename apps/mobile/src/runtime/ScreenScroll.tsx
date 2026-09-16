import * as React from "react";
import { ScrollView, Text } from "react-native";

import { useApp } from "./context";
import { styles } from "./styles";

/**
 * Common screen frame: a scrolling body plus the app-wide busy/error/notice
 * line that used to sit at the bottom of the single-screen console.
 */
export function ScreenScroll({
  title,
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  const { busy, error, notice } = useApp();
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {title ? <Text style={styles.title}>{title}</Text> : null}
      {children}
      {busy && <Text style={styles.hint}>Working… ({busy})</Text>}
      {error && <Text style={styles.error}>{error}</Text>}
      {notice && !error && <Text style={styles.ok}>{notice}</Text>}
    </ScrollView>
  );
}
