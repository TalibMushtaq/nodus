import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_PREFERENCES,
  loadPreferences,
  normalizePreferences,
  savePreferences,
  type SyncPreferences,
} from "../preferences";

// The view prefs were added after the original record shape, so the migration
// path (a stored record missing `filesView`/`filesIconSize`) matters more here
// than the happy path — a bad fallback would leave the Files section with
// neither list nor grid active.
describe("normalizePreferences", () => {
  it("fills missing view fields with defaults", () => {
    const legacy = { autoSync: false, maxNodes: 3 } as Partial<SyncPreferences>;
    const normalized = normalizePreferences(legacy);
    expect(normalized.filesView).toBe(DEFAULT_PREFERENCES.filesView);
    expect(normalized.filesIconSize).toBe(DEFAULT_PREFERENCES.filesIconSize);
  });

  it("keeps valid stored view fields", () => {
    const normalized = normalizePreferences({
      autoSync: true,
      maxNodes: 5,
      filesView: "grid",
      filesIconSize: "lg",
    });
    expect(normalized.filesView).toBe("grid");
    expect(normalized.filesIconSize).toBe("lg");
  });

  it("rejects unknown view values instead of trusting them", () => {
    const normalized = normalizePreferences({
      autoSync: true,
      maxNodes: 5,
      // Simulates a hand-edited/corrupt localStorage entry.
      filesView: "carousel" as never,
      filesIconSize: "xl" as never,
    });
    expect(normalized.filesView).toBe(DEFAULT_PREFERENCES.filesView);
    expect(normalized.filesIconSize).toBe(DEFAULT_PREFERENCES.filesIconSize);
  });
});

describe("loadPreferences/savePreferences", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("defaults when nothing is stored", () => {
    expect(loadPreferences()).toEqual(DEFAULT_PREFERENCES);
  });

  it("round-trips the files view preferences", () => {
    const saved: SyncPreferences = {
      ...DEFAULT_PREFERENCES,
      filesView: "grid",
      filesIconSize: "sm",
    };
    savePreferences(saved);
    expect(loadPreferences()).toEqual(saved);
  });

  it("upgrades a legacy record missing the view fields", () => {
    window.localStorage.setItem(
      "nodus.preferences",
      JSON.stringify({ autoSync: true, maxNodes: 5, shardSizeBytes: 8 * 1024 * 1024 }),
    );
    const loaded = loadPreferences();
    expect(loaded.filesView).toBe(DEFAULT_PREFERENCES.filesView);
    expect(loaded.filesIconSize).toBe(DEFAULT_PREFERENCES.filesIconSize);
  });
});
