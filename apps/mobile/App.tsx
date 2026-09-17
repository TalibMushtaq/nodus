import "./src/compat";

// Nodus mobile app shell.
//
// State and networking live in `useNodusApp` (src/runtime/useNodusApp.ts) and
// are provided to every screen through `AppContext`. This file wires the
// design system (theme + fonts) around React Navigation: signed-out users get
// the auth stack, signed-in users get the four-tab shell. Screens stay thin
// view layers.

import * as React from "react";
import { StatusBar } from "expo-status-bar";
import { NavigationContainer, type Theme as NavTheme } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ThemeProvider, useAppFonts, useTheme } from "./src/design";
import { navigateToActivity, navigationRef } from "./src/navigation/root";
import { TabsNavigator } from "./src/navigation/TabsNavigator";
import { addNotificationTapListener } from "./src/notifications";
import { AppContext } from "./src/runtime/context";
import { useNodusApp } from "./src/runtime/useNodusApp";
import { AuthScreen } from "./src/screens/AuthScreen";

const RootStack = createNativeStackNavigator();

function RootNavigator() {
  const app = useNodusApp();
  const theme = useTheme();

  // A tapped push opens the Activity tab. Subscribed here (not in a screen) so
  // it survives whichever tab is mounted.
  React.useEffect(() => {
    const subscription = addNotificationTapListener(() => navigateToActivity());
    return () => subscription.remove();
  }, []);

  // Bridge our design tokens into React Navigation so screen backgrounds,
  // headers and the tab bar follow the same light/dark palette.
  const navigationTheme = React.useMemo<NavTheme>(
    () => ({
      dark: theme.dark,
      colors: {
        primary: theme.colors.accent,
        background: theme.colors.background,
        card: theme.colors.card,
        text: theme.colors.foreground,
        border: theme.colors.border,
        notification: theme.colors.destructive,
      },
      fonts: {
        regular: { fontFamily: theme.fonts.regular, fontWeight: "400" },
        medium: { fontFamily: theme.fonts.medium, fontWeight: "500" },
        bold: { fontFamily: theme.fonts.semibold, fontWeight: "600" },
        heavy: { fontFamily: theme.fonts.bold, fontWeight: "700" },
      },
    }),
    [theme],
  );

  return (
    <AppContext.Provider value={app}>
      <NavigationContainer ref={navigationRef} theme={navigationTheme}>
        <RootStack.Navigator screenOptions={{ headerShown: false }}>
          {app.authed ? (
            <RootStack.Screen name="Tabs" component={TabsNavigator} />
          ) : (
            <RootStack.Screen name="SignIn" component={AuthScreen} />
          )}
        </RootStack.Navigator>
      </NavigationContainer>
    </AppContext.Provider>
  );
}

export default function App() {
  const fontsReady = useAppFonts();

  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <StatusBar style="auto" />
        {/* Hold the first frame until the typefaces load so text never flashes
            the system font; `useAppFonts` resolves true on error too, so a
            font failure degrades instead of blocking. */}
        {fontsReady ? <RootNavigator /> : null}
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
