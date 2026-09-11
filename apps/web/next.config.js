import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Self-contained server bundle for the single-origin deploy image.
  output: "standalone",
  // Trace from the monorepo root so pnpm workspace packages are included in
  // the standalone output rather than resolved from a higher node_modules.
  outputFileTracingRoot: path.join(dirname, "../../"),
};

export default nextConfig;
