// Central icon set for the mobile app.
//
// The prototype uses bespoke line glyphs (tabs, status, transfer paths) rather
// than a stock icon font, so we draw them with `react-native-svg` and keep them
// in one switch. `strokeWidth` is a prop because the tab bar thickens the
// active tab's icon, mirroring `MobileShell.tsx`.

import * as React from "react";
import Svg, { Circle, Path, Rect } from "react-native-svg";

import type { TransferPath } from "@repo/transfer-manager";

export type IconName =
  // Bottom-tab glyphs
  | "files"
  | "devices"
  | "activity"
  | "settings"
  // Header / actions
  | "search"
  | "filter"
  | "listView"
  | "gridView"
  | "plus"
  | "chevronLeft"
  | "chevronRight"
  | "chevronDown"
  | "close"
  | "check"
  | "more"
  | "refresh"
  | "shield"
  | "alert"
  | "trash"
  | "folder"
  | "file"
  | "image"
  | "server"
  | "phone"
  | "lock"
  | "key"
  | "download"
  | "upload"
  | "share"
  | "move"
  | "edit"
  | "link"
  | "eye"
  | "eyeOff"
  | "copy"
  | "wifi"
  | "wifiOff"
  | "clock"
  | "logout"
  | "sun"
  | "moon"
  | "monitor"
  | "user"
  | "database"
  | "hardDrive"
  // Status language (sync/connection state)
  | "statusSynced"
  | "statusPending"
  | "statusConflict"
  | "statusOffline"
  | "statusLocal"
  // Transfer-path language
  | "pathLocal"
  | "pathRelay"
  | "pathBuffered"
  | "pathOffline";

export interface IconProps {
  name: IconName;
  /** Rendered size in px (square). */
  size?: number;
  /** Stroke (or fill, for solid glyphs) color. */
  color: string;
  /** Stroke thickness; the active tab bar passes a heavier value. */
  strokeWidth?: number;
}

/** Map a transfer path to its glyph, used by `PathIndicator`. */
export function pathIconName(path: TransferPath): IconName {
  switch (path) {
    case "local_signaling":
      return "pathLocal";
    case "relay_signaling":
      return "pathRelay";
    case "buffer_relay":
      return "pathBuffered";
    default:
      return "pathOffline";
  }
}

function glyph(name: IconName, color: string, sw: number): React.ReactNode {
  const stroke = { stroke: color, strokeWidth: sw, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (name) {
    // ── Tabs ────────────────────────────────────────────────────────────────
    case "files":
      return (
        <>
          <Path d="M6 3h8l4 4v14H6z" {...stroke} />
          <Path d="M14 3v4h4" {...stroke} />
        </>
      );
    case "devices":
      return (
        <>
          <Rect x="3" y="5" width="11" height="13" rx="1" {...stroke} />
          <Path d="M17 8h4v10h-4" {...stroke} />
        </>
      );
    case "activity":
      return <Path d="M2 12h4l2-6 4 12 2-6h8" {...stroke} />;
    case "settings":
      return (
        <>
          <Circle cx="12" cy="12" r="3.2" {...stroke} />
          <Path
            d="M12 2v2.6M12 19.4V22M2 12h2.6M19.4 12H22M5 5l1.8 1.8M17.2 17.2 19 19M5 19l1.8-1.8M17.2 6.8 19 5"
            {...stroke}
          />
        </>
      );

    // ── Actions ─────────────────────────────────────────────────────────────
    case "search":
      return (
        <>
          <Circle cx="10.5" cy="10.5" r="6.5" {...stroke} />
          <Path d="M15.5 15.5 21 21" {...stroke} />
        </>
      );
    case "filter":
      return <Path d="M4 6h16M7 12h10M10 18h4" {...stroke} />;
    case "listView":
      return <Path d="M4 6h16M4 12h16M4 18h16" {...stroke} />;
    case "gridView":
      return (
        <>
          <Rect x="4" y="4" width="7" height="7" rx="1" {...stroke} />
          <Rect x="13" y="4" width="7" height="7" rx="1" {...stroke} />
          <Rect x="4" y="13" width="7" height="7" rx="1" {...stroke} />
          <Rect x="13" y="13" width="7" height="7" rx="1" {...stroke} />
        </>
      );
    case "plus":
      return <Path d="M12 5v14M5 12h14" {...stroke} />;
    case "chevronLeft":
      return <Path d="M15 5 8 12l7 7" {...stroke} />;
    case "chevronRight":
      return <Path d="M9 5l7 7-7 7" {...stroke} />;
    case "chevronDown":
      return <Path d="M6 9l6 6 6-6" {...stroke} />;
    case "close":
      return <Path d="M6 6l12 12M18 6 6 18" {...stroke} />;
    case "check":
      return <Path d="M5 12.5 10 17l9-10" {...stroke} />;
    case "more":
      return (
        <>
          <Circle cx="5" cy="12" r="1.6" fill={color} />
          <Circle cx="12" cy="12" r="1.6" fill={color} />
          <Circle cx="19" cy="12" r="1.6" fill={color} />
        </>
      );
    case "refresh":
      return (
        <>
          <Path d="M20 12a8 8 0 1 1-2.3-5.6" {...stroke} />
          <Path d="M20 4v5h-5" {...stroke} />
        </>
      );
    case "shield":
      return <Path d="M12 3l7 3v6c0 4.2-3 7.4-7 9-4-1.6-7-4.8-7-9V6z" {...stroke} />;
    case "alert":
      return (
        <>
          <Path d="M12 4 21 20H3z" {...stroke} />
          <Path d="M12 10v4.5M12 17.2v.1" {...stroke} />
        </>
      );
    case "trash":
      return (
        <>
          <Path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" {...stroke} />
        </>
      );
    case "folder":
      return <Path d="M3 6h6l2 2h10v12H3z" {...stroke} />;
    case "file":
      return (
        <>
          <Path d="M6 3h8l4 4v14H6z" {...stroke} />
          <Path d="M14 3v4h4" {...stroke} />
        </>
      );
    case "image":
      return (
        <>
          <Rect x="3" y="4.5" width="18" height="15" rx="2" {...stroke} />
          <Circle cx="8.5" cy="9.5" r="1.5" fill={color} />
          <Path d="M4.5 17.5l4.5-4 3.5 3 3-2.5 4 3.5" {...stroke} />
        </>
      );
    case "server":
      return (
        <>
          <Rect x="3" y="4" width="18" height="7" rx="1" {...stroke} />
          <Rect x="3" y="13" width="18" height="7" rx="1" {...stroke} />
          <Path d="M7 7.5h.1M7 16.5h.1" {...stroke} />
        </>
      );
    case "phone":
      return (
        <>
          <Rect x="7" y="2.5" width="10" height="19" rx="2" {...stroke} />
          <Path d="M10.5 5.5h3M12 18.5h.1" {...stroke} />
        </>
      );
    case "lock":
      return (
        <>
          <Rect x="5" y="10.5" width="14" height="10" rx="1.5" {...stroke} />
          <Path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" {...stroke} />
        </>
      );
    case "key":
      return (
        <>
          <Circle cx="8" cy="8" r="4" {...stroke} />
          <Path d="M11 11l8 8M16 16l2-2M18.5 18.5l2-2" {...stroke} />
        </>
      );
    case "download":
      return <Path d="M12 4v10M8 10.5l4 4 4-4M5 20h14" {...stroke} />;
    case "upload":
      return <Path d="M12 20V10M8 13.5l4-4 4 4M5 4h14" {...stroke} />;
    case "share":
      return (
        <>
          <Circle cx="6" cy="12" r="2.5" {...stroke} />
          <Circle cx="18" cy="6" r="2.5" {...stroke} />
          <Circle cx="18" cy="18" r="2.5" {...stroke} />
          <Path d="M8.2 10.8 15.8 7.2M8.2 13.2l7.6 3.6" {...stroke} />
        </>
      );
    case "move":
      return (
        <>
          <Path d="M12 3v18M3 12h18" {...stroke} />
          <Path d="M12 3 9 6M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3" {...stroke} />
        </>
      );
    case "edit":
      return (
        <>
          <Path d="M4 20h4L20 8l-4-4L4 16z" {...stroke} />
          <Path d="M14 6l4 4" {...stroke} />
        </>
      );
    case "link":
      return (
        <>
          <Path d="M10 14a4 4 0 0 1 0-5.7l2.3-2.3a4 4 0 0 1 5.7 5.7L16.6 13" {...stroke} />
          <Path d="M14 10a4 4 0 0 1 0 5.7l-2.3 2.3a4 4 0 0 1-5.7-5.7L7.4 11" {...stroke} />
        </>
      );
    case "eye":
      return (
        <>
          <Path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" {...stroke} />
          <Circle cx="12" cy="12" r="3" {...stroke} />
        </>
      );
    case "eyeOff":
      return (
        <>
          <Path d="M4 4l16 16" {...stroke} />
          <Path d="M9.5 5.9A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a15 15 0 0 1-3.4 4.1M6.3 7.8A15 15 0 0 0 2.5 12S6 18.5 12 18.5c1 0 1.9-.2 2.7-.5" {...stroke} />
        </>
      );
    case "copy":
      return (
        <>
          <Rect x="9" y="9" width="11" height="11" rx="1.5" {...stroke} />
          <Path d="M15 9V6.5A1.5 1.5 0 0 0 13.5 5h-9A1.5 1.5 0 0 0 3 6.5v9A1.5 1.5 0 0 0 4.5 17H7" {...stroke} />
        </>
      );
    case "wifi":
      return (
        <>
          <Path d="M3 9.5a13 13 0 0 1 18 0M6 13a8.5 8.5 0 0 1 12 0M9 16.5a4 4 0 0 1 6 0" {...stroke} />
          <Path d="M12 20h.1" {...stroke} />
        </>
      );
    case "wifiOff":
      return (
        <>
          <Path d="M4 4l16 16" {...stroke} />
          <Path d="M3 9.5a13 13 0 0 1 5-3M13.5 6.6A13 13 0 0 1 21 9.5M9 16.5a4 4 0 0 1 6 0M12 20h.1" {...stroke} />
        </>
      );
    case "clock":
      return (
        <>
          <Circle cx="12" cy="12" r="8.5" {...stroke} />
          <Path d="M12 7v5.2l3.4 2" {...stroke} />
        </>
      );
    case "logout":
      return (
        <>
          <Path d="M14 4h4.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H14" {...stroke} />
          <Path d="M10 8l-4 4 4 4M6 12h9" {...stroke} />
        </>
      );
    case "sun":
      return (
        <>
          <Circle cx="12" cy="12" r="4" {...stroke} />
          <Path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M5 5l1.8 1.8M17.2 17.2 19 19M5 19l1.8-1.8M17.2 6.8 19 5" {...stroke} />
        </>
      );
    case "moon":
      return <Path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" {...stroke} />;
    case "monitor":
      return (
        <>
          <Rect x="3" y="4" width="18" height="12.5" rx="1.5" {...stroke} />
          <Path d="M9 20h6M12 16.5V20" {...stroke} />
        </>
      );
    case "user":
      return (
        <>
          <Circle cx="12" cy="8" r="4" {...stroke} />
          <Path d="M4.5 20a7.5 7.5 0 0 1 15 0" {...stroke} />
        </>
      );
    case "database":
      return (
        <>
          <Path d="M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z" {...stroke} />
          <Path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" {...stroke} />
        </>
      );
    case "hardDrive":
      return (
        <>
          <Rect x="3" y="13" width="18" height="6" rx="1.5" {...stroke} />
          <Path d="M5.5 13 8 6h8l2.5 7M7 16h.1M10 16h.1" {...stroke} />
        </>
      );

    // ── Status (solid where the design uses solid) ──────────────────────────
    case "statusSynced":
      return <Circle cx="12" cy="12" r="5" fill={color} />;
    case "statusPending":
      return (
        <>
          <Circle cx="12" cy="12" r="5.5" {...stroke} />
          <Circle cx="12" cy="12" r="2" fill={color} />
        </>
      );
    case "statusConflict":
      return (
        <>
          <Path d="M12 3l9 9-9 9-9-9z" {...stroke} />
          <Path d="M12 8v5M12 15.8v.1" {...stroke} />
        </>
      );
    case "statusOffline":
      return <Circle cx="12" cy="12" r="5.5" stroke={color} strokeWidth={sw} strokeDasharray="2.5 2" />;
    case "statusLocal":
      return <Path d="M12 3l9 9-9 9-9-9z" fill={color} />;

    // ── Transfer paths ──────────────────────────────────────────────────────
    case "pathLocal":
      return <Path d="M3 12h18M3 12l4-4M3 12l4 4M21 12l-4-4M21 12l-4 4" {...stroke} />;
    case "pathRelay":
      return (
        <>
          <Path d="M12 3s6 4.2 6 9a6 6 0 0 1-12 0c0-4.8 6-9 6-9z" {...stroke} />
          <Circle cx="12" cy="12" r="2" fill={color} />
        </>
      );
    case "pathBuffered":
      return <Path d="M4 8h16M4 12h12M4 16h8" {...stroke} />;
    case "pathOffline":
      return <Path d="M5 5l14 14M19 5 5 19" {...stroke} />;
  }
}

export function Icon({ name, size = 20, color, strokeWidth = 1.7 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {glyph(name, color, strokeWidth)}
    </Svg>
  );
}
