import { afterEach, describe, expect, it, vi } from "vitest";

import { downloadMetrics } from "../metrics";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("downloadMetrics", () => {
  it("reports zero speed and no ETA before any bytes land", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    expect(downloadMetrics({ startedAt: 1_000, completedBytes: 0, totalBytes: 1_000 })).toEqual({
      speedBps: 0,
      etaSeconds: null,
    });
  });

  it("averages throughput over elapsed time and estimates the remaining time", () => {
    // 500 bytes in 10s => 50 B/s; 500 left => 10s ETA.
    vi.spyOn(Date, "now").mockReturnValue(10_000);
    const metrics = downloadMetrics({ startedAt: 0, completedBytes: 500, totalBytes: 1_000 });
    expect(metrics.speedBps).toBeCloseTo(50, 5);
    expect(metrics.etaSeconds).toBeCloseTo(10, 5);
  });

  it("has no ETA once the transfer is complete", () => {
    vi.spyOn(Date, "now").mockReturnValue(10_000);
    const metrics = downloadMetrics({ startedAt: 0, completedBytes: 1_000, totalBytes: 1_000 });
    expect(metrics.speedBps).toBeCloseTo(100, 5);
    expect(metrics.etaSeconds).toBeNull();
  });
});
