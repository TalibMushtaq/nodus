import { createMDX } from "fumadocs-mdx/next";

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
};

// Fumadocs MDX is ESM-only, so this config lives in a `.mjs` file for accurate
// ESM resolution. The plugin compiles every file under `content/docs` into the
// page collection consumed by `lib/source.ts`.
const withMDX = createMDX();

export default withMDX(config);
