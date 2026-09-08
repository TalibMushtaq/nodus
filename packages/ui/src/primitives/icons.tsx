import type { ReactNode } from "react";

// Central icon set for Nodus. Every SVG glyph the app draws lives here so the
// visual language stays consistent and editable in one place.

export type IconName =
  | "overview"
  | "files"
  | "devices"
  | "activity"
  | "security"
  | "settings"
  | "search"
  | "plus"
  | "bell"
  | "sun"
  | "moon"
  | "logo"
  | "chevron-left"
  | "chevron-down"
  | "refresh"
  | "folder"
  | "list-view"
  | "grid-view"
  | "close"
  | "server"
  | "phone"
  | "download"
  | "info"
  | "warning"
  | "check"
  | "trash"
  | "lock"
  | "upload"
  | "more"
  | "copy";

const icons: Record<IconName, { viewBox: string; node: ReactNode }> = {
  overview: {
    viewBox: "0 0 16 16",
    node: (
      <>
        <rect x="1.5" y="1.5" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
        <rect x="9.5" y="1.5" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
        <rect x="1.5" y="9.5" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
        <rect x="9.5" y="9.5" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
      </>
    ),
  },
  files: {
    viewBox: "0 0 16 16",
    node: (
      <>
        <path d="M3 2.5h5.5L11 5v8.5H3V2.5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        <path d="M8.5 2.5V5H11" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        <path d="M5 8h5M5 10.5h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </>
    ),
  },
  devices: {
    viewBox: "0 0 16 16",
    node: (
      <>
        <rect x="2" y="3.5" width="7" height="9" rx="1" stroke="currentColor" strokeWidth="1.3" />
        <path d="M5.5 10.5h0" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        <path d="M12 6h1.5v5.5H12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        <path d="M5 3.5V2M4 2h2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </>
    ),
  },
  activity: {
    viewBox: "0 0 16 16",
    node: (
      <path
        d="M1 8h2.5l2-5 2.5 10 2-5H14"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  },
  security: {
    viewBox: "0 0 16 16",
    node: (
      <>
        <path
          d="M8 1.5L2 4v4c0 3.5 2.5 5.5 6 6.5 3.5-1 6-3 6-6.5V4L8 1.5z"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
        <path d="M5.5 8l1.5 1.5 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
  },
  settings: {
    viewBox: "0 0 16 16",
    node: (
      <>
        <circle cx="8" cy="8" r="2.5" stroke="currentColor" strokeWidth="1.3" />
        <path
          d="M8 1v2M8 13v2M1 8h2M13 8h2M2.93 2.93l1.42 1.42M11.65 11.65l1.42 1.42M2.93 13.07l1.42-1.42M11.65 4.35l1.42-1.42"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      </>
    ),
  },
  search: {
    viewBox: "0 0 13 13",
    node: (
      <>
        <circle cx="5.5" cy="5.5" r="4" stroke="currentColor" strokeWidth="1.3" />
        <path d="M9 9L11.5 11.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </>
    ),
  },
  plus: {
    viewBox: "0 0 12 12",
    node: <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />,
  },
  bell: {
    viewBox: "0 0 16 16",
    node: (
      <>
        <path d="M8 1.5C5.5 1.5 3.5 3.5 3.5 6v3L2 11h12l-1.5-2V6C12.5 3.5 10.5 1.5 8 1.5z" stroke="currentColor" strokeWidth="1.3" />
        <path d="M6.5 13a1.5 1.5 0 003 0" stroke="currentColor" strokeWidth="1.3" />
      </>
    ),
  },
  sun: {
    viewBox: "0 0 16 16",
    node: (
      <>
        <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.3" />
        <path
          d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M2.93 2.93l1.06 1.06M12.01 12.01l1.06 1.06M2.93 13.07l1.06-1.06M12.01 3.99l1.06-1.06"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      </>
    ),
  },
  moon: {
    viewBox: "0 0 16 16",
    node: (
      <path
        d="M13.5 9A6 6 0 017 2.5a6 6 0 106.5 6.5z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    ),
  },
  logo: {
    viewBox: "0 0 20 20",
    node: (
      <>
        <circle cx="10" cy="4" r="2.5" fill="currentColor" />
        <circle cx="3" cy="15" r="2.5" fill="currentColor" />
        <circle cx="17" cy="15" r="2.5" fill="currentColor" />
        <path d="M10 6.5L3 12.5M10 6.5L17 12.5M3 12.5L17 12.5" stroke="currentColor" strokeWidth="1.2" opacity="0.5" />
      </>
    ),
  },
  "chevron-left": {
    viewBox: "0 0 14 14",
    node: <path d="M9 2L4 7l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />,
  },
  "chevron-down": {
    viewBox: "0 0 10 10",
    node: <path d="M2 3.5l3 3 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />,
  },
  refresh: {
    viewBox: "0 0 12 12",
    node: (
      <>
        <path d="M10 6A4 4 0 112 6a4 4 0 018 0z" stroke="currentColor" strokeWidth="1.3" />
        <path d="M6 4v2l1.5 1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </>
    ),
  },
  folder: {
    viewBox: "0 0 16 16",
    node: (
      <path d="M1.5 4.5h4l1.5-2h7.5v9h-13V4.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    ),
  },
  "list-view": {
    viewBox: "0 0 13 13",
    node: <path d="M1 2h11M1 6.5h11M1 11h11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />,
  },
  "grid-view": {
    viewBox: "0 0 13 13",
    node: (
      <>
        <rect x="1" y="1" width="4.5" height="4.5" rx="0.5" stroke="currentColor" strokeWidth="1.3" />
        <rect x="7.5" y="1" width="4.5" height="4.5" rx="0.5" stroke="currentColor" strokeWidth="1.3" />
        <rect x="1" y="7.5" width="4.5" height="4.5" rx="0.5" stroke="currentColor" strokeWidth="1.3" />
        <rect x="7.5" y="7.5" width="4.5" height="4.5" rx="0.5" stroke="currentColor" strokeWidth="1.3" />
      </>
    ),
  },
  close: {
    viewBox: "0 0 14 14",
    node: <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />,
  },
  server: {
    viewBox: "0 0 18 18",
    node: (
      <>
        <rect x="2" y="2" width="14" height="14" rx="1" stroke="currentColor" strokeWidth="1.3" />
        <path d="M5 6h8M5 9h8M5 12h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      </>
    ),
  },
  phone: {
    viewBox: "0 0 18 18",
    node: (
      <>
        <rect x="5" y="1.5" width="8" height="15" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
        <path d="M7.5 4h3M9 14h0" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </>
    ),
  },
  download: {
    viewBox: "0 0 12 12",
    node: (
      <path
        d="M2 8.5v2h8v-2M6 1v7M3.5 6l2.5 2.5L8.5 6"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  },
  info: {
    viewBox: "0 0 12 12",
    node: (
      <>
        <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1" />
        <path d="M6 5v3M6 4v0" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
      </>
    ),
  },
  warning: {
    viewBox: "0 0 14 14",
    node: (
      <>
        <path d="M7 1.5L13 12.5H1L7 1.5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        <path d="M7 5.5v3M7 10v0" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </>
    ),
  },
  check: {
    viewBox: "0 0 10 10",
    node: <path d="M2 5l2.5 2.5L8 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />,
  },
  trash: {
    viewBox: "0 0 14 14",
    node: (
      <path
        d="M2 4h10M5.5 1.5h3M5 4v7M9 4v7"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  },
  lock: {
    viewBox: "0 0 14 14",
    node: (
      <>
        <rect x="2.5" y="6" width="9" height="6.5" rx="1" stroke="currentColor" strokeWidth="1.3" />
        <path d="M4.5 6V4.5a2.5 2.5 0 015 0V6" stroke="currentColor" strokeWidth="1.3" />
      </>
    ),
  },
  upload: {
    viewBox: "0 0 12 12",
    node: (
      <path
        d="M6 7V1M3.5 3.5L6 1l2.5 2.5M2 8.5v2h8v-2"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  },
  more: {
    viewBox: "0 0 4 12",
    node: <path d="M2 1v0M2 6v0M2 11v0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />,
  },
  copy: {
    viewBox: "0 0 14 14",
    node: (
      <>
        <rect x="4" y="4" width="8.5" height="8.5" rx="1" stroke="currentColor" strokeWidth="1.3" />
        <path d="M10 4V2.5A1.5 1.5 0 008.5 1h-6A1.5 1.5 0 001 2.5v6A1.5 1.5 0 002.5 10H4" stroke="currentColor" strokeWidth="1.3" />
      </>
    ),
  },
};

interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
}

export function Icon({ name, size = 16, className }: IconProps) {
  const { viewBox, node } = icons[name];
  return (
    <svg width={size} height={size} viewBox={viewBox} fill="none" className={className} aria-hidden>
      {node}
    </svg>
  );
}