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

The EAS project is linked (`extra.eas.projectId` in `apps/mobile/app.json`), so
`getExpoPushTokenAsync` resolves the project id from the app config. No env var
is required; `EXPO_PUBLIC_EAS_PROJECT_ID` remains an optional override.

**Android**
- The FCM V1 service-account key is uploaded to the EAS project (the *sending*
  credential, per Expo's FCM V1 docs). It lives in the credentials service, not
  the repo.
- `google-services.json` registers the app with FCM but is **not committed** —
  GitHub secret scanning flags its Firebase API key. It is gitignored and kept
  locally for `expo run:android`; EAS builds receive it through a project file
  environment variable named `GOOGLE_SERVICES_JSON_FILE` (created with
  `eas env:set … --type file`). `app.config.js` maps it onto
  `android.googleServicesFile`, falling back to the local file.

**iOS**
- APNs is not configured yet; it needs an Apple Developer account
  (`eas credentials` → iOS → log in to Apple, then generate/upload a push key).

Then rebuild the native app (`pnpm --filter mobile android`, or
`eas build --profile development`): `expo-notifications` and
`POST_NOTIFICATIONS` are native.

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

## CI

The `e2e` workflow injects push credentials from repository secrets into
`deploy/.env` before starting the stack, so no credential is ever committed:

```sh
gh secret set EXPO_PUSH_ACCESS_TOKEN --repo <owner>/<repo>
gh secret set VAPID_PUBLIC_KEY      --repo <owner>/<repo>   # optional
gh secret set VAPID_PRIVATE_KEY     --repo <owner>/<repo>   # optional
```

Unset secrets stay empty and simply disable that channel.

## Verifying

- Relay: `go test ./internal/push/ ./internal/hub/` and the integration tests in
  `internal/handler` (`TEST_DATABASE_URL` required).
- Without credentials you can still confirm registration end-to-end: the token /
  subscription rows appear in `push_tokens` / `web_push_subscriptions`, and the
  relay logs a send attempt.
