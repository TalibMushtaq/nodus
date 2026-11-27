# Deploying Nodus on a VM

This is the step-by-step runbook for deploying the full Nodus server — web app,
Relay, documentation, Redis, and Caddy — on one Ubuntu 24.04 VM.

Target topology:

```text
nodus.talibdar.tech        -> web app + /api BFF
relay.nodus.talibdar.tech  -> Relay (mobile, Storage Node, browser WebSocket)
doc.nodus.talibdar.tech    -> documentation
```

All three hostnames resolve to the same VM IP. Caddy routes each request by its
TLS SNI and HTTP `Host` header.

---

## 0. Before you start

You need:

- A VM running Ubuntu 24.04 (2 vCPU, 4 GB RAM, 40 GB+ disk recommended).
- The VM's public IPv4 address (and IPv6 if you want AAAA records).
- DNS access for `talibdar.tech`.
- SSH access to the VM.
- Ports `22`, `80`, and `443` reachable.

The repository is at `https://github.com/TalibMushtaq/nodus`.

---

## 1. Add DNS records

Create these records at your DNS provider:

| Type | Name          | Value              |
| ---- | ------------- | ------------------ |
| A    | `nodus`       | `<VM_PUBLIC_IPV4>` |
| A    | `relay.nodus` | `<VM_PUBLIC_IPV4>` |
| A    | `doc.nodus`   | `<VM_PUBLIC_IPV4>` |

Add matching `AAAA` records only if the VM has a public IPv6 address.

If you use Cloudflare, set these records to **DNS only / grey cloud** so Caddy
can complete Let's Encrypt HTTP-01 challenges. Do not enable the orange-cloud
proxy for the initial deployment.

Verify resolution from your machine:

```bash
dig +short nodus.talibdar.tech
dig +short relay.nodus.talibdar.tech
dig +short doc.nodus.talibdar.tech
```

All three should print the VM IP.

---

## 2. Prepare the VM

SSH in:

```bash
ssh <user>@<VM_PUBLIC_IPV4>
```

Update the system:

```bash
sudo apt-get update
sudo apt-get upgrade -y
```

### Add swap (recommended for builds)

The web and docs images build with Next.js. On a 4 GB VM, add 2 GB of swap so a
build does not get OOM-killed:

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Check it:

```bash
free -h
```

### Install Docker Engine and Compose

```bash
sudo apt-get install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Allow your user to run Docker without `sudo`, then log out and back in:

```bash
sudo usermod -aG docker "$USER"
exit
```

Reconnect and confirm:

```bash
docker --version
docker compose version
```

### Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw enable
sudo ufw status
```

If your VM provider has its own firewall/security group, open the same ports
there too.

---

## 3. Clone the repository

```bash
sudo mkdir -p /opt/nodus
sudo chown "$USER":"$USER" /opt/nodus
git clone https://github.com/TalibMushtaq/nodus.git /opt/nodus
cd /opt/nodus
```

---

## 4. Create the production environment file

```bash
cp deploy/.env.example deploy/.env
chmod 600 deploy/.env
nano deploy/.env
```

Set the production values:

```dotenv
WEB_HOST=nodus.talibdar.tech
RELAY_HOST=relay.nodus.talibdar.tech
DOCS_HOST=doc.nodus.talibdar.tech

PUBLIC_RELAY_URL=https://relay.nodus.talibdar.tech
NEXT_PUBLIC_RELAY_URL=https://relay.nodus.talibdar.tech
ALLOWED_ORIGINS=https://nodus.talibdar.tech
SESSION_COOKIE_SECURE=true
SESSION_COOKIE_DOMAIN=.nodus.talibdar.tech

REDIS_PASSWORD=<strong-url-safe-password>
BUFFER_TTL_HOURS=72
MAX_SHARD_BYTES_MB=32
```

Generate a URL-safe Redis password:

```bash
openssl rand -hex 32
```

Copy the output into `REDIS_PASSWORD`. It must not contain `@`, `:`, `/`, `#`,
or whitespace.

Push notifications are optional. Leave these empty to disable them:

```dotenv
EXPO_PUSH_ACCESS_TOKEN=
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:admin@example.com
NEXT_PUBLIC_VAPID_PUBLIC_KEY=
```

If you enable web push later, set both `VAPID_*` and
`NEXT_PUBLIC_VAPID_PUBLIC_KEY` and rebuild the web image.

---

## 5. Build and start the stack

```bash
cd /opt/nodus
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
```

This starts:

- `caddy` — TLS and hostname routing
- `web` — Next.js app on the internal network
- `relay` — Go Relay + SQLite
- `docs` — Next.js documentation
- `redis` — sessions, nonces, and fetch tokens

Check container health:

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env ps
```

All services should become `healthy`. Caddy may take a few seconds to obtain
the three certificates.

---

## 6. Verify the deployment

### DNS and TLS

```bash
curl -fsS https://relay.nodus.talibdar.tech/health
curl -fsS https://nodus.talibdar.tech/api/health
curl -fsSI https://doc.nodus.talibdar.tech
```

Expected:

- Relay health returns `{"status":"ok",...}`.
- Web health returns OK.
- Docs returns HTTP 200 with a valid certificate.

### Relay routing

`https://relay.nodus.talibdar.tech` must serve the Relay, not the web app:

```bash
curl -i https://relay.nodus.talibdar.tech/nodes
```

Expected: `401` with a JSON body when signed out, not an HTML page.

### Browser

1. Open `https://nodus.talibdar.tech`.
2. Register an account.
3. Confirm the sidebar reports a live Relay connection.
4. In browser devtools, the WebSocket should be
   `wss://relay.nodus.talibdar.tech/ws`.
5. The `nodus_session` cookie should show `Domain=nodus.talibdar.tech`.

### Storage Node

In the web app, open **Devices → Add Storage Node**, copy the pairing command,
and run it on the node machine:

```bash
nodus node pair --relay https://relay.nodus.talibdar.tech --code NODUS-XXXX-XXXX
```

### Mobile

Install the Android APK from
[GitHub Releases](https://github.com/TalibMushtaq/nodus/releases), then enter
`https://relay.nodus.talibdar.tech` as the Relay URL on first launch.

The web origin (`https://nodus.talibdar.tech`) is not the mobile server URL.

---

## 7. Logs and operations

Follow logs:

```bash
cd /opt/nodus
docker compose -f deploy/docker-compose.yml --env-file deploy/.env logs -f --tail=200
```

One service:

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env logs -f caddy
```

Restart a service:

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env restart relay
```

Stop the stack:

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env down
```

Remove volumes too (destroys SQLite data, Redis, and certificates):

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env down -v
```

---

## 8. Update the deployment

```bash
cd /opt/nodus
git pull
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
```

If you changed `NEXT_PUBLIC_RELAY_URL`, rebuild the web image explicitly:

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env build web
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d
```

Relay migrations run automatically on startup.

---

## 9. Back up the Relay database

The durable server state is the SQLite database in the `relay_data` volume.

```bash
cd /opt/nodus
docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec relay \
  sqlite3 /var/lib/nodus/relay.db "VACUUM INTO '/var/lib/nodus/backup.db'"
docker compose -f deploy/docker-compose.yml --env-file deploy/.env cp \
  relay:/var/lib/nodus/backup.db "./relay-backup-$(date +%F).db"
```

Copy the backup off the VM. Never `cp` a live `relay.db` directly — a copy taken
during writes can be corrupt.

Also back up `deploy/.env` securely.

---

## 10. Troubleshooting

### Certificate not issued / Caddy logs ACME errors

- Confirm all three DNS names resolve to the VM.
- Confirm ports 80 and 443 are open in both `ufw` and the provider firewall.
- Confirm the DNS records are **DNS-only** (no Cloudflare proxy).
- Check logs:

  ```bash
  docker compose -f deploy/docker-compose.yml --env-file deploy/.env logs caddy | tail -50
  ```

### `502 Bad Gateway` on the web app or docs

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env ps
docker compose -f deploy/docker-compose.yml --env-file deploy/.env logs web docs
```

A service that is still `starting` or `unhealthy` will make Caddy return 502.
Give the first build time to finish, or check for an OOM-killed build.

### WebSocket rejected / immediately disconnects

- `ALLOWED_ORIGINS` must be exactly `https://nodus.talibdar.tech`.
- `SESSION_COOKIE_DOMAIN` must be `.nodus.talibdar.tech`.
- `SESSION_COOKIE_SECURE` must be `true`.
- `NEXT_PUBLIC_RELAY_URL` must be `https://relay.nodus.talibdar.tech`, and the
  web image must be rebuilt after changing it.
- Check the Relay log for `[ws] rejected cross-origin`.

### Mobile or Storage Node cannot connect

- Use `https://relay.nodus.talibdar.tech`, not the web host.
- Plain `http://` is refused for remote hosts; the certificate must be valid.

### Build runs out of memory

Confirm swap is active:

```bash
free -h
```

If builds still fail, build on a larger machine or use a registry-based deploy.

### Port 80/443 already in use

Stop any existing nginx/apache/Caddy service:

```bash
sudo systemctl stop nginx apache2 caddy 2>/dev/null || true
sudo systemctl disable nginx apache2 caddy 2>/dev/null || true
```

---

## 11. Security checklist

- Set `chmod 600 deploy/.env` and never commit it.
- Use a long, random, URL-safe `REDIS_PASSWORD`.
- Open only `22`, `80`, and `443`.
- Prefer SSH keys and disable password SSH login.
- Keep the VM patched (`sudo apt-get update && sudo apt-get upgrade`).
- Back up the Relay SQLite database off the VM.
- Run exactly one Relay replica; SQLite is process-locked.

For the architecture and configuration details behind this runbook, see
[`deploy/README.md`](../deploy/README.md) and
[Self-hosting overview](../apps/docs/content/docs/self-hosting/overview.mdx).
