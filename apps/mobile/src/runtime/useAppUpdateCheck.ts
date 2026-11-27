// Launch-time update prompt for sideloaded builds.
//
// Runs once per cold start after a short delay (so the first frame and the
// session restore settle first). Android cannot install an APK silently for a
// sideloaded app, so the prompt opens the release APK in the browser; the OS
// installer takes over from there. Dev builds never prompt.

import * as React from "react";
import { Alert, Linking } from "react-native";

import { checkForUpdate, currentVersion } from "../update-check";

export function useAppUpdateCheck(): void {
  React.useEffect(() => {
    if (__DEV__) return;

    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const update = await checkForUpdate();
          if (!update || cancelled) return;

          Alert.alert(
            "Update available",
            `Nodus ${update.version} is ready (you have ${currentVersion()}). ` +
              "Download it, then open the APK to update. If Android asks, allow " +
              "installing from your browser.",
            [
              { text: "Later", style: "cancel" },
              {
                text: "Download",
                onPress: () => {
                  void Linking.openURL(update.downloadUrl).catch(() => {
                    // No browser available; the release page remains reachable
                    // through GitHub, so this is not worth another alert.
                  });
                },
              },
            ],
            { cancelable: true },
          );
        } catch {
          // Offline or rate-limited: an update prompt is never worth an error.
        }
      })();
    }, 1500);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);
}
