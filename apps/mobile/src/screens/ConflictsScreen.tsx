import * as React from "react";
import { Button, Text, View } from "react-native";

import { useApp } from "../runtime/context";
import { ScreenScroll } from "../runtime/ScreenScroll";
import { Section } from "../runtime/ui";
import { styles } from "../runtime/styles";

/** Conflict inbox (ADR-0003): preserved version forks awaiting resolution. */
export function ConflictsScreen() {
  const { authed, busy, conflicts, loadConflicts, resolveConflict } = useApp();

  return (
    <ScreenScroll title="Conflicts">
      <Section title="Conflicts (ADR-0003)">
        <Button title="Load conflicts" onPress={() => void loadConflicts()} disabled={!authed || busy !== null} />
        {conflicts.length === 0 && <Text style={styles.hint}>No unresolved conflicts.</Text>}
        {conflicts.map((c) => (
          <View key={c.fileId} style={styles.radioRow}>
            <Text style={styles.hint}>
              {c.name} · version{c.versions.length === 1 ? "" : "s"} {c.versions.join(", ")}
              {c.siblingName ? `\nPreserved as ${c.siblingName}` : ""}
            </Text>
            <Button
              title={busy === `resolving-${c.fileId}` ? "Resolving…" : "Resolve"}
              onPress={() => void resolveConflict(c.fileId)}
              disabled={busy !== null}
            />
          </View>
        ))}
      </Section>
    </ScreenScroll>
  );
}
