import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30000,
    pool: "forks",
    maxWorkers: 1,
    isolate: false,
  },
});