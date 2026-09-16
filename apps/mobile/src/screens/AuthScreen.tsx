import * as React from "react";
import { Button, Text, TextInput, View } from "react-native";

import { useApp } from "../runtime/context";
import { ScreenScroll } from "../runtime/ScreenScroll";
import { Section } from "../runtime/ui";
import { styles } from "../runtime/styles";

/**
 * Signed-out screen: relay sign-in plus account recovery. Both need the same
 * email field, so they share this screen rather than a separate recovery route.
 */
export function AuthScreen() {
  const {
    email,
    setEmail,
    password,
    setPassword,
    authed,
    busy,
    device,
    signIn,
    signOut,
    wsState,
    recoveryPhraseInput,
    setRecoveryPhraseInput,
    recoverAccount,
  } = useApp();

  return (
    <ScreenScroll title="Sign in to Nodus">
      <Section title="1 · Relay sign-in">
        <TextInput
          style={styles.input}
          value={email}
          onChangeText={setEmail}
          placeholder="email"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
        />
        <TextInput
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          placeholder="password"
          secureTextEntry
        />
        <Button
          title={authed ? "Signed in" : "Sign in"}
          onPress={() => void signIn()}
          disabled={!device || busy !== null || authed}
        />
        {authed && (
          <>
            <Text style={styles.hint}>Relay socket: {wsState}</Text>
            <View style={styles.spacer} />
            <Button title="Sign out" onPress={() => void signOut()} disabled={busy !== null} />
          </>
        )}
      </Section>

      <Section title="12 · Recover account">
        <Text style={styles.hint}>
          Uses the account email above and your 24-word recovery phrase (ADR-0002).
        </Text>
        <TextInput
          style={styles.input}
          value={recoveryPhraseInput}
          onChangeText={setRecoveryPhraseInput}
          placeholder="recovery phrase (24 words)"
          autoCapitalize="none"
          autoCorrect={false}
          multiline
        />
        <Button
          title={busy === "recovering" ? "Recovering…" : "Recover account"}
          onPress={() => void recoverAccount()}
          disabled={busy !== null || !email.trim() || !recoveryPhraseInput.trim()}
        />
      </Section>
    </ScreenScroll>
  );
}
