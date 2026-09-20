// Navigation param lists for the mobile app.
//
// Five bottom tabs, each owning a stack so detail screens (file, node, device,
// pairing, conflicts, security, trash) push within their section. Params carry
// ids only — detail screens look the entity up from the live app state.
import type { NavigatorScreenParams } from "@react-navigation/native";

export type FilesStackParamList = {
  Files: undefined;
  Conflicts: undefined;
  FileDetail: { fileId: string };
};

export type DownloadsStackParamList = {
  Downloads: undefined;
};

export type DevicesStackParamList = {
  Devices: undefined;
  Pairing: undefined;
  NodeDetail: { nodeId: string };
  DeviceDetail: { deviceId: string };
};

export type ActivityStackParamList = {
  Activity: undefined;
};

export type SettingsStackParamList = {
  Settings: undefined;
  Security: undefined;
  Trash: undefined;
};

export type TabsParamList = {
  FilesTab: NavigatorScreenParams<FilesStackParamList>;
  DownloadsTab: NavigatorScreenParams<DownloadsStackParamList>;
  DevicesTab: NavigatorScreenParams<DevicesStackParamList>;
  ActivityTab: NavigatorScreenParams<ActivityStackParamList>;
  SettingsTab: NavigatorScreenParams<SettingsStackParamList>;
};

export type RootStackParamList = {
  Tabs: NavigatorScreenParams<TabsParamList>;
  SignIn: undefined;
};
