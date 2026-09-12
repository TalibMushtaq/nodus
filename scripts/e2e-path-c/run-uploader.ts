// Wire-level Path C uploader harness for scripts/e2e-path-c.sh.
//
// It drives the *real* `apps/web/lib/uploader.ts` (same two-pass shard/emit/
// upload code the browser runs) against a live Relay + Next proxy, using a
// file-backed implementation of the uploader's injected side effects so a
// `--stop-after` kill leaves durable progress that a second invocation resumes.
//
// It does not build a session itself: the shell script authenticates and pairs,
// then passes the session cookie, device id, node id, and file id as args.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import WSWebSocket from "ws";

import { MessageTypes } from "@repo/protocol";
import type { BatchAckPayload, EventPayload } from "@repo/protocol";
import { RelayWsClient } from "@repo/relay-client";

import { uploadFile } from "../../apps/web/lib/uploader";
import type { UploadDeps } from "../../apps/web/lib/uploader";
import type { ShardUpload } from "../../apps/web/lib/buffer";
import type { UploadProgress } from "../../apps/web/lib/upload-progress";
import { envelopeEvent, sealFekForRecipientIdentity } from "../../apps/web/lib/envelopes";
import { identityFromSeed } from "./identity";

interface Args {
  base: string;
  cookie: string;
  deviceId: string;
  /** Hex seed for device A; enables FEK envelope publishing for F2b. */
  seed: string;
  targetNode: string;
  file: string;
  fileId: string;
  stateDir: string;
  version: number;
  stopAfter: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (name: string, fallback = ""): string => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? (argv[i + 1] ?? "") : fallback;
  };
  const base = get("base", "http://localhost").replace(/\/$/, "");
  const cookie = get("cookie");
  const deviceId = get("device-id");
  const targetNode = get("target-node");
  const file = get("file");
  const fileId = get("file-id");
  const stateDir = get("state-dir");
  if (!cookie || !deviceId || !targetNode || !file || !fileId || !stateDir) {
    console.error("usage: tsx run-uploader.ts --base <url> --cookie <raw> --device-id <id> --target-node <id> --file <path> --file-id <id> --state-dir <dir> [--stop-after N]");
    process.exit(2);
  }
  return {
    base,
    cookie,
    deviceId,
    seed: get("seed"),
    targetNode,
    file,
    fileId,
    stateDir,
    version: Number(get("version", "1")),
    stopAfter: Number(get("stop-after", "0")),
  };
}

interface PersistedState {
  keys: Record<string, string>;
  progress: Record<string, UploadProgress>;
  sequences: Record<string, number>;
}

function loadState(dir: string): PersistedState {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "path-c-state.json");
  if (!existsSync(path)) {
    return { keys: {}, progress: {}, sequences: {} };
  }
  return JSON.parse(readFileSync(path, "utf8")) as PersistedState;
}

function saveState(dir: string, state: PersistedState): void {
  writeFileSync(join(dir, "path-c-state.json"), JSON.stringify(state, null, 2));
}

async function makeDeps(args: Args, state: PersistedState): Promise<UploadDeps> {
  const persist = () => saveState(args.stateDir, state);

  // Connect the real Relay WS client with the session cookie, which the browser
  // WebSocket API cannot set; `ws` supports handshake headers.
  let openResolve: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    openResolve = resolve;
  });
  const wsClient = new RelayWsClient({
    endpoint: `${args.base.replace(/^http/, "ws")}/ws`,
    peerId: args.deviceId,
    webSocketFactory: (endpoint) =>
      new WSWebSocket(endpoint, { headers: { Cookie: args.cookie } }) as unknown as WebSocket,
    handlers: { onOpen: () => openResolve() },
  });
  wsClient.connect();
  await Promise.race([
    opened,
    new Promise((_, reject) => setTimeout(() => reject(new Error("WS did not open")), 10_000)),
  ]);

  const sendEventBatch = (events: EventPayload[]): Promise<BatchAckPayload> =>
    new Promise<BatchAckPayload>((resolve, reject) => {
      let off: () => void = () => undefined;
      const timer = setTimeout(() => {
        off();
        reject(new Error("timed out waiting for batch_ack"));
      }, 10_000);
      off = wsClient.on("batch_ack", (payload) => {
        clearTimeout(timer);
        off();
        resolve(payload as BatchAckPayload);
      });
      wsClient.send({ type: MessageTypes.EVENT_BATCH, payload: { events } });
    });

  const postShardImpl = async (dto: ShardUpload): Promise<{ buffer_id: string; status: string }> => {
    const res = await fetch(`${args.base}/api/buffer/upload`, {
      method: "POST",
      headers: {
        cookie: args.cookie,
        "content-type": "application/octet-stream",
        "x-nodus-file-id": dto.fileId,
        "x-nodus-version-number": String(dto.versionNumber),
        "x-nodus-shard-index": String(dto.shardIndex),
        "x-nodus-hash": dto.hash,
        "x-nodus-size": String(dto.size),
        "x-nodus-target-node": dto.targetNode,
        "x-nodus-transfer-id": dto.transferId,
        "x-nodus-source-device": dto.sourceDevice ?? args.deviceId,
      },
      // BufferSource is valid for undici fetch.
      body: dto.data as unknown as BodyInit,
    });
    if (!res.ok) {
      throw new Error(`shard ${dto.shardIndex} upload failed: ${res.status} ${await res.text()}`);
    }
    console.log(`[uploader] shard ${dto.shardIndex} -> RELAY_BUFFERED`);
    return (await res.json()) as { buffer_id: string; status: string };
  };

  let posted = 0;
  const postShard = async (dto: ShardUpload) => {
    const result = await postShardImpl(dto);
    posted += 1;
    if (args.stopAfter > 0 && posted >= args.stopAfter) {
      // Schedule the exit on a macrotask so the uploader's `await
      // markShardComplete` microtask (a synchronous file write) runs first.
      // That is what makes the kill leave durable, resumable progress.
      console.log(`[uploader] stop-after=${args.stopAfter} reached; exiting`);
      setTimeout(() => process.exit(0), 0);
    }
    return result;
  };

  // F2b: seal the FEK for device A, every other active device, and the nodes,
  // then publish the envelopes so a second device can decrypt.
  const publishEnvelopes = async (fileId: string, fek: Uint8Array): Promise<void> => {
    if (!args.seed) return;
    const identity = identityFromSeed(args.seed);
    const headers = { cookie: args.cookie };
    const [devices, nodes] = await Promise.all([
      fetch(`${args.base}/api/devices`, { headers }).then(
        (r) => r.json() as Promise<Array<{ device_id: string; public_key: string; status: string }>>,
      ),
      fetch(`${args.base}/api/nodes`, { headers }).then(
        (r) => r.json() as Promise<Array<{ node_id: string; public_key: string; status: string }>>,
      ),
    ]);
    const recipients = [
      { recipient_id: identity.deviceId, recipient_kind: "device" as const, publicKey: identity.publicKeyB64 },
      ...devices
        .filter((d) => d.status === "ACTIVE" && d.device_id !== identity.deviceId)
        .map((d) => ({ recipient_id: d.device_id, recipient_kind: "device" as const, publicKey: d.public_key })),
      ...nodes
        .filter((n) => n.status === "ACTIVE")
        .map((n) => ({ recipient_id: n.node_id, recipient_kind: "node" as const, publicKey: n.public_key })),
    ];
    const events: EventPayload[] = [];
    for (const recipient of recipients) {
      const encrypted_key = sealFekForRecipientIdentity(fek, new Uint8Array(Buffer.from(recipient.publicKey, "base64")));
      const sequence = (state.sequences[identity.deviceId] ?? 0) + 1;
      state.sequences[identity.deviceId] = sequence;
      persist();
      events.push(
        envelopeEvent(identity.deviceId, sequence, fileId, {
          recipient_id: recipient.recipient_id,
          recipient_kind: recipient.recipient_kind,
          encrypted_key,
        }),
      );
    }
    const ack = await sendEventBatch(events);
    if (ack && ack.ok === false) {
      throw new Error(`envelope batch rejected: ${ack.reason ?? "unknown"}`);
    }
    console.log(`[uploader] published ${events.length} key envelopes`);
  };

  const deps: UploadDeps = {
    postShard,
    sendEventBatch,
    publishEnvelopes,
    allocateSequence: async (originId) => {
      const next = (state.sequences[originId] ?? 0) + 1;
      state.sequences[originId] = next;
      persist();
      return next;
    },
    putFileKey: async (fileId, fek) => {
      state.keys[fileId] = Buffer.from(fek).toString("base64");
      persist();
    },
    getFileKey: async (fileId) => {
      const encoded = state.keys[fileId];
      return encoded ? new Uint8Array(Buffer.from(encoded, "base64")) : undefined;
    },
    saveProgress: async (progress) => {
      state.progress[progress.transferId] = progress;
      persist();
    },
    getProgress: async (fileId, versionNumber) => state.progress[`${fileId}:${versionNumber}`],
    markShardComplete: async (fileId, versionNumber, shardIndex) => {
      const progress = state.progress[`${fileId}:${versionNumber}`];
      if (progress && !progress.completedShards.includes(shardIndex)) {
        progress.completedShards.push(shardIndex);
        progress.updatedAt = new Date().toISOString();
        persist();
      }
    },
    clearProgress: async (fileId, versionNumber) => {
      delete state.progress[`${fileId}:${versionNumber}`];
      persist();
    },
  };

  return deps;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const state = loadState(args.stateDir);
  const deps = await makeDeps(args, state);
  const bytes = readFileSync(args.file);
  const file = new File([bytes], basename(args.file));

  const result = await uploadFile({
    file,
    originId: args.deviceId,
    targetNode: args.targetNode,
    sourceDevice: args.deviceId,
    fileId: args.fileId,
    versionNumber: args.version,
    deps,
    onProgress: (p) => console.log(`[uploader] ${p.phase} ${p.completedShards}/${p.totalShards}`),
  });

  console.log(`[uploader] done ${JSON.stringify(result)}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[uploader] fatal:", err);
  process.exit(1);
});
