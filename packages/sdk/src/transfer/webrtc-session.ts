import { NodusRTCPeerConnection, requestShard, sendShard, waitForChannelOpen } from "@repo/webrtc-transport";
import type { PeerConnectionConfig, SignalingChannel } from "@repo/webrtc-transport";
import type { ShardAckPayload } from "@repo/protocol";

// Persistent WebRTC session for shard uploads (shared by web and native).
//
// Negotiating a peer connection per shard made an 800 MB file pay ~100 SDP/ICE
// round trips before moving any bytes. A session negotiates once and streams
// every shard of a transfer over the same data channel. The node side already
// supports this: its channel handler resets per-shard state after `shard_done`
// and keeps the session warm.
//
// Sends are serialized (a `tail` promise chain) because the frame protocol is
// [metadata][chunks][shard_done][ack] with no shard id on the wire; interleaving
// two sends on one channel would corrupt both. Serial is also what a single
// DataChannel does best — it has its own flow control.
//
// The platform supplies `peerConnectionFactory` (react-native-webrtc on native)
// and `createChannel` (local HTTP or Relay signaling).

const DEFAULT_NEGOTIATION_TIMEOUT_MS = 4000;
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;

export interface PersistentSessionDeps {
  /** Negotiates one signaling channel. Called exactly once per session. */
  createChannel: () => SignalingChannel | Promise<SignalingChannel>;
  negotiationTimeoutMs?: number;
  /** Close an unused session after this long; the node reaps on the same idea. */
  idleTimeoutMs?: number;
  peerConnectionConfig?: PeerConnectionConfig;
  peerConnectionFactory?: (config: RTCConfiguration) => RTCPeerConnection;
}

export interface PersistentShardRequest {
  transferId: string;
  fileId: string;
  versionNumber: number;
  shardIndex: number;
  data: Uint8Array;
  hash: string;
  targetNode?: string;
  sourceDevice?: string;
  onProgress?: (bytesSent: number, totalBytes: number) => void;
}

export interface PersistentShardResult {
  durationMs: number;
  bytesTransferred: number;
  ack: ShardAckPayload;
}

/** One stored shard to pull from a node over the persistent session. */
export interface PersistentShardFetchRequest {
  transferId: string;
  fileId: string;
  versionNumber: number;
  shardIndex: number;
  /** BLAKE3 hex of the stored ciphertext. */
  hash: string;
  size: number;
  sourceNode?: string;
  /** Cumulative bytes received for this shard, as chunks arrive. */
  onProgress?: (receivedBytes: number, totalBytes: number) => void;
}

export interface PersistentShardFetchResult {
  durationMs: number;
  bytesTransferred: number;
  /** Verified ciphertext bytes for the requested shard. */
  data: Uint8Array;
}

export class PersistentWebRtcSession {
  private pc: NodusRTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private signaling: SignalingChannel | null = null;
  /** Serializes sends; each waits for the previous to finish (or fail). */
  private tail: Promise<unknown> = Promise.resolve();
  private failed = false;
  private closed = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: PersistentSessionDeps) {}

  /** True once a peer connection has actually opened (negotiation succeeded). */
  private connectedOnce = false;

  /** A healthy session can accept another shard; a dead one must be recreated. */
  get healthy(): boolean {
    return !this.failed && !this.closed;
  }

  /**
   * Whether negotiation has ever succeeded. A failure before this point is a
   * transport/reachability problem (worth cooling down); a failure after it is
   * more likely a one-off shard/transport blip.
   */
  get everConnected(): boolean {
    return this.connectedOnce;
  }

  send(request: PersistentShardRequest): Promise<PersistentShardResult> {
    const run = this.tail.then(() => this.doSend(request));
    // Keep the chain alive: a failure poisons only this session, and the cache
    // drops it so the next attempt negotiates a fresh one.
    this.tail = run.then(
      () => undefined,
      () => {
        this.invalidate();
      },
    );
    return run;
  }

  /**
   * Fetch one stored shard from the peer (Storage Node) over the same
   * persistent channel used for uploads. Download and upload share one `tail`
   * so frames from the two directions never interleave on a single channel.
   */
  receive(request: PersistentShardFetchRequest): Promise<PersistentShardFetchResult> {
    const run = this.tail.then(() => this.doReceive(request));
    this.tail = run.then(
      () => undefined,
      () => {
        this.invalidate();
      },
    );
    return run;
  }

  private async doReceive(request: PersistentShardFetchRequest): Promise<PersistentShardFetchResult> {
    if (!this.healthy) throw new Error("WebRTC session is no longer usable");
    await this.ensureConnected();
    const channel = this.channel;
    if (!channel || channel.readyState !== "open") {
      throw new Error("WebRTC data channel is not open");
    }

    const startedAt = Date.now();
    const data = await requestShard(channel, {
      transferId: request.transferId,
      fileId: request.fileId,
      versionNumber: request.versionNumber,
      shardIndex: request.shardIndex,
      hash: request.hash,
      size: request.size,
      sourceNode: request.sourceNode,
      onProgress: request.onProgress,
      // A shard can be many MB on a slow link; the budget scales with the
      // negotiation budget rather than the 30s default the upload path uses.
      timeoutMs: (this.deps.negotiationTimeoutMs ?? DEFAULT_NEGOTIATION_TIMEOUT_MS) * 30,
    });
    this.touchIdleTimer();
    return {
      durationMs: Date.now() - startedAt,
      bytesTransferred: data.byteLength,
      data,
    };
  }

  private async doSend(request: PersistentShardRequest): Promise<PersistentShardResult> {
    if (!this.healthy) throw new Error("WebRTC session is no longer usable");
    await this.ensureConnected();
    const channel = this.channel;
    if (!channel || channel.readyState !== "open") {
      throw new Error("WebRTC data channel is not open");
    }

    const startedAt = Date.now();
    const ack = await sendShard(channel, {
      transferId: request.transferId,
      fileId: request.fileId,
      versionNumber: request.versionNumber,
      shardIndex: request.shardIndex,
      data: request.data,
      hash: request.hash,
      targetNode: request.targetNode,
      sourceDevice: request.sourceDevice,
      // One shard can take a while on a slow link; the ack budget scales with
      // the negotiation budget the same way the per-shard transfer did.
      ackTimeoutMs: (this.deps.negotiationTimeoutMs ?? DEFAULT_NEGOTIATION_TIMEOUT_MS) * 5,
      onProgress: request.onProgress,
    });
    this.touchIdleTimer();
    return {
      durationMs: Date.now() - startedAt,
      bytesTransferred: request.data.byteLength,
      ack,
    };
  }

  private async ensureConnected(): Promise<void> {
    if (this.channel && this.channel.readyState === "open") return;
    if (this.channel) {
      // A channel that existed but is no longer open is dead (the close/error
      // listener already invalidated us); fail so the caller re-negotiates.
      this.invalidate();
      throw new Error("WebRTC data channel closed");
    }
    await this.connect();
  }

  private async connect(): Promise<void> {
    const timeoutMs = this.deps.negotiationTimeoutMs ?? DEFAULT_NEGOTIATION_TIMEOUT_MS;
    const signaling = await this.deps.createChannel();
    const pc = new NodusRTCPeerConnection(
      this.deps.peerConnectionConfig ?? {},
      {
        onIceCandidate: (candidate) => {
          const json = candidate.toJSON ? candidate.toJSON() : candidate;
          signaling.sendIceCandidate(JSON.stringify(json)).catch(() => undefined);
        },
      },
      this.deps.peerConnectionFactory,
    );

    signaling.onIceCandidate = (candidateStr) => {
      let parsed: RTCIceCandidateInit;
      try {
        parsed = JSON.parse(candidateStr) as RTCIceCandidateInit;
      } catch {
        parsed = { candidate: candidateStr, sdpMid: "0", sdpMLineIndex: 0 };
      }
      pc.addIceCandidate(parsed).catch(() => undefined);
    };

    // Kept outside the promise so an early throw (e.g. sendOffer fails) can
    // cancel the timeout instead of leaving a promise to reject unhandled.
    let answerTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      const answer = new Promise<string>((resolve, reject) => {
        answerTimer = setTimeout(
          () => reject(new Error(`WebRTC negotiation timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
        signaling.onAnswer = (sdp) => {
          if (answerTimer) clearTimeout(answerTimer);
          resolve(sdp);
        };
      });

      const channel = pc.createDataChannel("nodus-shard", { ordered: true });
      const offer = await pc.createOffer();
      if (!offer.sdp) throw new Error("created SDP offer is empty");

      await signaling.sendOffer(offer.sdp);
      const answerSdp = await answer;
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
      await waitForChannelOpen(channel, timeoutMs);

      channel.addEventListener("close", () => this.invalidate());
      channel.addEventListener("error", () => this.invalidate());

      this.pc = pc;
      this.channel = channel;
      this.signaling = signaling;
      this.connectedOnce = true;
      this.touchIdleTimer();
    } catch (err) {
      // A half-built session must not leak its peer connection or socket.
      if (answerTimer) clearTimeout(answerTimer);
      try {
        pc.close();
      } catch {
        // ignore
      }
      try {
        signaling.close();
      } catch {
        // ignore
      }
      throw err;
    }
  }

  private touchIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(
      () => this.close(),
      this.deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    );
  }

  private invalidate(): void {
    this.failed = true;
    this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    try {
      this.channel?.close();
    } catch {
      // ignore
    }
    try {
      this.pc?.close();
    } catch {
      // ignore
    }
    try {
      this.signaling?.close();
    } catch {
      // ignore
    }
    this.channel = null;
    this.pc = null;
    this.signaling = null;
  }
}

/**
 * One persistent session per key (normally `"<path>:<nodeId>"`), recreated on
 * demand when the previous one died or idled out.
 */
export class WebRtcSessionCache {
  private readonly sessions = new Map<string, PersistentWebRtcSession>();
  /** Keys whose negotiation recently failed, until this timestamp. */
  private readonly cooldowns = new Map<string, number>();

  // A failed direct path is benched for a couple of minutes: retrying too soon
  // makes every shard pay another negotiation/ack timeout while the transfer
  // crawls (the buffer fallback is progress, this path is not).
  constructor(private readonly cooldownMs = 120_000) {}

  /**
   * False while a key is cooling down after a negotiation failure. Callers skip
   * the path immediately instead of paying another timeout — otherwise an
   * offline node costs one negotiation timeout per shard before Path C runs.
   */
  isAvailable(key: string): boolean {
    const until = this.cooldowns.get(key);
    if (until === undefined) return true;
    if (Date.now() >= until) {
      this.cooldowns.delete(key);
      return true;
    }
    return false;
  }

  /** Start (or extend) the cooldown after a negotiation-level failure. */
  markUnavailable(key: string): void {
    if (this.cooldownMs > 0) this.cooldowns.set(key, Date.now() + this.cooldownMs);
  }

  get(key: string, createDeps: () => PersistentSessionDeps): PersistentWebRtcSession {
    const existing = this.sessions.get(key);
    if (existing?.healthy) return existing;
    existing?.close();
    const session = new PersistentWebRtcSession(createDeps());
    this.sessions.set(key, session);
    return session;
  }

  /** Drop a session that just failed so the next attempt renegotiates. */
  evict(key: string): void {
    const session = this.sessions.get(key);
    if (session) {
      session.close();
      this.sessions.delete(key);
    }
  }

  closeAll(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
    this.cooldowns.clear();
  }
}
