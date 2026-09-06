import { EventEmitter } from "node:events";

export class MockRTCDataChannel extends EventEmitter implements Partial<RTCDataChannel> {
  readyState: RTCDataChannelState = "open";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType: BinaryType = "arraybuffer";
  peer: MockRTCDataChannel | null = null;
  label: string;

  constructor(label = "test-channel") {
    super();
    this.label = label;
  }

  static createPair(label = "pair-channel"): [MockRTCDataChannel, MockRTCDataChannel] {
    const a = new MockRTCDataChannel(label);
    const b = new MockRTCDataChannel(label);
    a.peer = b;
    b.peer = a;
    return [a, b];
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== "open") {
      throw new Error("Cannot send on closed channel");
    }

    // Deliver asynchronously to simulate network
    queueMicrotask(() => {
      if (!this.peer || this.peer.readyState !== "open") return;

      let payload: unknown = data;
      if (data instanceof ArrayBuffer) {
        payload = data;
      } else if (ArrayBuffer.isView(data)) {
        payload = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      }

      const event = { data: payload } as MessageEvent;
      this.peer.emit("message", event);
    });
  }

  close(): void {
    this.readyState = "closed";
    this.emit("close", { type: "close" } as Event);
    if (this.peer && this.peer.readyState === "open") {
      this.peer.readyState = "closed";
      this.peer.emit("close", { type: "close" } as Event);
    }
  }

  addEventListener(type: string, listener: (...args: unknown[]) => void): void {
    this.on(type, listener);
  }

  removeEventListener(type: string, listener: (...args: unknown[]) => void): void {
    this.off(type, listener);
  }
}
