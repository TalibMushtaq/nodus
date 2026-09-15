import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    environmentOptions: {
      jsdom: {
        url: "http://localhost/",
      },
    },
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["**/*.test.{ts,tsx}"],
    css: false,
  },
  resolve: {
    alias: [
      {
        find: /^@repo\/relay-client$/,
        replacement: resolve(import.meta.dirname, "../../packages/relay-client/src/index.ts"),
      },
      // Exact match: the workspace package's dist/ build is not guaranteed in
      // the test run, so tests resolve the SDK's TypeScript source directly.
      {
        find: /^@repo\/sdk$/,
        replacement: resolve(import.meta.dirname, "../../packages/sdk/src/index.ts"),
      },
      { find: "server-only", replacement: resolve(import.meta.dirname, "./test/server-only.ts") },
    ],
  },
});
