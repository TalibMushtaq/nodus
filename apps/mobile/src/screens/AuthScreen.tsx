// Signed-out screen: sign in, create an account (with recovery-phrase
// enrollment), or recover an account from its phrase.
//
// Registration mirrors the web flow: the 24-word phrase is generated locally,
// shown once, and confirmed as saved before the account is created; only its
// derived public key is sent to the Relay (ADR-0002).

import * as React from "react";
import { Pressable, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  Button,
  Card,
  Divider,
  Icon,
  Screen,
  TextField,
  ThemedText,
  useTheme,
} from "../design";
import { AppStatusLine } from "../runtime/AppStatusLine";
import { useApp } from "../runtime/context";

type Mode = "signin" | "register" | "recover";

const MODE_LABEL: Record<Mode, string> = {
  signin: "Sign in",
  register: "Create account",
  recover: "Recover",
};

export function AuthScreen() {
  const {
    email,
    setEmail,
    password,
    setPassword,
    busy,
    device,
    signIn,
    recoveryPhraseInput,
    setRecoveryPhraseInput,
    recoverAccount,
    signupPhrase,
    beginSignUp,
    cancelSignUp,
    signUp,
  } = useApp();
  const theme = useTheme();
  const [mode, setMode] = React.useState<Mode>("signin");
  const [savedPhrase, setSavedPhrase] = React.useState(false);

  const switchMode = (next: Mode) => {
    // Leaving registration must discard the generated phrase so it is never
    // used for a later, different account.
    if (mode === "register") cancelSignUp();
    setSavedPhrase(false);
    setMode(next);
  };

  const primary = () => {
    if (mode === "signin") return void signIn();
    if (mode === "recover") return void recoverAccount();
    if (signupPhrase) return void signUp();
    return beginSignUp();
  };

  const primaryDisabled =
    busy !== null ||
    (mode === "signin" && (!email.trim() || !password)) ||
    (mode === "register" && (!email.trim() || !password || (signupPhrase ? !savedPhrase : false))) ||
    (mode === "recover" && (!email.trim() || !recoveryPhraseInput.trim()));

  const primaryLabel = () => {
    if (busy === "signing-in") return "Signing in…";
    if (busy === "recovering") return "Recovering…";
    if (busy === "creating-account") return "Creating…";
    if (mode === "register" && !signupPhrase) return "Generate recovery phrase";
    if (mode === "register") return "Create account";
    return MODE_LABEL[mode];
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }} edges={["top", "bottom"]}>
      <Screen>
        <View
          style={{ alignItems: "center", marginTop: theme.spacing.xxl, marginBottom: theme.spacing.xl }}
        >
          <View
            style={{
              width: 48,
              height: 48,
              borderRadius: theme.radius.md,
              backgroundColor: theme.colors.primary,
              alignItems: "center",
              justifyContent: "center",
              marginBottom: theme.spacing.md,
            }}
          >
            <Icon name="database" size={24} color={theme.colors.primaryForeground} />
          </View>
          <ThemedText variant="title">Nodus</ThemedText>
          <ThemedText variant="caption" tone="muted" style={{ marginTop: 4 }}>
            Your files, on your own hardware
          </ThemedText>
        </View>

        {/* Mode switch */}
        <View
          style={{
            flexDirection: "row",
            borderWidth: 1,
            borderColor: theme.colors.border,
            borderRadius: theme.radius.sm,
            overflow: "hidden",
            marginBottom: theme.spacing.lg,
          }}
        >
          {(["signin", "register"] as Mode[]).map((m) => (
            <Pressable
              key={m}
              onPress={() => switchMode(m)}
              style={{
                flex: 1,
                paddingVertical: theme.spacing.sm,
                alignItems: "center",
                backgroundColor: mode === m ? theme.colors.accent : "transparent",
              }}
            >
              <ThemedText
                variant="bodyMedium"
                style={{
                  color: mode === m ? theme.colors.accentForeground : theme.colors.mutedForeground,
                }}
              >
                {MODE_LABEL[m]}
              </ThemedText>
            </Pressable>
          ))}
        </View>

        <AppStatusLine />

        <Card style={{ padding: theme.spacing.lg, gap: theme.spacing.md }}>
          <TextField
            label="Email"
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            keyboardType="email-address"
            autoCapitalize="none"
          />

          {mode !== "recover" ? (
            <TextField
              label="Password"
              value={password}
              onChangeText={setPassword}
              placeholder="••••••••"
              secureTextEntry
            />
          ) : null}

          {mode === "recover" ? (
            <TextField
              label="Recovery phrase"
              hint="The 24 words you saved when you enrolled."
              value={recoveryPhraseInput}
              onChangeText={setRecoveryPhraseInput}
              placeholder="word1 word2 … word24"
              autoCapitalize="none"
              multiline
            />
          ) : null}

          {mode === "register" && signupPhrase ? <RecoveryPhraseGrid phrase={signupPhrase} /> : null}

          {mode === "register" && signupPhrase ? (
            <Pressable
              onPress={() => setSavedPhrase((v) => !v)}
              style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing.sm }}
            >
              <View
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: theme.radius.sm,
                  borderWidth: 1,
                  borderColor: savedPhrase ? theme.colors.accent : theme.colors.border,
                  backgroundColor: savedPhrase ? theme.colors.accent : "transparent",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {savedPhrase ? (
                  <Icon name="check" size={13} color={theme.colors.accentForeground} />
                ) : null}
              </View>
              <ThemedText variant="caption" tone="muted" style={{ flex: 1 }}>
                I have saved this phrase. Nodus cannot recover it for me.
              </ThemedText>
            </Pressable>
          ) : null}

          <Button
            title={primaryLabel()}
            onPress={primary}
            disabled={primaryDisabled}
            loading={busy !== null}
          />
        </Card>

        <Divider />

        <View style={{ marginTop: theme.spacing.lg }}>
          {mode === "recover" ? (
            <Button title="Back to sign in" variant="ghost" onPress={() => switchMode("signin")} />
          ) : (
            <Button
              title="Use a recovery phrase"
              variant="ghost"
              onPress={() => switchMode("recover")}
            />
          )}
        </View>

        <ThemedText
          variant="monoSmall"
          tone="muted"
          style={{ textAlign: "center", marginTop: theme.spacing.lg }}
        >
          Device {device?.device_id.slice(0, 12) ?? "…"}… · key stays on this device
        </ThemedText>
      </Screen>
    </SafeAreaView>
  );
}

/** 24-word enrollment grid with fixed indexing (the phrase is an ordered seed). */
function RecoveryPhraseGrid({ phrase }: { phrase: string }) {
  const theme = useTheme();
  const words = phrase.trim().split(/\s+/);
  const columns: string[][] = [[], [], []];
  words.forEach((word, i) => columns[i % 3].push(`${i + 1}. ${word}`));
  return (
    <View style={{ gap: theme.spacing.sm }}>
      <ThemedText variant="label" tone="muted">
        Recovery phrase
      </ThemedText>
      <View
        style={{
          flexDirection: "row",
          gap: theme.spacing.md,
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: theme.radius.md,
          backgroundColor: theme.colors.secondary,
          padding: theme.spacing.md,
        }}
      >
        {columns.map((col, i) => (
          <View key={i} style={{ flex: 1, gap: 4 }}>
            {col.map((word) => (
              <ThemedText key={word} variant="monoSmall">
                {word}
              </ThemedText>
            ))}
          </View>
        ))}
      </View>
      <ThemedText variant="caption" tone="destructive">
        Anyone with these words can recover your account. Write them down and keep them offline.
      </ThemedText>
    </View>
  );
}
