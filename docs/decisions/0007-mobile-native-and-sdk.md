# ADR-0007: Mobile Native Build & Shared Client SDK

## Status
Accepted

## Context
Plan stage 15 requires the Expo client to reach feature parity with the Next.js
web client: catalog, upload/download, envelopes, conflict/tombstone views, and
the full Path A/B/C/D transfer chain. Two facts make that impossible with the
current code shape:

- **Path A/B are native capabilities.** mDNS browsing and WebRTC require
  `react-native-zeroconf` and `react-native-webrtc`, which cannot load in Expo
  Go. ADR-0004 already chose Expo's managed workflow with Continuous Native
  Generation (CNG) and reserved a native escape hatch; reaching parity now
  requires that build.
- **The client logic lives in `apps/web/lib` and is welded to the browser.**
  Catalog, sync-state, keys, envelopes, the uploader, and the transfer
  attempt-path talk directly to IndexedDB, `localStorage`, `XMLHttpRequest`,
  `File`/`Blob`, and Next route handlers. Copying that into `apps/mobile` would
  duplicate the most correctness-sensitive code in the project and guarantee
  the two clients drift.

The Relay also authenticates `GET /ws` from the HttpOnly session cookie only,
while native clients hold the opaque session ID rather than a browser cookie
jar (§13 / Phase 7a).

## Decision
- **Native development build, unconditionally.** `apps/mobile` moves from Expo
  Go to an EAS/`expo prebuild` CNG development build. Config plugins/deps:
  `react-native-webrtc` (Path A/B), `react-native-zeroconf` (mDNS),
  `expo-sqlite` (local catalogue/queues/keys), `expo-crypto`
  (`getRandomValues`/`randomUUID`), `expo-document-picker` + `expo-file-system`
  + `expo-sharing` (file I/O), and `react-native-sse` (Path A trickle ICE, since
  React Native ships no `EventSource`). iOS declares `_nodus._tcp` in
  `NSBonjourServices`; Android grants the multicast/Wi-Fi permissions mDNS
  requires.
- **New `packages/sdk` is the single client implementation.** It holds
  platform-agnostic services (auth/session, device identity, catalogue,
  folders, keys, envelopes, uploader/download, sync-state, pairing helpers,
  selectors) behind adapter interfaces: `RelayHttp`, `LocalStore`,
  `SecureStore`, `FileSource`/`FileSink`, `WebRtcFactory`, `WebSocketFactory`,
  `CryptoRuntime`, `Connectivity`, and `PlatformCapabilities`. The web app and
  the mobile app each supply one adapter set; **`apps/web` migrates onto the
  SDK in this phase** so only one implementation exists.
- **Mobile session transport is the opaque session, not a token or cookie.**
  Mobile stores the session ID in `expo-secure-store` and sends it as
  `Authorization: Bearer` on HTTP. The Relay's `GET /ws` is extended to resolve
  the same credential through the existing `auth.AuthenticateRequest` (cookie
  first, then bearer), so the WS gateway keeps exactly one session model. No
  JWT, refresh token, or `?token=` query parameter is introduced.
- **Path A stays foreground-only.** Discovery and direct transfer run only while
  the app is foregrounded (ADR-0004). Background sync is deferred to stage 17.
- **Pairing mirrors the web flow.** Mobile mints a `NODUS-XXXX-XXXX` code via
  `POST /pairing/codes`, displays it with the operator's `PUBLIC_RELAY_URL`, and
  polls `GET /nodes` for the new node. QR scanning remains a non-goal.

## Consequences
- **Positive:** one implementation of the transfer/envelope/catalogue logic for
  both clients; native Path A/B become possible; WS and REST share one session
  credential; the web app gets a tested adapter boundary as a side effect.
- **Negative:** native builds require an Android/iOS toolchain or EAS; CI can
  only typecheck, test the JS, and run `expo prebuild`/`expo export`, not
  produce signed binaries. The `apps/web` migration is a broad, test-guarded
  refactor with regression risk.
- **Reversibility:** the SDK adapters keep a browser-only future viable; if a
  native module proves incompatible with Expo SDK 57, the ADR-0004 escape hatch
  (bare workflow) remains available without touching the SDK boundary.

## Non-goals
- No background local discovery or background sync (stage 17).
- No QR pairing.
- No second long-lived auth protocol, JWT, or refresh token.
- No shared mobile UI package yet; `@repo/ui` is React-DOM/Tailwind and stays
  web-only, with mobile primitives local to `apps/mobile`.
