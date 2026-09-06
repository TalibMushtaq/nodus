/**
 * Metro config for the Expo SDK 57 app.
 *
 * This app lives in a pnpm workspace whose shared libs (`@repo/relay-client`,
 * `@repo/protocol`) are consumed as compiled `dist` output exposed through
 * package.json `exports` subpaths. Metro needs two things to serve them that
 * are not on by default:
 *
 *  1. watchFolders / nodeModulesPaths pointing at the workspace root (pnpm
 *     keeps dependencies in the root `.pnpm` store, not in this app's
 *     node_modules).
 *  2. `unstable_enablePackageExports` so `@repo/relay-client/local-discovery`
 *     and friends resolve via the `exports` map instead of the legacy
 *     main-field lookup.
 */
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(workspaceRoot, "node_modules"),
  path.resolve(projectRoot, "node_modules"),
];
config.resolver.unstable_enablePackageExports = true;

module.exports = config;