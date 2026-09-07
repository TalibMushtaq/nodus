import { runTimingBenchmarks } from "./timing.js";

/** Structured benchmark result for the manual real-network runs. */
export interface BenchmarkReport {
  timestamp: string;
  networkCondition: string;
  rounds: Array<{ path: "A" | "B"; success: boolean; durationMs: number; note?: string }>;
}

/**
 * Serialize a report to a single JSON line, plus append a human-readable
 * table row for docs/architecture/webrtc-benchmark-results.md.
 */
export function emitReport(report: BenchmarkReport): void {
  console.log("REPORT_START");
  console.log(JSON.stringify(report, null, 2));
  console.log("REPORT_END");

  const ok = report.rounds.filter((r) => r.success).length;
  console.log(
    `summary: ${report.networkCondition} — ${ok}/${report.rounds.length} negotiations succeeded`,
  );
}

const results = runTimingBenchmarks();
let allPass = true;
for (const r of results) {
  const marker = r.pass ? "PASS" : "FAIL";
  if (!r.pass) allPass = false;
  console.log(
    `[${marker}] ${r.scenario}: measured=${r.measuredMs}ms expected=${r.expectedMs}ms`,
  );
}
process.exit(allPass ? 0 : 1);