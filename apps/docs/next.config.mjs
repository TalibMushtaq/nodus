import path from "node:path";
import { fileURLToPath } from "node:url";

import { createMDX } from "fumadocs-mdx/next";

const dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // Self-contained server bundle for the docs container. Trace from the repo
  // root so pnpm workspace packages are included in the standalone output.
  output: "standalone",
  outputFileTracingRoot: path.join(dirname, "../../"),
};

// Fumadocs MDX is ESM-only, so this config lives in a `.mjs` file for accurate
// ESM resolution. The plugin compiles every file under `content/docs` into the
// page collection consumed by `lib/source.ts`.
const withMDX = createMDX();

export default withMDX(config);
