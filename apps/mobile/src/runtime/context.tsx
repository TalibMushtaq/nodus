import { createContext, useContext } from "react";

import { useNodusApp } from "./useNodusApp";

/**
 * The full mobile app state/actions. Inferred from the hook so it can never
 * drift from what `useNodusApp` actually exposes.
 */
export type AppValue = ReturnType<typeof useNodusApp>;

export const AppContext = createContext<AppValue | null>(null);

/** Read the app state/actions from any navigator screen. */
export function useApp(): AppValue {
  const value = useContext(AppContext);
  if (!value) {
    throw new Error("useApp must be used inside the Nodus app provider");
  }
  return value;
}
