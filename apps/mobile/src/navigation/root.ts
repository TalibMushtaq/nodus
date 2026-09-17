// Root navigation handle, used outside React (e.g. a push-notification tap
// listener) to drive navigation.

import { createNavigationContainerRef } from "@react-navigation/native";

import type { RootStackParamList } from "./types";

export const navigationRef = createNavigationContainerRef<RootStackParamList>();

/** Jump to the Activity tab, where pushes land. No-op before the container is ready. */
export function navigateToActivity(): void {
  if (navigationRef.isReady()) {
    navigationRef.navigate("Tabs", { screen: "ActivityTab", params: { screen: "Activity" } });
  }
}
