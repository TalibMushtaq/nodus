# Installing Nodus

Nodus has three installable pieces. Most people only need the first two: the
Android app and a Storage Node. The server unit is for self-hosters.

| What you are installing   | Who it is for                      | Where it comes from           |
| ------------------------- | ---------------------------------- | ----------------------------- |
| Android app               | Phones and tablets                 | GitHub Releases (`mobile-v*`) |
| Storage Node (`nodus`)    | The machine that stores your files | GitHub Releases (`node-v*`)   |
| Server unit (Relay + web) | Self-hosters                       | Docker Compose in this repo   |

Every release asset ships with a SHA-256 file. Verify it before installing anything.

---

## Android app

### Requirements

- Android 7.0 (API 24) or newer.
- About 140 MB of free space for the universal APK.
- A reachable Nodus server. Remote servers must use `https://`; plain `http://`
  is accepted only for `localhost` and the Android emulator alias `10.0.2.2`.

### Download

Open the [releases page](https://github.com/TalibMushtaq/nodus/releases) and
choose the newest `mobile-v*` release. The current release is
[`mobile-v1.0.0`](https://github.com/TalibMushtaq/nodus/releases/tag/mobile-v1.0.0).

Download both files:

- `nodus-mobile-v1.0.0.apk`
- `nodus-mobile-v1.0.0.apk.sha256`

Direct links:

```text
https://github.com/TalibMushtaq/nodus/releases/download/mobile-v1.0.0/nodus-mobile-v1.0.0.apk
https://github.com/TalibMushtaq/nodus/releases/download/mobile-v1.0.0/nodus-mobile-v1.0.0.apk.sha256
```

### Verify the checksum (recommended)

On Linux:

```bash
sha256sum -c nodus-mobile-v1.0.0.apk.sha256
```

On macOS:

```bash
shasum -a 256 -c nodus-mobile-v1.0.0.apk.sha256
```

The output must end in `OK`. Do not install the APK if it reports `FAILED`.

### Sideload the APK

1. Copy the APK to the device (downloading it directly on the phone is easiest).
2. Open the file from your browser's download notification or a file manager.
3. If Android blocks the install, allow **Install unknown apps** for the app
   that is opening the APK (browser, Files, or your file manager), then try
   again.
4. Play Protect may show a warning because the APK was not installed from Play.
   Choose **Install anyway**.
5. Open Nodus.

If the installer says **App not installed**, an older Nodus build with a
different signing key is probably still installed. Uninstall the old app first.
That removes local sessions and preferences; your server-side data is not
affected, but you will sign in and pair again.

> **Note:** Release APKs are currently signed with the Android development
> keystore. They are intended for sideloading and testing, not Play Store
> distribution.

### First launch

1. Enter the **Relay URL** shown by your administrator, for example
   `https://relay.nodus.example.com`. The URL is stored in the OS secure storage.
2. Create an account or sign in.
3. Open **Devices → Pair a device**.
   - To add a new storage node, tap **Create pairing code**, then run the shown
     `nodus node pair ...` command on the node machine.
   - To connect to an existing node, tap **Load my nodes** and select it, then
     finish the local pairing prompt.
4. Allow the permission prompts Nodus asks for:
   - **Notifications** (optional, for transfer and conflict alerts).
   - **Nearby Wi-Fi devices** (Android 13+) so mDNS can find the node on the LAN.

You can change the server later under **Settings → Server**. Changing it signs
you out of the previous server.

### Updating

Install the newer APK over the existing app; app data is normally preserved.
If Android reports a signature mismatch, uninstall the old build first and sign
in again. There is no in-app updater.

### Troubleshooting

| Symptom              | Likely cause                                                    | Fix                                                                    |
| -------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `App not installed`  | Signature mismatch with an existing build                       | Uninstall the old Nodus app, then install again                        |
| Install blocked      | Unknown-app installation is disabled                            | Allow it for the browser/file manager opening the APK                  |
| Play Protect warning | APK is not from Play                                            | Choose **Install anyway**                                              |
| `Invalid server URL` | Remote URL is plain HTTP or malformed                           | Use `https://host` (HTTP is allowed only for loopback/emulator)        |
| Node never appears   | Phone and node are not on the same LAN, or multicast is blocked | Check Wi-Fi, allow **Nearby devices**, and use **Load my nodes** again |
| Checksum fails       | Incomplete or tampered download                                 | Delete the APK and download it again                                   |

---

## Storage Node

The Storage Node is a single Rust binary named `nodus`. It holds the SQLite
catalogue and encrypted shard store. Prebuilt binaries currently target Linux
x86_64.

### Requirements

- Linux x86_64.
- A data directory with enough free space for your backups.
- Network access to the Nodus server.
- `curl`, `tar`, and `sha256sum` for the installer.

### Install the binary

```bash
curl -fsSL https://raw.githubusercontent.com/TalibMushtaq/nodus/main/scripts/install-node.sh | sh
```

This installs `nodus` to `~/.local/bin` by default, verifies the release
checksum, and refuses to continue on unsupported platforms. Useful options:

```bash
# Install a specific release
curl -fsSL https://raw.githubusercontent.com/TalibMushtaq/nodus/main/scripts/install-node.sh | sh -s -- --version 0.1.0

# Install system-wide (the installer itself does not use sudo)
curl -fsSL https://raw.githubusercontent.com/TalibMushtaq/nodus/main/scripts/install-node.sh | sudo sh -s -- --dir /usr/local/bin
```

You can also set `NODUS_VERSION` and `NODUS_INSTALL_DIR` instead of passing
flags.

Confirm the install:

```bash
nodus --version
```

### Install manually

Download `nodus-node-vX.Y.Z-x86_64-unknown-linux-musl.tar.gz` and its
`.sha256` file from the [releases page](https://github.com/TalibMushtaq/nodus/releases),
then:

```bash
sha256sum -c nodus-node-v0.1.0-x86_64-unknown-linux-musl.tar.gz.sha256
tar -xzf nodus-node-v0.1.0-x86_64-unknown-linux-musl.tar.gz
sudo install -m 0755 nodus-node-v0.1.0-x86_64-unknown-linux-musl/nodus /usr/local/bin/nodus
```

### First run and pairing

On a terminal, a bare `nodus` opens the interactive setup:

```bash
nodus
```

It prompts for the data directory (default `~/NodusBackup`), the Relay URL, and
a pairing code. Mint the code in the web app under **Devices → Add Storage
Node**, or in the mobile app under **Devices → Pair a device → Create pairing
code**.

Non-interactive pairing:

```bash
nodus node pair --relay https://relay.nodus.example.com --code NODUS-XXXX-XXXX
```

Start the daemon without the menu:

```bash
nodus node start
```

Data lives in the selected data directory (`nodus.db`, `objects/`, `temp/`) and
in `~/.nodus/` (`config.toml`, `identity/`).

### Run as a systemd service

The unit below assumes a system-wide install (`--dir /usr/local/bin`). Create a
dedicated user and data directory:

```bash
sudo useradd --system --home /var/lib/nodus --shell /usr/sbin/nologin nodus
sudo mkdir -p /var/lib/nodus
sudo chown nodus:nodus /var/lib/nodus
```

Pair once as that user so `config.toml` and the node identity exist:

```bash
sudo -u nodus /usr/local/bin/nodus node pair \
  --data-dir /var/lib/nodus \
  --relay https://relay.nodus.example.com \
  --code NODUS-XXXX-XXXX
```

On success the command continues into the daemon. Press Ctrl+C once the node is
paired, then let systemd own the process.

`/etc/systemd/system/nodus.service`:

```ini
[Unit]
Description=Nodus Storage Node
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=nodus
Group=nodus
Environment=NODUS_DATA_DIR=/var/lib/nodus
ExecStart=/usr/local/bin/nodus node start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Enable and start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now nodus
sudo journalctl -u nodus -f
```

### Updating

Install the newer release and restart the service:

```bash
# Replace <version> with the release you want, e.g. 0.2.0
curl -fsSL https://raw.githubusercontent.com/TalibMushtaq/nodus/main/scripts/install-node.sh | sh -s -- --version <version>
sudo systemctl restart nodus
```

The node applies its SQLite migrations on boot. Existing objects and metadata
remain valid across upgrades.

---

## Self-hosted server (Relay + web)

The server unit runs the Go Relay, the Next.js web app, SQLite, Redis, and
Caddy behind one public origin.

### Requirements

- Docker Engine with Compose v2.
- Three hostnames (web, relay, docs) and ports 80/443.
- `PUBLIC_RELAY_URL` set to the exact public Relay origin.

### Quickstart (local HTTP)

```bash
cp deploy/.env.example deploy/.env
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up --build -d
curl -fsS http://localhost/health
```

Open `http://localhost`, register an account, then add a Storage Node under
**Devices → Add Storage Node** and run the printed pairing command on the node.

### Production

The production unit serves the web app, Relay, and documentation on three
hostnames:

```text
nodus.talibdar.tech        -> web app
relay.nodus.talibdar.tech  -> Relay (mobile, Storage Node, browser WebSocket)
doc.nodus.talibdar.tech    -> documentation
```

1. Create `A`/`AAAA` records for all three hostnames. Keep them DNS-only (no
   proxy) so Caddy can obtain Let's Encrypt certificates.
2. Edit `deploy/.env`:

   ```dotenv
   WEB_HOST=nodus.talibdar.tech
   RELAY_HOST=relay.nodus.talibdar.tech
   DOCS_HOST=doc.nodus.talibdar.tech

   PUBLIC_RELAY_URL=https://relay.nodus.talibdar.tech
   NEXT_PUBLIC_RELAY_URL=https://relay.nodus.talibdar.tech
   ALLOWED_ORIGINS=https://nodus.talibdar.tech
   SESSION_COOKIE_SECURE=true
   SESSION_COOKIE_DOMAIN=.nodus.talibdar.tech
   REDIS_PASSWORD=<url-safe-secret>
   ```

   `REDIS_PASSWORD` is required. It must be URL-safe: no `@`, `:`, `/`, `#`, or
   whitespace.

3. Start the unit:

   ```bash
   docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
   ```

Caddy obtains and renews TLS automatically. `ALLOWED_ORIGINS` must exactly match
the browser origin, including scheme and port, or WebSocket authentication is
rejected. `SESSION_COOKIE_DOMAIN` lets the browser send the same session cookie
to the Relay subdomain.

The Android app and Storage Nodes use `https://relay.nodus.talibdar.tech` as
their server URL. The web app is opened at `https://nodus.talibdar.tech`, and
the documentation is at `https://doc.nodus.talibdar.tech`.

### Updating

```bash
git pull
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up --build -d
```

Relay migrations are embedded in the binary and run automatically on startup.

See [`deploy/README.md`](../deploy/README.md) for Caddy routing, volumes,
backups, and operations.

---

## Build from source

For development only. The installable releases above do not need a toolchain.

```bash
pnpm install
make install-hooks

# Web
pnpm --filter web dev

# Storage Node
(cd services/storage-node && cargo build --release && ./target/release/nodus)

# Android (requires Android Studio/SDK)
(cd apps/mobile && pnpm exec expo prebuild --platform android && pnpm run android)
```

Native mobile builds need a custom development build; Expo Go cannot load the
mDNS or WebRTC modules. See `apps/docs/content/docs/mobile/install.mdx` for the
full native/EAS guide.

---

## Related documentation

- [Storage Node CLI reference](../apps/docs/content/docs/reference/cli.mdx)
- [Storage Node operations](../apps/docs/content/docs/self-hosting/storage-node-operations.mdx)
- [Mobile install and build](../apps/docs/content/docs/mobile/install.mdx)
- [Self-hosting overview](../apps/docs/content/docs/self-hosting/overview.mdx)
- [Security model](../apps/docs/content/docs/guides/security.mdx)
