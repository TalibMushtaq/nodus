import { describe, expect, it } from "vitest";
import { parseUserAgent } from "../device-info";
import { describeDeviceInfo } from "@repo/sdk";

describe("parseUserAgent", () => {
  it("detects Chrome on Linux", () => {
    const info = parseUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    );
    expect(info.platform).toBe("linux");
    expect(info.browser).toBe("Chrome 126");
    expect(info.os_version).toBeUndefined();
  });

  it("detects Safari on macOS with the OS version", () => {
    const info = parseUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
      "macOS",
    );
    expect(info.platform).toBe("macos");
    expect(info.browser).toBe("Safari 17");
    expect(info.os_version).toBe("10.15.7");
  });

  it("detects Android and prefers the platform hint when the agent is generic", () => {
    const android = parseUserAgent(
      "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
    );
    expect(android.platform).toBe("android");
    expect(android.os_version).toBe("13");

    const generic = parseUserAgent("SomeClient/1.0", "Windows");
    expect(generic.platform).toBe("windows");
  });

  it("maps a Windows NT version to its marketing name", () => {
    const info = parseUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    );
    expect(info.platform).toBe("windows");
    expect(info.os_version).toBe("10/11");
  });
});

describe("describeDeviceInfo", () => {
  it("joins platform, OS version, and client", () => {
    expect(describeDeviceInfo({ platform: "ios", os_version: "17.5", app_version: "1.4" })).toBe(
      "iOS 17.5 · Nodus 1.4",
    );
    expect(describeDeviceInfo({ platform: "linux", browser: "Chrome 126" })).toBe("Linux · Chrome 126");
  });

  it("returns null when nothing was reported", () => {
    expect(describeDeviceInfo(null)).toBeNull();
    expect(describeDeviceInfo({})).toBeNull();
  });
});
