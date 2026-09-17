# Mobile Redesign & Web Feature Parity Plan

Port the `nodus-design/` visual language into the React Native (Expo) app and
bring native functionality to parity with the web app, then extend the backend
where the design requires behavior the relay does not yet support.

Checkboxes track completion. Phase 0 is implemented in the same change that
creates this document; later phases are updated as they land.

## Context & decisions

- **Design source:** `nodus-design/` (React + Vite + Tailwind, Figma Make).
  Mobile spec = `nodus-design/src/pages/mobile/MobileShell.tsx`; tokens =
  `nodus-design/src/index.css`; status language = `components/StatusBadge.tsx`;
  path language = `components/PathIndicator.tsx`.
- **Mobile IA (decided):** four bottom tabs — **Files · Devices · Activity ·
  Settings**. Pairing lives under Devices; Security and Trash live under
  Settings.
- **Dependencies (decided):** allowed; native modules require a fresh CNG dev
  build.
- **Design vs backend (decided):** matching interactions must actually work —
  extend the relay/protocol where needed rather than mocking.
- **Version restore (decided):** show version **history read-only**; defer the
  restore mutation (largest backend item).
- **Notifications (decided):** build a **full push backend** in Phase 3.
- **Sequencing (decided):** mobile redesign and parity first, backend
  extensions last.

### Why the current app feels like "pair/unpair only"

`App.tsx` registers six signed-in screens in a native stack whose initial route
is `Home` (the pairing hub). No screen calls `navigation.navigate`, so Files,
Devices, Conflicts, Security and Settings are **unreachable** after sign-in.
The tab shell in Phase 0 fixes discoverability; Phases 1–2 give the screens the
designed UI.

---

## Phase 0 — Design foundation (no behavior change)

- [x] Add dependencies: `@react-navigation/bottom-tabs`, `react-native-svg`,
      `expo-font`, `@expo-google-fonts/inter`, `@expo-google-fonts/jetbrains-mono`
- [x] Port design tokens to `apps/mobile/src/design/tokens.ts`
      (light + dark palettes, status palette, spacing, radius, type)
- [x] Theme provider: `apps/mobile/src/design/theme.tsx`
      (light/dark/system, persisted to SQLite preferences, font loading)
- [x] Central SVG icon set: `apps/mobile/src/design/icons.tsx`
- [x] Primitives: `apps/mobile/src/design/primitives.tsx`
      (`ThemedText`, `IconButton`, `Button`, `Card`, `SectionLabel`,
      `StatusBadge`, `PathIndicator`, `Toggle`, `Progress`, `EmptyState`,
      `Divider`, `ConfirmDialog`, `Sheet`, `ScreenHeader`, `Screen`)
- [x] Navigation shell: `apps/mobile/src/navigation/` (4 tabs + per-tab stacks,
      themed tab bar, header shortcuts to Pairing/Conflicts/Security)
- [x] Activity placeholder screen: `apps/mobile/src/screens/ActivityScreen.tsx`
- [x] `app.json`: `userInterfaceStyle` → `automatic`
- [x] `App.tsx` rebuilt as the root shell wrapping `ThemeProvider`
- [x] Verify mobile `tsc --noEmit` + `eslint`
- [x] `CHANGELOG.md` entry

**Checkpoint:** app launches with the designed shell (warm palette, Inter /
JetBrains Mono, themed tab bar, light+dark), all previously-unreachable screens
are reachable, and existing actions still work.

---

## Phase 1 — Redesign screens on current runtime

Files tab:
- [x] Files list: header title + active node/free space subtitle, search and
      sort/filter header buttons, breadcrumb, FAB action sheet (Upload file,
      Upload photo/video, New folder), designed rows with type icon, name,
      size + modified, `StatusBadge`
- [x] File Detail screen: preview block, status, size/modified, read-only
      version history, and the Download/Rename/Delete actions
- [x] Row context menu (long-press): Download, Rename, Move, View versions,
      Delete
- [x] Conflicts screen redesign (inbox rows, resolve action, empty state)

Devices tab:
- [x] Devices list: paired/offline subtitle, "Pair a device" button, Storage
      nodes + Client devices sections, designed rows
- [x] Pairing screen: pairing-code display, QR of the `nodus://pair` deep link,
      copy link, manual host entry
- [x] Node Detail screen: rename, status/capacity, identity fingerprint, ping
- [x] Device Detail screen: rename, device id, revoke access
- [x] Empty state when no devices paired

Activity tab:
- [x] Designed shell (filters + empty state) pending the real log in Phase 2

Settings tab:
- [x] Redesigned grouped settings (Account, Appearance, Storage node, Security,
      Storage & cleanup, About)
- [x] Security screen: recovery key card (reveal/copy/regenerate), envelope
      coverage table, device revocation list, export backup
- [x] Trash / deleted files screen
- [x] Signup screen (register mode + 24-word recovery phrase enrollment)

Deferred from Phase 1 (now tracked under Phase 2 / beyond):
- [x] File Detail Share/Move actions and pull-to-refresh (Phase 2)
- [ ] Camera scan of a pairing QR (`expo-camera` + permissions)
- [ ] Node Detail "set primary" and "forget node"
- [ ] "Force sync" row action

**Checkpoint:** every currently-wired action is reachable through the designed
UI and account creation works on mobile.

---

## Phase 2 — Mobile parity gaps (mobile-only, no backend)

- [x] New SQLite `transfer_log` store + Activity feed (filters: All, Uploads,
      Downloads, Conflicts, Errors), live upload progress, and the sync-history
      list
- [x] Expose transfer depth through `useNodusApp`: queue count
      (`pendingTransfers`) and upload byte/shard progress (`uploadProgress`)
- [x] Files: search, sort, status filter (delivered in Phase 1)
- [x] Files: multi-select bulk actions (move / download / delete)
- [x] Folders: properties sheet
- [x] Version history (read-only) wired to real version rows (Phase 1)
- [x] Pull-to-refresh on Files / Devices / Activity / Security / Trash
- [x] File Detail Share and Move actions (folder picker)
- [x] Trusted-node delete/unpair (`removeTrustedNode` + Node Detail action)
- [x] Security: change password and log out all other devices
- [x] Notification preferences UI (persisted client prefs, wired to push in
      Phase 3)

Deferred beyond Phase 2 (need runtime/backend support that does not exist):
- [ ] Per-transfer cancel/retry and a transfer detail screen (the shared
      `TransferManager` exposes no cancellation API)
- [ ] Folder move and zip download (folder mutations have no move; zip needs a
      mobile zip writer)
- [ ] Node set-primary and account-wide forget (the relay has no such routes)
- [ ] Camera scan of a pairing QR (`expo-camera` + permissions)
- [ ] Envelope table detail beyond the per-recipient coverage summary
- [ ] Manage storage screen + run cleanup (no relay endpoints)
- [ ] File previews (decrypt images/text where safe)

**Checkpoint:** native feature parity with web, excluding version restore,
conflict A/B choice, and the deferred items above.

---

## Phase 3 — Backend extensions (conflict choice + push)

Conflict A/B/Both — **done** (additive `preferred_version` design; no shards
deleted):
- [x] ADR addendum to `docs/decisions/0003-conflict-resolution-ux.md` defining
      keep-version semantics
- [x] `packages/protocol`: extend `CONFLICT_RESOLVED` payload with an optional
      `keep_version`; regenerate schemas + tests
- [x] Relay: migration `023_file_preferred_version`; `ResolveConflict` accepts
      `{ "keep_version": N }`, validates ownership, records
      `files.preferred_version`, and emits the extended event (both the REST and
      WebSocket-event paths)
- [x] Rust storage node: no change required — resolution stays an
      acknowledgement and no version data is discarded
- [x] SDK: `preferred_version` in the catalog (chosen version becomes current)
      + `conflictResolvedEvent(..., keepVersion)`; web + mobile UIs offer
      Keep vX / Keep vY / Keep both

Push notifications:
- [x] Relay migration `push_tokens` (device_id, account, expo token, platform,
      per-category opt-outs) + `conflict_notices` dedup table
- [x] Endpoints to register/unregister Expo push tokens
      (`POST`/`DELETE /devices/push-token`)
- [x] Triggers: conflict flagged (once per file, re-alerts after resolution);
      storage node offline (fired when a node's last WS connection closes);
      backup complete (once per fully `NODE_STORED` file version)
- [x] Mobile: `expo-notifications`, token registration on session, category
      prefs mirrored to the relay, tap handling that opens the Activity tab,
      and token removal on sign-out
- [x] Privacy: payloads carry generic copy only (no decrypted filenames)
- [x] Web browser push: `public/sw.js`, BFF subscribe/unsubscribe routes, a
      Settings opt-in (`BrowserNotifications`), relay `web_push_subscriptions`
      table + `/devices/web-push` endpoints, and a VAPID sender
- [x] Setup documented in `docs/push-notifications.md`; env examples extended
      (`EXPO_PUSH_ACCESS_TOKEN`, `VAPID_*`, `NEXT_PUBLIC_VAPID_PUBLIC_KEY`,
      `EXPO_PUBLIC_EAS_PROJECT_ID`)
- [x] External setup documented in `docs/push-notifications.md`; the remaining
      step is operator action only (create EAS/APNs/FCM credentials and set the
      env vars listed below)

**Checkpoint:** Keep A/B/Both works end-to-end. Push is implemented for mobile
and web; delivery is gated only on operator-supplied credentials
(`EXPO_PUBLIC_EAS_PROJECT_ID`, relay `EXPO_PUSH_ACCESS_TOKEN`, `VAPID_*`,
`NEXT_PUBLIC_VAPID_PUBLIC_KEY`, APNs/FCM).

---

## Phase 4 — Polish & docs

- [x] Dark-mode audit: no hardcoded theme colors outside the intentional
      overlay scrims and the toggle knob (an on-device visual pass is still
      worthwhile)
- [ ] Motion for real events (file synced, device online) only — deferred:
      upload progress already animates through state updates, and broader motion
      needs a design pass rather than ad-hoc animation
- [x] Mobile unit tests for the pure projections added in Phase 2
      (`files/view.ts`, `activity/view.ts`)
- [x] Go tests for the Phase 3 changes (conflict choice, push handlers/service,
      hub offline hook); the Rust storage node needed no change
- [x] Updated `docs/design-port-plan.md` (mobile pointer), ADR-0003 addendum,
      the per-phase `CHANGELOG.md` entries, and this plan

---

## Risks & notes

- Native module additions (Phase 0: `react-native-svg`, `expo-font`) require a
  dev-build rebuild; bundle-only verification does not exercise them.
- The relay has **no account-wide activity endpoint**; Activity is device-local
  by design (same as web).
- The design's file previews are placeholders ("encrypted"); real previews
  require download + decrypt and are best-effort (Phase 2).
- Phase 3 touches `packages/protocol`, `services/relay`,
  `services/storage-node`, `packages/sdk` and both clients — keep it on a
  separate branch so protocol changes stay reviewable.
