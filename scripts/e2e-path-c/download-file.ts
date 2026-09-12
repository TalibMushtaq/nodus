// Second-device download harness (Phase 14 F2b). Uses device B's own key to
// open its FEK envelope, fetches the stored shards from the node's local HTTP
// endpoint, verifies, decrypts, and writes the reconstructed file. The shell
// then compares it byte-for-byte against the original.

import { writeFileSync } from "node:fs";

import { NodeClient, nodusBaseUrl } from "@repo/relay-client";

import { downloadFile } from "../../apps/web/lib/download";
import type { DownloadDeps } from "../../apps/web/lib/download";
import { openFekFromEnvelope } from "../../apps/web/lib/envelopes";
import type { RelayEnvelope } from "../../apps/web/lib/envelopes";
import type { RelayFile } from "../../apps/web/lib/catalog";
import { identityFromSeed } from "./identity";

interface Args {
  base: string;
  cookie: string;
  seed: string;
  fileId: string;
  version: number;
  nodeHost: string;
  nodePort: number;
  output: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (name: string, fallback = ""): string => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? (argv[i + 1] ?? "") : fallback;
  };
  const base = get("base", "http://localhost").replace(/\/$/, "");
  const cookie = get("cookie");
  const seed = get("seed");
  const fileId = get("file-id");
  const output = get("output");
  if (!cookie || !seed || !fileId || !output) {
    console.error("usage: tsx download-file.ts --base <url> --cookie <raw> --seed <hex> --file-id <id> --output <path> [--version N] [--node-host 127.0.0.1] [--node-port 9378]");
    process.exit(2);
  }
  return {
    base,
    cookie,
    seed,
    fileId,
    version: Number(get("version", "1")),
    nodeHost: get("node-host", "127.0.0.1"),
    nodePort: Number(get("node-port", "9378")),
    output,
  };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const identity = identityFromSeed(args.seed);
  console.log(`[downloader] device=${identity.deviceId}`);

  const authedJson = async <T>(path: string): Promise<T> => {
    const res = await fetch(`${args.base}${path}`, { headers: { cookie: args.cookie } });
    if (!res.ok) {
      throw new Error(`GET ${path} failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as T;
  };

  const files = await authedJson<RelayFile[]>("/api/files");
  const file = files.find((f) => f.file_id === args.fileId);
  if (!file) throw new Error(`file ${args.fileId} not found`);
  const version = file.versions.find((v) => v.version_number === args.version);
  if (!version) throw new Error(`version ${args.version} not found`);

  const deps: DownloadDeps = {
    fetchFileKey: async (fileId) => {
      const envelopes = await authedJson<RelayEnvelope[]>(
        `/api/envelopes?file_id=${encodeURIComponent(fileId)}`,
      );
      const mine = envelopes.find(
        (e) => e.recipient_id === identity.deviceId && e.recipient_kind === "device",
      );
      if (!mine) return null;
      return openFekFromEnvelope(mine.encrypted_key, identity.privateKey);
    },
    getShardLocations: async () => file.locations,
    fetchShard: async (_fileId, location) => {
      if (!location.hash) {
        throw new Error(`shard ${location.shard_index} has no recorded hash`);
      }
      const client = new NodeClient(nodusBaseUrl(args.nodeHost, args.nodePort));
      return client.fetchShard(identity.deviceId, identity.privateKey, location.hash);
    },
  };

  const result = await downloadFile({
    fileId: args.fileId,
    versionNumber: args.version,
    shardCount: version.shard_count,
    encryptedName: file.encrypted_name,
    expectedVersionHash: version.version_hash,
    deps,
  });

  writeFileSync(args.output, result.data);
  console.log(`[downloader] wrote ${result.data.length} bytes; name=${result.name}; shards=${version.shard_count}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[downloader] fatal:", err);
  process.exit(1);
});
