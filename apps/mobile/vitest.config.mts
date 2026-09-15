import { defineConfig } from "vitest/config";

// Mobile tests run in Node and cover the platform-neutral logic (name
// decryption, base64 helpers, etc.); anything touching expo-* native modules is
// exercised via a real dev build, not here.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
