// Native device fingerprint sent with login/register so the Relay can label
// this device ("iOS 17.5 · Nodus 1.4") in the Devices list. Display-only; the
// Relay never relies on it for authentication.

import Constants from "expo-constants";
import { Platform } from "react-native";
import type { DeviceInfo } from "@repo/sdk";

/** Read React Native / Expo platform details for the current install. */
export function detectDeviceInfo(): DeviceInfo {
  const platform = Platform.OS;
  let osVersion: string | undefined;
  if (platform === "android") {
    // `Platform.Version` is the API level; `constants.Release` is the marketing
    // Android version ("13"), which is what a user recognizes.
    const release = (Platform.constants as { Release?: string }).Release;
    osVersion = release || String(Platform.Version);
  } else if (platform === "ios") {
    osVersion = String(Platform.Version);
  }
  return {
    platform,
    os_version: osVersion,
    app_version: Constants.expoConfig?.version ?? undefined,
  };
}
