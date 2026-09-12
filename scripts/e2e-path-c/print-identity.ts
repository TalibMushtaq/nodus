// Prints `{device_id, public_key}` (JSON) for a seed, so the shell can register
// the device with the Relay before running the upload/download harnesses.

import { identityFromSeed } from "./identity";

const i = process.argv.indexOf("--seed");
const seed = i >= 0 ? process.argv[i + 1] : "";
if (!seed) {
  console.error("usage: tsx print-identity.ts --seed <hex>");
  process.exit(2);
}
const identity = identityFromSeed(seed);
console.log(JSON.stringify({ device_id: identity.deviceId, public_key: identity.publicKeyB64 }));
