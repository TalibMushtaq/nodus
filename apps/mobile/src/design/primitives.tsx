// Nodus mobile primitives — the small, single-purpose building blocks every
// screen composes from. They read colors/type from `useTheme()` so the light
// and dark palettes stay consistent without per-screen style forks.

import * as React from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type KeyboardTypeOptions,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { TransferPath } from "@repo/transfer-manager";

import { Icon, pathIconName, type IconName } from "./icons";
import { useTheme } from "./theme";
import type { Theme } from "./tokens";

// ─── Text ────────────────────────────────────────────────────────────────────

export type TextVariant =
  | "title"
  | "subtitle"
  | "body"
  | "bodyMedium"
  | "caption"
  | "label"
  | "sectionLabel"
  | "mono"
  | "monoSmall";

export type TextTone = "default" | "muted" | "accent" | "destructive";

export function ThemedText({
  variant = "body",
  tone = "default",
  style,
  children,
  numberOfLines,
}: {
  variant?: TextVariant;
  tone?: TextTone;
  style?: StyleProp<TextStyle>;
  children: React.ReactNode;
  numberOfLines?: number;
}) {
  const theme = useTheme();
  const toneColor: Record<TextTone, string> = {
    default: theme.colors.foreground,
    muted: theme.colors.mutedForeground,
    accent: theme.colors.accent,
    destructive: theme.colors.destructive,
  };
  return (
    <Text
      numberOfLines={numberOfLines}
      style={[textVariants(theme)[variant], { color: toneColor[tone] }, style]}
    >
      {children}
    </Text>
  );
}

function textVariants(theme: Theme): Record<TextVariant, TextStyle> {
  return {
    title: { fontFamily: theme.fonts.semibold, fontSize: theme.fontSize.lg },
    subtitle: { fontFamily: theme.fonts.regular, fontSize: theme.fontSize.sm },
    body: { fontFamily: theme.fonts.regular, fontSize: theme.fontSize.md },
    bodyMedium: { fontFamily: theme.fonts.medium, fontSize: theme.fontSize.md },
    caption: { fontFamily: theme.fonts.regular, fontSize: theme.fontSize.xs + 1 },
    label: {
      fontFamily: theme.fonts.semibold,
      fontSize: theme.fontSize.xs,
      letterSpacing: 1,
      textTransform: "uppercase",
    },
    sectionLabel: {
      fontFamily: theme.fonts.semibold,
      fontSize: theme.fontSize.xs,
      letterSpacing: 1,
      textTransform: "uppercase",
    },
    mono: { fontFamily: theme.fonts.mono, fontSize: theme.fontSize.sm },
    monoSmall: { fontFamily: theme.fonts.mono, fontSize: theme.fontSize.xs },
  };
}

// ─── Layout ──────────────────────────────────────────────────────────────────

export function Divider() {
  const theme = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.border }} />;
}

/** Tokenised text input with an optional label + hint, used by every form. */
export function TextField({
  label,
  hint,
  value,
  onChangeText,
  placeholder,
  secureTextEntry,
  keyboardType,
  autoCapitalize,
  multiline,
}: {
  label?: string;
  hint?: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  secureTextEntry?: boolean;
  keyboardType?: KeyboardTypeOptions;
  autoCapitalize?: "none" | "sentences" | "words";
  multiline?: boolean;
}) {
  const theme = useTheme();
  return (
    <View style={{ gap: 6 }}>
      {label ? (
        <ThemedText variant="label" tone="muted">
          {label}
        </ThemedText>
      ) : null}
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.mutedForeground}
        secureTextEntry={secureTextEntry}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        multiline={multiline}
        style={{
          borderWidth: 1,
          borderColor: theme.colors.input,
          borderRadius: theme.radius.sm,
          paddingHorizontal: theme.spacing.md,
          paddingVertical: theme.spacing.md,
          backgroundColor: theme.colors.secondary,
          color: theme.colors.foreground,
          fontFamily: theme.fonts.regular,
          fontSize: theme.fontSize.md,
          minHeight: multiline ? 72 : undefined,
          textAlignVertical: multiline ? "top" : "center",
        }}
      />
      {hint ? (
        <ThemedText variant="caption" tone="muted">
          {hint}
        </ThemedText>
      ) : null}
    </View>
  );
}

/** Small filter/segment chip (Activity filters, sort options). */
export function Chip({
  label,
  active = false,
  onPress,
  icon,
}: {
  label: string;
  active?: boolean;
  onPress?: () => void;
  /** Optional leading glyph, e.g. list/grid view choices. */
  icon?: IconName;
}) {
  const theme = useTheme();
  const color = active ? theme.colors.accent : theme.colors.mutedForeground;
  return (
    <Pressable
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: theme.spacing.xs,
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: theme.radius.sm,
        borderWidth: 1,
        borderColor: active ? `${theme.colors.accent}40` : theme.colors.border,
        backgroundColor: active ? `${theme.colors.accent}18` : "transparent",
      }}
    >
      {icon ? <Icon name={icon} size={13} color={color} /> : null}
      <ThemedText
        variant="caption"
        style={{ color, fontFamily: theme.fonts.medium }}
      >
        {label}
      </ThemedText>
    </Pressable>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const theme = useTheme();
  return (
    <View
      style={[
        { backgroundColor: theme.colors.card, borderColor: theme.colors.border, borderWidth: 1, borderRadius: theme.radius.md },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function SectionLabel({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) {
  const theme = useTheme();
  return (
    <ThemedText variant="sectionLabel" tone="muted" style={[{ marginBottom: theme.spacing.sm }, style]}>
      {children}
    </ThemedText>
  );
}

export function Screen({
  children,
  scroll = true,
  refreshing = false,
  onRefresh,
}: {
  children: React.ReactNode;
  scroll?: boolean;
  /** When `onRefresh` is set, the body becomes pull-to-refresh. */
  refreshing?: boolean;
  onRefresh?: () => void;
}) {
  const theme = useTheme();
  const content = (
    <View style={{ padding: theme.spacing.lg, paddingBottom: theme.spacing.xxl * 2 }}>{children}</View>
  );
  if (!scroll) {
    return <View style={{ flex: 1, backgroundColor: theme.colors.background }}>{content}</View>;
  }
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.background }}
      contentContainerStyle={{ flexGrow: 1 }}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        onRefresh ? (
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={theme.colors.mutedForeground}
            colors={[theme.colors.accent]}
          />
        ) : undefined
      }
    >
      {content}
    </ScrollView>
  );
}

export function ScreenHeader({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
}) {
  const theme = useTheme();
  // Tab roots render their own header (the stack header is hidden), so they must
  // inset for the status bar themselves or the title slides under it.
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        justifyContent: "space-between",
        paddingHorizontal: theme.spacing.lg,
        paddingTop: insets.top + theme.spacing.md,
        paddingBottom: theme.spacing.sm,
        backgroundColor: theme.colors.background,
      }}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <ThemedText variant="title">{title}</ThemedText>
        {subtitle ? (
          <ThemedText variant="subtitle" tone="muted" style={{ marginTop: 2 }}>
            {subtitle}
          </ThemedText>
        ) : null}
      </View>
      {right ? <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing.sm }}>{right}</View> : null}
    </View>
  );
}

// ─── Buttons ─────────────────────────────────────────────────────────────────

export type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive";

export function Button({
  title,
  onPress,
  variant = "primary",
  disabled = false,
  loading = false,
  icon,
  style,
}: {
  title: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  icon?: IconName;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const palette: Record<ButtonVariant, { bg: string; fg: string; border: string }> = {
    primary: { bg: theme.colors.accent, fg: theme.colors.accentForeground, border: theme.colors.accent },
    secondary: { bg: theme.colors.card, fg: theme.colors.foreground, border: theme.colors.border },
    ghost: { bg: "transparent", fg: theme.colors.foreground, border: "transparent" },
    destructive: { bg: "transparent", fg: theme.colors.destructive, border: theme.colors.destructive },
  };
  const c = palette[variant];
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: theme.spacing.sm,
          paddingVertical: theme.spacing.md,
          paddingHorizontal: theme.spacing.lg,
          borderRadius: theme.radius.sm,
          backgroundColor: c.bg,
          borderWidth: 1,
          borderColor: c.border,
          opacity: disabled ? 0.45 : pressed ? 0.8 : 1,
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={c.fg} />
      ) : icon ? (
        <Icon name={icon} size={16} color={c.fg} />
      ) : null}
      <Text style={{ fontFamily: theme.fonts.medium, fontSize: theme.fontSize.md, color: c.fg }}>{title}</Text>
    </Pressable>
  );
}

export function IconButton({
  name,
  onPress,
  color,
  size = 20,
  disabled = false,
  accessibilityLabel,
}: {
  name: IconName;
  onPress?: () => void;
  color?: string;
  size?: number;
  disabled?: boolean;
  accessibilityLabel?: string;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      style={({ pressed }) => [{ opacity: disabled ? 0.4 : pressed ? 0.6 : 1 }]}
    >
      <Icon name={name} size={size} color={color ?? theme.colors.foreground} />
    </Pressable>
  );
}

// ─── Status language ─────────────────────────────────────────────────────────

export type SyncStatus = "synced" | "pending" | "conflict" | "offline" | "local-only";

const STATUS_LABEL: Record<SyncStatus, string> = {
  synced: "Synced",
  pending: "Pending",
  conflict: "Conflict",
  offline: "Offline",
  "local-only": "Local only",
};

const STATUS_ICON: Record<SyncStatus, IconName> = {
  synced: "statusSynced",
  pending: "statusPending",
  conflict: "statusConflict",
  offline: "statusOffline",
  "local-only": "statusLocal",
};

export function StatusBadge({
  status,
  variant = "badge",
}: {
  status: SyncStatus;
  variant?: "badge" | "dot" | "inline";
}) {
  const theme = useTheme();
  const key = status === "local-only" ? "local" : status;
  const color = theme.status[key as keyof typeof theme.status];
  const iconName = STATUS_ICON[status];

  if (variant === "dot") {
    return <Icon name={iconName} size={10} color={color} strokeWidth={1.6} />;
  }
  if (variant === "inline") {
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Icon name={iconName} size={10} color={color} strokeWidth={1.6} />
        <Text style={{ fontFamily: theme.fonts.medium, fontSize: theme.fontSize.xs + 1, color }}>{STATUS_LABEL[status]}</Text>
      </View>
    );
  }
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: theme.radius.full,
        backgroundColor: theme.status[`${key}Bg` as keyof typeof theme.status],
        borderWidth: 1,
        borderColor: `${color}30`,
        alignSelf: "flex-start",
      }}
    >
      <Icon name={iconName} size={8} color={color} strokeWidth={1.6} />
      <Text style={{ fontFamily: theme.fonts.semibold, fontSize: theme.fontSize.xs + 1, color }}>{STATUS_LABEL[status]}</Text>
    </View>
  );
}

const PATH_LABEL: Record<TransferPath, string> = {
  local_signaling: "Local P2P",
  relay_signaling: "Relay",
  buffer_relay: "Relay buffer",
  local_queue: "Queued",
};

const PATH_STATUS: Record<TransferPath, keyof Theme["status"]> = {
  local_signaling: "synced",
  relay_signaling: "pending",
  buffer_relay: "pending",
  local_queue: "offline",
};

export function PathIndicator({ path }: { path: TransferPath }) {
  const theme = useTheme();
  const color = theme.status[PATH_STATUS[path]];
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: theme.radius.full,
        backgroundColor: `${color}18`,
        borderWidth: 1,
        borderColor: `${color}40`,
        alignSelf: "flex-start",
      }}
    >
      <Icon name={pathIconName(path)} size={10} color={color} strokeWidth={1.4} />
      <Text style={{ fontFamily: theme.fonts.monoMedium, fontSize: theme.fontSize.xs + 1, color }}>{PATH_LABEL[path]}</Text>
    </View>
  );
}

// ─── Controls ────────────────────────────────────────────────────────────────

export function Toggle({
  value,
  onChange,
  disabled = false,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled }}
      onPress={() => onChange(!value)}
      disabled={disabled}
      style={{
        width: 40,
        height: 22,
        borderRadius: theme.radius.full,
        backgroundColor: value ? theme.colors.accent : theme.colors.border,
        justifyContent: "center",
        alignItems: value ? "flex-end" : "flex-start",
        paddingHorizontal: 2,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <View style={{ width: 18, height: 18, borderRadius: theme.radius.full, backgroundColor: "#FFFFFF" }} />
    </Pressable>
  );
}

export function Progress({ value, tone }: { value: number; tone?: string }) {
  const theme = useTheme();
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <View style={{ height: 4, borderRadius: theme.radius.full, backgroundColor: theme.colors.border, overflow: "hidden" }}>
      <View style={{ width: `${pct}%`, height: "100%", backgroundColor: tone ?? theme.colors.accent }} />
    </View>
  );
}

export function SettingRow({
  label,
  detail,
  right,
  onPress,
  destructive = false,
}: {
  label: string;
  detail?: string;
  right?: React.ReactNode;
  onPress?: () => void;
  destructive?: boolean;
}) {
  const theme = useTheme();
  const body = (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: theme.spacing.md,
        paddingHorizontal: theme.spacing.md,
        paddingVertical: theme.spacing.md,
      }}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <ThemedText variant="body" tone={destructive ? "destructive" : "default"}>
          {label}
        </ThemedText>
        {detail ? (
          <ThemedText variant="monoSmall" tone="muted" style={{ marginTop: 2 }}>
            {detail}
          </ThemedText>
        ) : null}
      </View>
      {right}
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [{ opacity: pressed ? 0.7 : 1 }]}>
      {body}
    </Pressable>
  );
}

// ─── Feedback ────────────────────────────────────────────────────────────────

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: IconName;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  const theme = useTheme();
  return (
    <View
      style={{
        alignItems: "center",
        justifyContent: "center",
        gap: theme.spacing.sm,
        paddingVertical: theme.spacing.xxl,
        paddingHorizontal: theme.spacing.lg,
        borderWidth: 1,
        borderStyle: "dashed",
        borderColor: theme.colors.border,
        borderRadius: theme.radius.md,
      }}
    >
      <Icon name={icon} size={28} color={theme.colors.mutedForeground} />
      <ThemedText variant="bodyMedium">{title}</ThemedText>
      {description ? (
        <ThemedText variant="caption" tone="muted" style={{ textAlign: "center" }}>
          {description}
        </ThemedText>
      ) : null}
      {action ? <View style={{ marginTop: theme.spacing.sm }}>{action}</View> : null}
    </View>
  );
}

export function ConfirmDialog({
  visible,
  title,
  message,
  confirmLabel = "Confirm",
  destructive = false,
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const theme = useTheme();
  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onCancel}>
      <Pressable
        onPress={onCancel}
        style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.45)", alignItems: "center", justifyContent: "center", padding: theme.spacing.lg }}
      >
        <Pressable
          onPress={(e) => e.stopPropagation()}
          style={{
            width: "100%",
            maxWidth: 340,
            backgroundColor: theme.colors.card,
            borderColor: theme.colors.border,
            borderWidth: 1,
            borderRadius: theme.radius.md,
            padding: theme.spacing.lg,
            gap: theme.spacing.sm,
          }}
        >
          <ThemedText variant="bodyMedium">{title}</ThemedText>
          {message ? (
            <ThemedText variant="caption" tone="muted">
              {message}
            </ThemedText>
          ) : null}
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: theme.spacing.sm, marginTop: theme.spacing.sm }}>
            <Button title="Cancel" variant="ghost" onPress={onCancel} style={{ paddingHorizontal: theme.spacing.md }} />
            <Button
              title={confirmLabel}
              variant={destructive ? "destructive" : "primary"}
              onPress={onConfirm}
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

export function Sheet({
  visible,
  title,
  onClose,
  children,
}: {
  visible: boolean;
  title?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const theme = useTheme();
  return (
    <Modal transparent visible={visible} animationType="slide" onRequestClose={onClose}>
      <Pressable onPress={onClose} style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.35)", justifyContent: "flex-end" }}>
        <Pressable
          onPress={(e) => e.stopPropagation()}
          style={{
            backgroundColor: theme.colors.card,
            borderTopColor: theme.colors.border,
            borderTopWidth: 1,
            borderTopLeftRadius: theme.radius.lg,
            borderTopRightRadius: theme.radius.lg,
            padding: theme.spacing.lg,
            paddingBottom: theme.spacing.xxl,
            gap: theme.spacing.sm,
          }}
        >
          {title ? (
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <ThemedText variant="bodyMedium">{title}</ThemedText>
              <IconButton name="close" onPress={onClose} accessibilityLabel="Close" />
            </View>
          ) : null}
          {children}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
