# ADR-0004: Mobile Local Discovery Approach

## Status
Accepted

## Context
Plan §7a flagged that mDNS + WebRTC reliability on mobile depends on the Expo workflow choice and the foreground/background policy.

## Decision
- Use **Expo managed workflow with Continuous Native Generation (CNG)** — config plugins for mDNS/WebRTC where available, with a native/bare escape hatch reserved for specific modules if a required capability isn't achievable through a config plugin.
- Path A (local discovery/transfer) is attempted **foreground only**. The app does not attempt local discovery while backgrounded.
- When local-network permission is denied, the app shows an **explicit message** explaining local transfer is unavailable, then silently falls back to the Relay path for all transfers.

## Consequences
- Positive: keeps the mobile app on the standard Expo/EAS build pipeline as long as possible; foreground-only avoids the iOS/Android background execution complexity (entitlements, foreground services) entirely for v1.
- Negative: no offline local sync while the app is backgrounded — a background-arriving file only transfers locally the next time the app is foregrounded (or arrives via Path C/Relay buffer in the meantime).
- Implementation note: revisit background support only if usage data shows foreground-only local transfer is a meaningful UX gap; CNG config plugins for mDNS discovery should be evaluated early (plan Phase 8/16 in the TODO) since a needed capability might force the native escape hatch sooner than expected.
