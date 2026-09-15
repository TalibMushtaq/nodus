import { defineConfig } from "eslint/config";
import expoConfig from "eslint-config-expo/flat.js";

/** @type {import("eslint").Linter.Config[]} */
export default defineConfig([
  expoConfig,
  // Build output and generated native projects are not lint targets.
  { ignores: ["dist/*", ".expo/*", "android/*", "ios/*"] },
]);
