# Push Notifications

Nodus delivers three account notifications — **conflict flagged**, **storage
node offline**, and **backup complete** — over two channels:

| Channel | Recipient store | Transport |
| --- | --- | --- |
| Mobile | `push_tokens` (Expo token per device) | Expo Push API |
| Web | `web_push_subscriptions` (per browser endpoint) | Web Push (VAPID) |

Both channels honour the same per-category opt-outs, and every payload is
generic — file names are encrypted (ADR-0001), so a notification never contains
a decrypted name.

The feature is entirely optional: with no tokens/subscriptions registered and no
credentials configured, the relay logs nothing and sends nothing.

## Relay configuration

Set these on the relay (see `deploy/.env.example`):

| Variable | Purpose |
| --- | --- |
| `EXPO_PUSH_ACCESS_TOKEN` | Expo access token for mobile delivery. Optional at low volume; required in production. |
| `VAPID_PUBLIC_KEY` | VAPID public key for Web Push. |
| `VAPID_PRIVATE_KEY` | VAPID private key. |
| `VAPID_SUBJECT` | `mailto:` (or URL) contact in the VAPID JWT. |

Browser push is **disabled** unless both VAPID keys are set.

Generate a VAPID key pair:

```sh
npx web-push generate-vapid-keys
```

## Mobile (Expo)

1. Set `EXPO_PUBLIC_EAS_PROJECT_ID` in `apps/mobile/.env` to the EAS project id
   (expo.dev → Project → Project ID). Without it the client skips registration
   and the app otherwise works normally.
2. Configure APNs/FCM credentials on the Expo project (EAS handles this via
   `eas credentials` for development and production builds).
3. Rebuild the native app (`pnpm --filter mobile android` / `ios`): the
   `expo-notifications` module and the `POST_NOTIFICATIONS` permission are
   native.

The client requests permission on first sign-in, registers the Expo token with
`POST /devices/push-token` (mirroring the notification prefs), refreshes it when
a pref changes, and removes it on sign-out. Tapping a notification opens the
Activity tab.

## Web

1. Set `NEXT_PUBLIC_VAPID_PUBLIC_KEY` in the web app (same public key as the
   relay; see `apps/web/.env.example`).
2. Users opt in from **Settings → Notifications → Enable**. The browser
   registers `/sw.js`, subscribes via `PushManager`, and posts the subscription
   to `/api/push/subscribe` (a session-cookie proxy to the relay).
3. Web Push requires a **secure context**: HTTPS in production, or `localhost`
   in development. A plain-HTTP LAN origin will not offer `PushManager`.

## Trigger behaviour

- **Conflict flagged** — after any event batch that can flag a version, the
  relay announces each newly-conflicted file once (`conflict_notices`); a
  resolution clears the notice so a later conflict re-alerts.
- **Storage node offline** — fired when a node's last WebSocket connection
  closes. Client devices are deliberately excluded (they reconnect/background
  constantly).
- **Backup complete** — fired once when every shard of a file version reaches
  `NODE_STORED` (`sync_notices`).

## Verifying

- Relay: `go test ./internal/push/ ./internal/hub/` and the integration tests in
  `internal/handler` (`TEST_DATABASE_URL` required).
- Without credentials you can still confirm registration end-to-end: the token /
  subscription rows appear in `push_tokens` / `web_push_subscriptions`, and the
  relay logs a send attempt.
