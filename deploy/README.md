# Deploying the Nodus server unit

One public origin serving the Next.js web app and the Go Relay, backed by
PostgreSQL and Redis, fronted by Caddy (TLS + routing). Storage Nodes are
separate machines that connect to this origin — never to an internal address.

```
Caddy (:80/:443)
  ├─ /ws, /buffer/*, /pairing/codes/redeem,
  │  /pairing/sessions/verify, /nodes/verify, /health  -> relay:8080
  └─ everything else (incl. /api/* and all pages)       -> web:3000
```

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
   POSTGRES_PASSWORD=<strong-secret>
   ```
3. `docker compose -f deploy/docker-compose.yml --env-file deploy/.env up --build -d`

Caddy obtains/renews the certificate automatically. The Relay's `ALLOWED_ORIGINS`
must exactly match the browser origin (scheme + host + port) or WebSocket
authentication is rejected.

> `NEXT_PUBLIC_RELAY_URL` is intentionally left unset: the browser uses this
> origin's `/ws`. Set it only for split deployments where the web app and Relay
> run on different origins.

## Operations

- **Logs:** `docker compose -f deploy/docker-compose.yml logs -f relay web caddy`
- **Update:** `git pull && docker compose -f deploy/docker-compose.yml --env-file deploy/.env up --build -d`
- **Torndown:** `docker compose -f deploy/docker-compose.yml down` (add `-v` to
  wipe Postgres/Redis/buffer/Caddy volumes — destructive).
- **Backups:** the `postgres_data` volume holds all durable state; the Relay
  buffer and Redis are transient.
- Migrations run automatically when the Relay starts.

## Verifying the routing by hand

```bash
# Relay-owned (proxied straight through):
curl -fsS http://localhost/health
curl -i -X POST http://localhost/pairing/codes/redeem -H 'content-type: application/json' -d '{}'

# Next-owned:
curl -fsS http://localhost/api/health
curl -i http://localhost/devices    # redirects to /auth when signed out
```
