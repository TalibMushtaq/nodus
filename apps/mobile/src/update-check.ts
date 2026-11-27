// In-app update check for sideloaded Android builds.
//
// Nodus ships as a GitHub release asset, not through the Play Store, so Android
// has no store-managed update channel. On launch we ask the public releases API
// for the newest published `mobile-v*` release, compare it with the running
// version, and hand the caller a direct APK URL. The check is best-effort:
// offline devices, rate limits, or a malformed response all resolve to "no
// update" so startup is never blocked or interrupted by an error dialog.

import Constants from "expo-constants";

const REPO = "TalibMushtaq/nodus";
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases?per_page=30`;
const TAG_PREFIX = "mobile-v";

export interface AvailableUpdate {
  /** Version without the `mobile-v` prefix, e.g. `1.0.1`. */
  version: string;
  /** Direct download for the APK asset. */
  downloadUrl: string;
  /** Human-facing release page. */
  releaseUrl: string;
}

/** Numeric semver comparison; positive when `a` is newer than `b`. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Version baked into the installed binary from app.json. */
export function currentVersion(): string {
  return Constants.expoConfig?.version ?? "0.0.0";
}

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface Release {
  tag_name: string;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
  assets: ReleaseAsset[];
}

export async function checkForUpdate(
  current: string = currentVersion(),
): Promise<AvailableUpdate | null> {
  const response = await fetch(RELEASES_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      // GitHub rejects some default mobile agents; identify the client.
      "User-Agent": "Nodus-Mobile",
    },
  });
  if (!response.ok) return null;

  const releases = (await response.json()) as Release[];
  const mobileReleases = releases
    .filter(
      (release) =>
        !release.draft &&
        !release.prerelease &&
        release.tag_name.startsWith(TAG_PREFIX),
    )
    .sort((a, b) =>
      compareVersions(
        b.tag_name.slice(TAG_PREFIX.length),
        a.tag_name.slice(TAG_PREFIX.length),
      ),
    );

  const latest = mobileReleases[0];
  if (!latest) return null;

  const version = latest.tag_name.slice(TAG_PREFIX.length);
  if (compareVersions(version, current) <= 0) return null;

  const apk = latest.assets.find((asset) => asset.name.endsWith(".apk"));
  if (!apk) return null;

  return {
    version,
    downloadUrl: apk.browser_download_url,
    releaseUrl: latest.html_url,
  };
}
