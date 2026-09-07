// Browser-side benchmark: times Path A / Path B WebRTC negotiation against a
// real peer (node or another browser tab). Relies on native RTCPeerConnection
// + EventSource in the browser — this file does NOT run in Node.

import {
  createLocalSignalingChannel,
  createRelaySignalingChannel,
} from "@repo/webrtc-transport";
import { RelayWsClient } from "@repo/relay-client";

async function measure(attempt) {
  const localUrlEl = document.getElementById("localUrl");
  const relayUrlEl = document.getElementById("relayUrl");
  const nodeIdEl = document.getElementById("nodeId");

  const pc = new RTCPeerConnection();
  const dc = pc.createDataChannel(`bench-${attempt}`, { ordered: true });

  let ws = null;
  let signaling;
  let path;
  let waitForAnswer;

  if (localUrlEl.value.trim()) {
    // Path A: local HTTP signaling. The node answers synchronously inside
    // sendOffer's POST response, so the answer Promise resolves there.
    signaling = createLocalSignalingChannel({
      baseUrl: localUrlEl.value.trim(),
      deviceId: `bench-offerer-${attempt}`,
    });
    path = "A";
    waitForAnswer = new Promise((resolve) => {
      signaling.onAnswer = (sdp) => resolve(sdp);
    });
  } else {
    // Path B: relay signaling. Answers arrive asynchronously as relay frames
    // and must be routed through the channel's handleMessage.
    let routeIncoming = (parsed) => {};
    ws = new RelayWsClient(relayUrlEl.value.trim(), {
      onOpen: () => ws.heartbeat(`bench-offerer-${attempt}`),
      onError: () => {},
      onClose: () => {},
      onMessage: (parsed) => routeIncoming(parsed),
    });
    ws.connect();
    signaling = createRelaySignalingChannel(
      ws,
      `bench-offerer-${attempt}`,
      nodeIdEl.value.trim(),
    );
    path = "B";
    waitForAnswer = new Promise((resolve) => {
      signaling.onAnswer = (sdp) => resolve(sdp);
    });
    routeIncoming = (parsed) => signaling.handleMessage(parsed);
  }

  const start = Date.now();
  const opTimeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("negotiation timed out (10s)")), 10_000),
  );

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await signaling.sendOffer(offer.sdp);

  // Whoever answers (a real node, or a paired peer) supplies the SDP answer;
  // then confirm the DataChannel actually opens.
  await Promise.race([waitForAnswer, opTimeout]);
  const dcOpened = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("datachannel open timeout")), 10_000);
    dc.onopen = () => {
      clearTimeout(t);
      resolve();
    };
  });
  const answer = await waitForAnswer;
  await pc.setRemoteDescription({ type: "answer", sdp: answer });
  await Promise.race([dcOpened, opTimeout]);

  const durationMs = Date.now() - start;
  pc.close();
  signaling.close();
  ws?.close();
  return { path, durationMs, success: true };
}

document.getElementById("run").addEventListener("click", async () => {
  const out = document.getElementById("output");
  const rounds = parseInt(document.getElementById("numRounds").value, 10) || 5;
  const networkCondition = document.getElementById("condition").value.trim();

  const results = [];
  for (let i = 0; i < rounds; i++) {
    try {
      const r = await measure(i);
      results.push(r);
      out.textContent += `round ${i}: Path ${r.path} negotiated in ${r.durationMs}ms\n`;
    } catch (err) {
      results.push({ path: "?", success: false, note: String(err) });
      out.textContent += `round ${i}: FAILED — ${err}\n`;
    }
  }

  const report = { timestamp: new Date().toISOString(), networkCondition, rounds: results };
  out.textContent += "\n— report —\n" + JSON.stringify(report, null, 2) + "\n";
});