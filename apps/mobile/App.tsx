import "./src/compat";

// Nodus mobile app shell.
//
// The state and networking live in `useNodusApp` (see src/runtime/useNodusApp.ts)
// and are provided to every screen through `AppContext`. This file only decides
// which screens exist: signed-out users get the auth flow, signed-in users get
// the pairing hub plus the feature screens. Planned behavior is unchanged from
// the original single-screen console — the screens are thin view layers.

import * as React from "react";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { AppContext } from "./src/runtime/context";
import { useNodusApp } from "./src/runtime/useNodusApp";
import { AuthScreen } from "./src/screens/AuthScreen";
import { ConflictsScreen } from "./src/screens/ConflictsScreen";
import { DevicesScreen } from "./src/screens/DevicesScreen";
import { FilesScreen } from "./src/screens/FilesScreen";
import { HomeScreen } from "./src/screens/HomeScreen";
import { SecurityScreen } from "./src/screens/SecurityScreen";
import { SettingsScreen } from "./src/screens/SettingsScreen";

const Stack = createNativeStackNavigator();

export default function App() {
  const app = useNodusApp();

  return (
    <SafeAreaProvider>
      <AppContext.Provider value={app}>
        <NavigationContainer>
          <Stack.Navigator>
            {app.authed ? (
              <>
                <Stack.Screen name="Home" component={HomeScreen} />
                <Stack.Screen name="Files" component={FilesScreen} />
                <Stack.Screen name="Devices" component={DevicesScreen} />
                <Stack.Screen name="Conflicts" component={ConflictsScreen} />
                <Stack.Screen name="Security" component={SecurityScreen} />
                <Stack.Screen name="Settings" component={SettingsScreen} />
              </>
            ) : (
              <Stack.Screen name="Sign in" component={AuthScreen} />
            )}
          </Stack.Navigator>
        </NavigationContainer>
      </AppContext.Provider>
    </SafeAreaProvider>
  );
}
