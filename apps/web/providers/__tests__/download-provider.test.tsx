import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";

import { DownloadProvider, useDownload, useDownloadActions } from "../download-provider";

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

  it("keeps the actions object stable across task updates (Files must not re-render)", () => {
    const { result } = renderHook(
      () => ({ actions: useDownloadActions(), tasks: useDownload().tasks }),
      { wrapper },
    );
    const firstActions = result.current.actions;

    act(() => {
      const { id } = result.current.actions.startDownload({ name: "big.iso" });
      // A progress tick must not change the actions identity, or action-only
      // consumers would re-render on every network chunk.
      result.current.actions.reportProgress(id, {
        phase: "fetching",
        completedShards: 0,
        totalShards: 4,
        completedBytes: 1,
        totalBytes: 4,
      });
    });

    expect(result.current.actions).toBe(firstActions);
    expect(result.current.tasks).toHaveLength(1);
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

  it("ignores progress that arrives after a task finishes", async () => {
    const { result } = renderHook(() => useDownload(), { wrapper });

    let taskId = "";
    act(() => {
      taskId = result.current.startDownload({ name: "late.bin" }).id;
      result.current.finishDownload(taskId, "done");
    });
    expect(result.current.tasks[0]?.status).toBe("done");

    act(() => {
      // A transport can report once more after completion; it must not flip the
      // terminal task back to active.
      result.current.reportProgress(taskId, {
        phase: "fetching",
        completedShards: 1,
        totalShards: 4,
        completedBytes: 10,
        totalBytes: 40,
      });
    });
    // Let any queued animation frame flush before asserting.
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });

    expect(result.current.tasks[0]?.status).toBe("done");
  });
});
