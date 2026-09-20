import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";

import { DownloadProvider, useDownload } from "../download-provider";

function wrapper({ children }: { children: ReactNode }) {
  return <DownloadProvider>{children}</DownloadProvider>;
}

describe("DownloadProvider retry", () => {
  it("re-runs the registered runner with a fresh, un-aborted signal", () => {
    const { result } = renderHook(() => useDownload(), { wrapper });

    let firstSignal: AbortSignal | undefined;
    let retrySignal: AbortSignal | undefined;
    let runs = 0;
    let taskId = "";

    act(() => {
      const started = result.current.startDownload({ name: "report.pdf" });
      taskId = started.id;
      firstSignal = started.signal;
      result.current.registerDownloadRetry(taskId, (signal) => {
        runs += 1;
        retrySignal = signal;
      });
      // Cancel (aborts the first signal), then retry (should mint a new one).
      result.current.cancelDownload(taskId);
      result.current.retryDownload(taskId);
    });

    expect(runs).toBe(1);
    expect(firstSignal?.aborted).toBe(true);
    expect(retrySignal).toBeDefined();
    expect(retrySignal?.aborted).toBe(false);
    // The task is reset to active for the new attempt.
    expect(result.current.tasks.find((task) => task.id === taskId)?.status).toBe("active");
  });

  it("does nothing when no runner was registered for the task", () => {
    const { result } = renderHook(() => useDownload(), { wrapper });
    act(() => {
      const { id } = result.current.startDownload({ name: "orphan.bin" });
      // No registerDownloadRetry call: retry must be a safe no-op.
      result.current.retryDownload(id);
    });
    expect(result.current.tasks[0]?.status).toBe("active");
  });
});
