import * as React from "react";
import { Button, Text, View } from "react-native";

import { useApp } from "../runtime/context";
import { ScreenScroll } from "../runtime/ScreenScroll";
import { Section } from "../runtime/ui";
import { styles } from "../runtime/styles";

/** Key-envelope coverage, envelope backup export, and recovery-phrase controls. */
export function SecurityScreen() {
  const {
    authed,
    busy,
    loadEnvelopes,
    envelopeSummary,
    exportEnvelopes,
    securityStatus,
    revealedPhrase,
    setRevealedPhrase,
    revealPhrase,
    copyPhrase,
    rotateRecovery,
  } = useApp();

  return (
    <ScreenScroll title="Security">
      <Section title="13 · Security">
        <Button
          title="Load envelope coverage"
          onPress={() => void loadEnvelopes()}
          disabled={!authed || busy !== null}
        />
        {envelopeSummary.length === 0 && (
          <Text style={styles.hint}>No envelope coverage loaded.</Text>
        )}
        {envelopeSummary.map((s) => (
          <Text key={`${s.recipient_kind}:${s.recipient_id}`} style={styles.hint}>
            {s.recipient_kind} {s.recipient_id.slice(0, 12)}… · {s.file_count} file /{" "}
            {s.folder_count} folder
            {s.last_updated ? ` · ${s.last_updated.slice(0, 10)}` : ""}
          </Text>
        ))}
        <View style={styles.spacer} />
        <Button
          title={busy === "exporting-envelopes" ? "Exporting…" : "Export envelope backup"}
          onPress={() => void exportEnvelopes()}
          disabled={!authed || busy !== null}
        />
        {securityStatus && <Text style={styles.hint}>{securityStatus}</Text>}

        <View style={styles.spacer} />
        <Button
          title={revealedPhrase ? "Hide recovery phrase" : "Reveal recovery phrase"}
          onPress={() => (revealedPhrase ? setRevealedPhrase(null) : void revealPhrase())}
          disabled={!authed || busy !== null}
        />
        {revealedPhrase && (
          <>
            <Text style={styles.hint}>
              Anyone with these words can recover the account. Keep them offline.
            </Text>
            <Text style={styles.code}>{revealedPhrase}</Text>
            <Button title="Copy phrase" onPress={() => void copyPhrase()} disabled={busy !== null} />
          </>
        )}

        <View style={styles.spacer} />
        <Button
          title={busy === "rotating-recovery" ? "Regenerating…" : "Regenerate recovery key"}
          onPress={() => rotateRecovery()}
          disabled={!authed || busy !== null}
        />
      </Section>
    </ScreenScroll>
  );
}
