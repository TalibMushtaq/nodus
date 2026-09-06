import type {
  PeerConnectionConfig,
  PeerConnectionEvents,
  PeerConnectionState,
} from "./types.js";

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
];

export class NodusRTCPeerConnection {
  private readonly pc: RTCPeerConnection;
  private readonly events: PeerConnectionEvents;
  private readonly pendingRemoteIceCandidates: RTCIceCandidateInit[] = [];
  private remoteDescriptionSet = false;
  private isClosed = false;

  constructor(
    config: PeerConnectionConfig = {},
    events: PeerConnectionEvents = {},
    customFactory?: (cfg: RTCConfiguration) => RTCPeerConnection,
  ) {
    this.events = events;
    const rtcConfig: RTCConfiguration = {
      iceServers: config.iceServers ?? DEFAULT_ICE_SERVERS,
    };

    if (customFactory) {
      this.pc = customFactory(rtcConfig);
    } else if (typeof RTCPeerConnection !== "undefined") {
      this.pc = new RTCPeerConnection(rtcConfig);
    } else {
      throw new Error(
        "RTCPeerConnection is not available in this environment. Provide customFactory in options.",
      );
    }

    this.setupListeners();
  }

  get native(): RTCPeerConnection {
    return this.pc;
  }

  get connectionState(): PeerConnectionState {
    return (this.pc.connectionState || "new") as PeerConnectionState;
  }

  private setupListeners(): void {
    this.pc.onicecandidate = (event) => {
      if (event.candidate && !this.isClosed) {
        this.events.onIceCandidate?.(event.candidate);
      }
    };

    this.pc.ondatachannel = (event) => {
      if (!this.isClosed) {
        this.events.onDataChannel?.(event.channel);
      }
    };

    this.pc.onconnectionstatechange = () => {
      if (!this.isClosed) {
        this.events.onStateChange?.(this.connectionState);
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      // Map failed ice state to state change event if connectionState is not yet failed
      if (this.pc.iceConnectionState === "failed" && !this.isClosed) {
        this.events.onStateChange?.("failed");
      }
    };
  }

  async createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit> {
    const offer = await this.pc.createOffer(options);
    await this.pc.setLocalDescription(offer);
    return offer;
  }

  async createAnswer(options?: RTCAnswerOptions): Promise<RTCSessionDescriptionInit> {
    const answer = await this.pc.createAnswer(options);
    await this.pc.setLocalDescription(answer);
    return answer;
  }

  async setLocalDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    await this.pc.setLocalDescription(desc);
  }

  async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    await this.pc.setRemoteDescription(desc);
    this.remoteDescriptionSet = true;

    // Drain queued ICE candidates
    while (this.pendingRemoteIceCandidates.length > 0) {
      const candidate = this.pendingRemoteIceCandidates.shift();
      if (candidate) {
        try {
          await this.pc.addIceCandidate(candidate);
        } catch (err) {
          this.events.onError?.(err);
        }
      }
    }
  }

  async addIceCandidate(candidate: RTCIceCandidateInit | string): Promise<void> {
    const init: RTCIceCandidateInit =
      typeof candidate === "string" ? { candidate, sdpMid: "0", sdpMLineIndex: 0 } : candidate;

    if (!this.remoteDescriptionSet) {
      this.pendingRemoteIceCandidates.push(init);
      return;
    }

    try {
      await this.pc.addIceCandidate(init);
    } catch (err) {
      this.events.onError?.(err);
      throw err;
    }
  }

  createDataChannel(
    label: string,
    options: RTCDataChannelInit = { ordered: true },
  ): RTCDataChannel {
    return this.pc.createDataChannel(label, options);
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.pendingRemoteIceCandidates.length = 0;
    try {
      this.pc.close();
    } catch {
      // Ignore errors on close
    }
    this.events.onStateChange?.("closed");
  }
}
