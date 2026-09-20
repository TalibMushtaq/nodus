// Signed-in navigation: five bottom tabs, each with its own stack.
//
// Matches the mobile information architecture (Files · Downloads · Devices ·
// Activity · Settings). Tab roots render their own themed header (title,
// subtitle, action icons); pushed detail screens use the native header so the
// platform back gesture keeps working.

import * as React from "react";
import { StyleSheet } from "react-native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Icon, useTheme, type IconName } from "../design";
import { ActivityScreen } from "../screens/ActivityScreen";
import { ConflictsScreen } from "../screens/ConflictsScreen";
import { DeviceDetailScreen } from "../screens/DeviceDetailScreen";
import { DevicesScreen } from "../screens/DevicesScreen";
import { DownloadsScreen } from "../screens/DownloadsScreen";
import { FileDetailScreen } from "../screens/FileDetailScreen";
import { FilesScreen } from "../screens/FilesScreen";
import { NodeDetailScreen } from "../screens/NodeDetailScreen";
import { PairingScreen } from "../screens/PairingScreen";
import { SecurityScreen } from "../screens/SecurityScreen";
import { SettingsScreen } from "../screens/SettingsScreen";
import { TrashScreen } from "../screens/TrashScreen";
import { useApp } from "../runtime/context";
import type { TabsParamList } from "./types";

const Tab = createBottomTabNavigator<TabsParamList>();
const Stack = createNativeStackNavigator();

const TAB_ICON: Record<keyof TabsParamList, IconName> = {
  FilesTab: "files",
  DownloadsTab: "download",
  DevicesTab: "devices",
  ActivityTab: "activity",
  SettingsTab: "settings",
};

const TAB_LABEL: Record<keyof TabsParamList, string> = {
  FilesTab: "Files",
  DownloadsTab: "Downloads",
  DevicesTab: "Devices",
  ActivityTab: "Activity",
  SettingsTab: "Settings",
};

/** Shared native-stack chrome for pushed detail screens. */
function useDetailChrome() {
  const theme = useTheme();
  return React.useMemo(
    () => ({
      headerStyle: { backgroundColor: theme.colors.card },
      headerShadowVisible: false,
      headerTintColor: theme.colors.foreground,
      headerTitleStyle: {
        fontFamily: theme.fonts.semibold,
        fontSize: theme.fontSize.md,
        color: theme.colors.foreground,
      },
    }),
    [theme],
  );
}

function FilesStack() {
  const chrome = useDetailChrome();
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="Files" component={FilesScreen} />
      <Stack.Screen name="Conflicts" component={ConflictsScreen} options={{ ...chrome, headerShown: true, title: "Conflicts" }} />
      <Stack.Screen name="FileDetail" component={FileDetailScreen} options={{ ...chrome, headerShown: true, title: "File" }} />
    </Stack.Navigator>
  );
}

function DownloadsStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="Downloads" component={DownloadsScreen} />
    </Stack.Navigator>
  );
}

function DevicesStack() {
  const chrome = useDetailChrome();
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="Devices" component={DevicesScreen} />
      <Stack.Screen name="Pairing" component={PairingScreen} options={{ ...chrome, headerShown: true, title: "Pair a node" }} />
      <Stack.Screen name="NodeDetail" component={NodeDetailScreen} options={{ ...chrome, headerShown: true, title: "Storage node" }} />
      <Stack.Screen name="DeviceDetail" component={DeviceDetailScreen} options={{ ...chrome, headerShown: true, title: "Device" }} />
    </Stack.Navigator>
  );
}

function ActivityStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="Activity" component={ActivityScreen} />
    </Stack.Navigator>
  );
}

function SettingsStack() {
  const chrome = useDetailChrome();
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="Settings" component={SettingsScreen} />
      <Stack.Screen name="Security" component={SecurityScreen} options={{ ...chrome, headerShown: true, title: "Security" }} />
      <Stack.Screen name="Trash" component={TrashScreen} options={{ ...chrome, headerShown: true, title: "Deleted files" }} />
    </Stack.Navigator>
  );
}

export function TabsNavigator() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  // Only one download runs at a time on mobile, so a boolean badge is enough;
  // it clears itself as soon as the download finishes.
  const app = useApp();

  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: theme.colors.accent,
        tabBarInactiveTintColor: theme.colors.mutedForeground,
        tabBarHideOnKeyboard: true,
        tabBarLabel: TAB_LABEL[route.name],
        tabBarLabelStyle: { fontFamily: theme.fonts.medium, fontSize: 10 },
        tabBarIcon: ({ focused, color }) => (
          <Icon name={TAB_ICON[route.name]} size={22} color={color} strokeWidth={focused ? 2 : 1.5} />
        ),
        tabBarStyle: {
          backgroundColor: theme.colors.card,
          borderTopColor: theme.colors.border,
          borderTopWidth: StyleSheet.hairlineWidth,
          height: 56 + insets.bottom,
          paddingTop: 6,
          paddingBottom: insets.bottom + 4,
        },
      })}
    >
      <Tab.Screen name="FilesTab" component={FilesStack} />
      <Tab.Screen
        name="DownloadsTab"
        component={DownloadsStack}
        options={{
          tabBarBadge: app.downloadProgress ? "•" : undefined,
          tabBarBadgeStyle: { backgroundColor: theme.colors.accent, fontSize: 8, minWidth: 14, height: 14, lineHeight: 14 },
        }}
      />
      <Tab.Screen name="DevicesTab" component={DevicesStack} />
      <Tab.Screen name="ActivityTab" component={ActivityStack} />
      <Tab.Screen name="SettingsTab" component={SettingsStack} />
    </Tab.Navigator>
  );
}
