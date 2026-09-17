// Push notification registration (Phase 3).
//
// The Relay resolves recipients and sends via Expo; this module only acquires
// the device's Expo push token, registers it (with the user's category prefs),
// and surfaces notification taps. Everything is best-effort: push must never
// block sign-in or an action.
//
// An Expo push token requires the EAS project id, supplied through
// EXPO_PUBLIC_EAS_PROJECT_ID. Without it registration is skipped.

import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { relayDeletePushToken, relayRegisterPushToken } from "./relay";

const CHANNEL_ID = "default";

export interface PushPrefs {
  conflicts: boolean;
  deviceOffline: boolean;
  syncComplete: boolean;
}

/** Show notifications while the app is foregrounded (SDK 54+ behavior fields). */
export function configureNotificationHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
}

function easProjectId(): string | undefined {
  return process.env.EXPO_PUBLIC_EAS_PROJECT_ID || undefined;
}

/**
 * Resolve this device's Expo push token, requesting permission first. Returns
 * null when permission is denied or the EAS project id is not configured.
 */
async function acquirePushToken(): Promise<string | null> {
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: "Nodus",
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }

  let { status } = await Notifications.getPermissionsAsync();
  if (status !== "granted") {
    status = (await Notifications.requestPermissionsAsync()).status;
  }
  if (status !== "granted") return null;

  const projectId = easProjectId();
  if (!projectId) return null;

  const token = await Notifications.getExpoPushTokenAsync({ projectId });
  return token.data;
}

/** Register (or refresh) this device's token and prefs with the Relay. */
export async function syncPushRegistration(prefs: PushPrefs): Promise<void> {
  try {
    const token = await acquirePushToken();
    if (!token) return;
    await relayRegisterPushToken(token, Platform.OS, prefs);
  } catch {
    // Offline, denied, or no EAS project id: push stays unconfigured.
  }
}

/** Remove this device's token on sign-out. */
export async function unregisterPush(): Promise<void> {
  try {
    await relayDeletePushToken();
  } catch {
    // Best-effort; the token is invalid anyway once the session is revoked.
  }
}

/** Subscribe to notification taps; returns a subscription to remove. */
export function addNotificationTapListener(
  handler: (response: Notifications.NotificationResponse) => void,
): Notifications.EventSubscription {
  return Notifications.addNotificationResponseReceivedListener(handler);
}
