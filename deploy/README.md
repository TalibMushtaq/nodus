# Deploying the Nodus server unit

One VM runs Caddy in front of four containers: the Next.js web app, the Go
Relay, the Fumadocs site, and Redis. The Relay and web app share a SQLite
database and a shard buffer; there is no PostgreSQL.

Production uses three origins on the same machine:

```
Caddy (:80/:443)
  ├─ nodus.talibdar.tech        -> web:3000    (UI + same-origin /api BFF)
  ├─ relay.nodus.talibdar.tech  -> relay:8080  (WS, auth, pairing, buffer)
  └─ doc.nodus.talibdar.tech    -> docs:3001   (documentation)
```

Storage Nodes and the mobile app talk to the Relay origin directly. The browser
loads the web app from `WEB_HOST`, calls its BFF under `/api/*`, and opens the
Relay WebSocket at `NEXT_PUBLIC_RELAY_URL`. The BFF still reaches the Relay
internally over `RELAY_URL=http://relay:8080`, so the internal address never
reaches a client bundle.

A `http://localhost` block in `deploy/Caddyfile` preserves the original
single-origin routing for `docker compose up` and the e2e harness.

## Requirements

- Docker Engine + Compose v2
- A host/domain and ports 80/443 reachable
- DNS `A`/`AAAA` records for the three hostnames

## Quickstart (local / HTTP)

```bash
cp deploy/.env.example deploy/.env
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up --build -d
curl -fsS http://localhost/health        # -> {"status":"ok",...}
curl -fsS http://localhost/api/health
```

Open http://localhost, register an account, then Devices → "+ Add Storage Node"
and run the printed command on a Storage Node:

```bash
nodus node pair --relay http://localhost --code NODUS-XXXX-XXXX
```

The local defaults in `.env.example` use `http://localhost` for
`PUBLIC_RELAY_URL` and `NEXT_PUBLIC_RELAY_URL`, so the browser keeps using the
same-origin `/ws` path.

## Production

1. Point DNS at the VM:

   ```text
   nodus.talibdar.tech        A/AAAA  <VM_IP>
   relay.nodus.talibdar.tech  A/AAAA  <VM_IP>
   doc.nodus.talibdar.tech    A/AAAA  <VM_IP>
   ```

   Keep the records DNS-only (no proxy) so Caddy can complete Let's Encrypt
   HTTP-01 challenges on port 80.

2. In `deploy/.env`:

   ```dotenv
   WEB_HOST=nodus.talibdar.tech
   RELAY_HOST=relay.nodus.talibdar.tech
   DOCS_HOST=doc.nodus.talibdar.tech

   PUBLIC_RELAY_URL=https://relay.nodus.talibdar.tech
   NEXT_PUBLIC_RELAY_URL=https://relay.nodus.talibdar.tech
   ALLOWED_ORIGINS=https://nodus.talibdar.tech
   SESSION_COOKIE_SECURE=true
   SESSION_COOKIE_DOMAIN=.nodus.talibdar.tech
   REDIS_PASSWORD=<strong-url-safe-secret>
   ```

   `REDIS_PASSWORD` is required: Compose refuses to start without it. It must be
   URL-safe (no `@`, `:`, `/`, `#` or whitespace) because it is interpolated into
   `REDIS_URL` without encoding.

   `NEXT_PUBLIC_RELAY_URL` is inlined into the browser bundle at build time.
   Changing it requires rebuilding the web image:

   ```bash
   docker compose -f deploy/docker-compose.yml --env-file deploy/.env build web
   ```

3. Start the unit:

   ```bash
   docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
   ```

Caddy obtains and renews a certificate for each host automatically. The
certificates survive restarts in the `caddy_data` volume.

## Verification

```bash
# Container health
docker compose -f deploy/docker-compose.yml --env-file deploy/.env ps

# Relay and web health
curl -fsS https://relay.nodus.talibdar.tech/health
curl -fsS https://nodus.talibdar.tech/api/health

# Pages and certificates
curl -fsSI https://nodus.talibdar.tech
curl -fsSI https://doc.nodus.talibdar.tech
```

Then in a browser:

1. Open `https://nodus.talibdar.tech` and sign in.
2. Confirm the sidebar reports a live Relay connection. Browser devtools should
   show `wss://relay.nodus.talibdar.tech/ws`.
3. Confirm the session cookie has `Domain=nodus.talibdar.tech` (Go may omit the
   leading dot).
4. Open `https://doc.nodus.talibdar.tech` and check search/navigation.

If the WebSocket is rejected, check `ALLOWED_ORIGINS` and the Relay logs:

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env logs relay | grep -i origin
```

## Cookie and origin rules

- `ALLOWED_ORIGINS` must exactly match the browser origin, including scheme and
  port (`https://nodus.talibdar.tech`).
- `SESSION_COOKIE_DOMAIN` must be the parent domain shared by the web and Relay
  hosts (`.nodus.talibdar.tech`), or the browser will not send the session
  cookie to the WebSocket host.
- `SESSION_COOKIE_SECURE=true` is required in production; browsers reject
  `Secure` cookies on plain HTTP.
- `TRUST_PROXY` is pinned to `"true"` in Compose because Caddy is the Relay's
  immediate peer. Do not enable it if the Relay is directly reachable.

## Operations

- **Logs:**
  ```bash
  docker compose -f deploy/docker-compose.yml --env-file deploy/.env logs -f --tail=200
  ```
- **Update:**
  ```bash
  git pull
  docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
  ```
- **Restart one service:**
  ```bash
  docker compose -f deploy/docker-compose.yml --env-file deploy/.env restart relay
  ```
- **Teardown:** `docker compose ... down` (add `-v` to wipe Redis, Relay data,
  and Caddy certificates — destructive).
- Run **exactly one relay replica**: its SQLite file is locked by the process.
- Migrations run automatically when the Relay starts.

## Backups

The `relay_data` volume holds the SQLite database (`/var/lib/nodus/relay.db`),
which is all durable Relay state. Redis and the shard buffer are transient.

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec relay \
  sqlite3 /var/lib/nodus/relay.db "VACUUM INTO '/var/lib/nodus/backup.db'"
```

Copy the backup off the VM. **Never `cp` a live database file** — a copy taken
while writes are in flight can be corrupt. Restore by stopping the Relay,
replacing the database (with its `-wal`/`-shm` sidecars removed), and starting
it again.

Also back up `deploy/.env` securely; it contains the Redis password and any push
credentials.

## Verifying the routing by hand

```bash
# Relay host: JSON/API only
curl -fsS https://relay.nodus.talibdar.tech/health
curl -i https://relay.nodus.talibdar.tech/nodes              # 401 JSON when signed out

# Web host: pages and BFF
curl -fsS https://nodus.talibdar.tech/api/health
curl -i https://nodus.talibdar.tech/devices                  # HTML; redirects to /auth

# Docs host
curl -fsSI https://doc.nodus.talibdar.tech
```
