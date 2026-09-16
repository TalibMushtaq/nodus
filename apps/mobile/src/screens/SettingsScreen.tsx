import * as React from "react";
import { Button, Text, View } from "react-native";

import { useApp } from "../runtime/context";
import { ScreenScroll } from "../runtime/ScreenScroll";
import { Section } from "../runtime/ui";
import { styles } from "../runtime/styles";

/** Device-local preferences, soft-deleted items, and sign-out. */
export function SettingsScreen() {
  const {
    authed,
    busy,
    shardSizeBytes,
    chooseShardSize,
    loadTombstones,
    tombstones,
    tombstoneNames,
    restoreTombstone,
    purgeTombstone,
    signOut,
    wsState,
  } = useApp();

  return (
    <ScreenScroll title="Settings">
      <Section title="10 · Settings">
        <Text style={styles.hint}>
          Shard size: {Math.round(shardSizeBytes / (1024 * 1024))} MB (applies to new uploads)
        </Text>
        <View style={styles.buttonRow}>
          {[4, 8, 16].map((mb) => (
            <Button
              key={mb}
              title={shardSizeBytes === mb * 1024 * 1024 ? `${mb} MB ✓` : `${mb} MB`}
              onPress={() => chooseShardSize(mb * 1024 * 1024)}
              disabled={busy !== null}
            />
          ))}
        </View>
      </Section>

      <Section title="9 · Deleted files">
        <Button
          title="Load deleted"
          onPress={() => void loadTombstones()}
          disabled={!authed || busy !== null}
        />
        {tombstones.length === 0 && <Text style={styles.hint}>Nothing soft-deleted.</Text>}
        {tombstones.map((t) => (
          <View key={`${t.entity_type}:${t.entity_id}`} style={styles.radioRow}>
            <Text style={styles.hint}>
              {tombstoneNames[t.entity_id] ?? `${t.entity_id.slice(0, 12)}…`} · {t.entity_type} ·
              purge after {t.purge_after.slice(0, 10)}
              {t.purge_requested_at ? " · purging" : ""}
            </Text>
            <View style={styles.buttonRow}>
              <Button
                title={busy === `restoring-${t.entity_id}` ? "Restoring…" : "Restore"}
                onPress={() => void restoreTombstone(t)}
                disabled={busy !== null}
              />
              <Button
                title={busy === `purging-${t.entity_id}` ? "Deleting…" : "Delete"}
                onPress={() => purgeTombstone(t)}
                disabled={busy !== null}
              />
            </View>
          </View>
        ))}
      </Section>

      <Section title="Account">
        <Text style={styles.hint}>Relay socket: {wsState}</Text>
        <View style={styles.spacer} />
        <Button title="Sign out" onPress={() => void signOut()} disabled={busy !== null} />
      </Section>
    </ScreenScroll>
  );
}
