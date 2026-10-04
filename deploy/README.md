# Deploying the Nodus server unit

One public origin serving the Next.js web app and the Go Relay, backed by a
local SQLite database and Redis, fronted by Caddy (TLS + routing). Storage Nodes
are separate machines that connect to this origin — never to an internal address.

```
Caddy (:80/:443)
  ├─ /ws, /health, /rebuild                              -> relay:8080
  ├─ /auth/*, /devices/*, /nodes*, /pairing/*, /buffer/* -> relay:8080
  └─ everything else (incl. /devices page, /auth page,
     /api/* and all other pages)                         -> web:3000
```

The Relay owns every path a non-browser client (the Storage Node CLI, the
mobile app) calls directly, so all of them work through the single origin. Two
paths are deliberately served by Next.js because they are *pages*: bare
`/devices` and bare `/auth`. The Relay's device list is reached through Next's
`/api/devices` handler, and login/registration through `/api/auth/*`.

Next's route handlers reach the Relay internally over `RELAY_URL=http://relay:8080`,
so the browser only ever talks to the single origin.

## Requirements

- Docker Engine + Compose v2
- A host/domain (production) and ports 80/443
- `PUBLIC_RELAY_URL` set to the exact public origin

## Quickstart (local / HTTP)

```bash
cp deploy/.env.example deploy/.env
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up --build -d
curl -fsS http://localhost/health        # -> {"status":"ok",...}
```

Open http://localhost, register an account, then Devices → "+ Add Storage Node"
and run the printed command on a Storage Node:

```bash
nodus node pair --relay http://localhost --code NODUS-XXXX-XXXX
```

## Production

1. Point a DNS A/AAAA record at the host.
2. In `deploy/.env`:
   ```
   SITE_ADDRESS=nodus.example.com
   PUBLIC_RELAY_URL=https://nodus.example.com
   ALLOWED_ORIGINS=https://nodus.example.com
   SESSION_COOKIE_SECURE=true
   REDIS_PASSWORD=<strong-secret>
   ```
   `REDIS_PASSWORD` is required: `docker compose up` refuses to start without it
   rather than falling back to a default. It must be URL-safe (no `@`, `:`, `/`,
   `#` or whitespace) because compose interpolates it into `REDIS_URL` without
   encoding. There is no database password: the relay uses a local SQLite file.
3. `docker compose -f deploy/docker-compose.yml --env-file deploy/.env up --build -d`

Caddy obtains/renews the certificate automatically. The Relay's `ALLOWED_ORIGINS`
must exactly match the browser origin (scheme + host + port) or WebSocket
authentication is rejected. In local HTTP runs the defaults allow both
`http://localhost` and `http://127.0.0.1`, but always open the site at the same
host you put in `PUBLIC_RELAY_URL`/`ALLOWED_ORIGINS`.

> `NEXT_PUBLIC_RELAY_URL` is intentionally left unset: the browser uses this
> origin's `/ws`. Set it only for split deployments where the web app and Relay
> run on different origins.

## Operations

- **Logs:** `docker compose -f deploy/docker-compose.yml logs -f relay web caddy`
- **Update:** `git pull && docker compose -f deploy/docker-compose.yml --env-file deploy/.env up --build -d`
- **Teardown:** `docker compose -f deploy/docker-compose.yml down` (add `-v` to
  wipe the Redis, relay (database + buffer), and Caddy volumes — destructive).
- **Backups:** the `relay_data` volume holds the SQLite database
  (`/var/lib/nodus/relay.db`), which is all durable state; the buffer and Redis
  are transient. Back it up with `VACUUM INTO 'backup.db'`, the SQLite backup
  API, or Litestream. **Never `cp` a live database file** — a copy taken while
  writes are in flight can be corrupt. Restore by stopping the relay, replacing
  the file (with its `-wal`/`-shm` sidecars removed), and starting it again.
- Run **exactly one relay replica**: the database file is locked by the process.
- Migrations run automatically when the Relay starts.

## Verifying the routing by hand

```bash
# Relay-owned (proxied straight through):
curl -fsS http://localhost/health
curl -i -X POST http://localhost/pairing/codes/redeem -H 'content-type: application/json' -d '{}'
curl -i -X POST http://localhost/auth/login -H 'content-type: application/json' -d '{}'  # JSON 4xx, not an HTML page
curl -i http://localhost/nodes                                                            # 401 JSON when signed out

# Next-owned:
curl -fsS http://localhost/api/health
curl -i http://localhost/devices    # HTML page; redirects to /auth when signed out
```
