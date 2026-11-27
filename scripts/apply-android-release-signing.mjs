#!/usr/bin/env node
// Point the Expo-generated Android release build at the persistent Nodus
// upload key instead of the shared debug key.
//
// Expo CNG regenerates `apps/mobile/android` on every CI run, so the signing
// block cannot be committed there; the release workflow runs this script after
// `expo prebuild` and before Gradle. Credentials arrive as environment
// variables from GitHub secrets and are never written to disk in this script.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const gradlePath =
  process.argv[2] ?? path.join("apps", "mobile", "android", "app", "build.gradle");

const requiredEnv = [
  "ANDROID_KEYSTORE_PATH",
  "ANDROID_KEYSTORE_PASSWORD",
  "ANDROID_KEY_ALIAS",
  "ANDROID_KEY_PASSWORD",
];

const missing = requiredEnv.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(
    `[signing] missing environment variables: ${missing.join(", ")}\n` +
      "[signing] set the Android release-key secrets before running this script.",
  );
  process.exit(1);
}

let gradle = await readFile(gradlePath, "utf8");

if (gradle.includes("signingConfigs.release")) {
  console.log("[signing] release signing config already present; nothing to do.");
  process.exit(0);
}

// Insert a release config next to the generated debug one. Gradle resolves the
// store path at configuration time, so the CI step must export the same
// variables for the build invocation too.
const debugSigningAnchor = `    signingConfigs {
        debug {`;
const releaseSigning = `    signingConfigs {
        release {
            storeFile file(System.getenv("ANDROID_KEYSTORE_PATH"))
            storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD")
            keyAlias System.getenv("ANDROID_KEY_ALIAS")
            keyPassword System.getenv("ANDROID_KEY_PASSWORD")
        }
        debug {`;

if (!gradle.includes(debugSigningAnchor)) {
  console.error(
    "[signing] could not find the generated signingConfigs block; Expo's template changed.",
  );
  process.exit(1);
}
gradle = gradle.replace(debugSigningAnchor, releaseSigning);

// The generated release buildType explicitly reuses the debug key; swap it for
// the persistent key so version N+1 can install over version N.
const debugReleaseAnchor = `            // Caution! In production, you need to generate your own keystore file.
            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig signingConfigs.debug`;
const releaseBuildType = `            // Signed with the persistent Nodus upload key from CI secrets so
            // future versions install over the top of an existing install.
            signingConfig signingConfigs.release`;

if (!gradle.includes(debugReleaseAnchor)) {
  console.error(
    "[signing] could not find the generated release buildType block; Expo's template changed.",
  );
  process.exit(1);
}
gradle = gradle.replace(debugReleaseAnchor, releaseBuildType);

await writeFile(gradlePath, gradle);
console.log(`[signing] patched ${gradlePath} to use the release keystore.`);
