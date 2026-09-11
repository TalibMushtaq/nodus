# Bootstrap Pairing Migration — Session Tracker

Self-hosted Storage Node **first-time pairing via pairing code**. Tracks the work
across multiple sessions so any session can be picked up where the last left off.

> Mirror of `Todo.md` **Phase 7b** and `nodus_implementation_plan.md` **§3b, §7b,
> §7c** (stage 7b in §28). The plan is the source of truth for *why*; this file
> is the *how far along are we* tracker.

---

## Status

- **Current session:** S9 (next)
- **Blocked on:** nothing
- **Done sessions:** S1, S2, S3, S4, S5, S6, S7, S8

Update the marker above and the Session Log at the bottom whenever you finish a
session. Mark a task `[~]` while in progress, `[x]` when complete.

## How to use

1. Start at the current session. Read its **Goal** and skim the linked plan
   sections before writing code.
2. Work the tasks; check them off as you go.
3. Meet the session's **Exit criteria** (run the verification commands) before
   moving on.
4. Update the **Status** marker and **Session Log**, then start the next session.
5. Never skip the **Non-negotiables** (below) to make a session "faster".

## Quick references

| Thing | Command / path |
|---|---|
| Full test suite | `pnpm test` |
| TypeScript only | `pnpm test:ts` (turbo) |
| Go Relay only | `go -C services/relay test ./...` |
| Rust node only | `cargo test --manifest-path services/storage-node/Cargo.toml` |
| Lint / types | `pnpm lint` / `pnpm check-types` |
| Relay migrations (auto-run at boot) | add `009_pairing_codes.up.sql` / `.down.sql` to `services/relay/internal/db/migrations/` |
| Rust migrations (auto-run at boot) | `services/storage-node/migrations/*.sql` |

---

## Sessions

### S1 — Relay: pairing-code schema + generation endpoint

**Goal:** Add migration `009_pairing_codes` and the authenticated
`POST /pairing/codes` endpoint that mints codes.

Tasks:

- [x] Migration `009_pairing_codes.up.sql`: table `pairing_codes` (`code_hash`
      TEXT PK, `account_id` TEXT NOT NULL REFERENCES accounts, `status` TEXT
      DEFAULT 'PENDING', `node_id` TEXT REFERENCES storage_nodes, `created_at` /
      `expires_at` / `consumed_at` timestamptz) + `idx_pairing_codes_account`.
      Exact DDL: plan §7b "Database". Only the SHA-256 hash is ever stored.
- [x] `009_pairing_codes.down.sql` dropping the table + index.
- [x] Code generator util (CSPRNG via `crypto/rand`): format `NODUS-XXXX-XXXX`,
      alphabet A-Z minus I/O + 2-9 (plan §7b "Properties").
- [x] `internal/handler/pairing_codes.go` — `POST /pairing/codes` behind
      `RequireAuth`: mint code, hash, insert `PENDING` row (15-min `expires_at`),
      return `{ code, expires_at }`. Plaintext never logged.
- [x] Register the route in `services/relay/main.go`.
- [x] Go unit tests: full 32-char alphabet (A-Z minus I/O + 2-9), shape
      `NODUS-XXXX-XXXX`, header format validation, expiry column set, hash-only
      storage (assert DB row never equals the plaintext).

**Exit criteria:** new migration applies cleanly at boot (watch for
`ErrNoChange`/errors); generation returns well-formed codes; handler tests pass.
Run: `go -C services/relay test ./...`

### S2 — Relay: redemption + storage_nodes registration

**Goal:** Add the open `POST /pairing/codes/redeem` endpoint that atomically
consumes a code and registers the node under the issuing account.

Tasks:

- [x] Normalize+hash inbound code; look up `PENDING` row.
- [x] Failure responses (machine-readable body + sensible HTTP status): `code_unknown`
      (404) / `code_expired` (410) / `code_revoked` (410) / `code_consumed` (409) /
      `node_owned_elsewhere` (409); 429 while rate-limited. Plan §7b "API".
      (`node_claimed` de-scoped: same-account re-registration is idempotent.)
- [x] Validate `node_id` (lenient bounds: non-empty, ≤128 printable ASCII) +
      `public_key` shape (hex-encoded Ed25519, 32 bytes).
- [x] Atomic single-use consume: conditional `UPDATE ... SET status='CONSUMED',
      consumed_at=NOW() WHERE code_hash=$1 AND status='PENDING' AND
      expires_at > NOW()`; rowcount 0 ⇒ re-read to distinguish expired vs consumed.
- [x] Upsert into `storage_nodes` bound to the issuing account, **reusing the
      existing first-node/`is_primary` logic** in `internal/handler/node.go`.
      Consume + upsert share **one transaction**, so a node owned by another
      account ⇒ `node_owned_elsewhere` rolls back and never burns the code
      (accounts never move).
- [x] Per-IP rate limiter (in-process, mirroring the Rust NonceStore/RateLimiter
      pattern) on the redeem endpoint; keys on the client IP (port stripped,
      `TRUST_PROXY`-gated `X-Forwarded-For` behind the TLS reverse proxy).
- [x] Register route in `main.go`.
- [x] Go unit tests: happy path returns `{status:"ok", account_id}`; concurrent
      double-redeem ⇒ exactly one winner; expired/unknown/revoked/consumed/
      owned-elsewhere cases; rejected registration leaves the code `PENDING`;
      `is_primary` on first node and NOT set on second; rate-limit trigger;
      client-IP resolution.

**Exit criteria:** redemption is atomic (no double-claim under concurrency; a
rejected registration does not consume the code), all failure modes return the
documented reasons, first-node `is_primary` reused.
Run: `go -C services/relay test ./...`

### S3 — Relay: unpaired-node auth reason + integration verification

**Goal:** Pairing is discoverable from the node's existing auth path and the full
Go suite stays green.

Tasks:

- [x] Add optional machine-readable `reason` (e.g. `"node_not_found"`) to
      `NodeAuthResultPayload` in `packages/protocol` (and its Go + TS consumers)
      when the node is unknown/inactive. Plan §7b "Unpaired-node UX".
- [x] Set it in the node-auth handler (`internal/handler/sync.go` / wherever
      `node_auth_result` is produced); keep the retry behavior for paired nodes
      unchanged.
- [x] Verify Rust challenge-response auth is untouched by the new endpoints.
- [x] Full Go + TS protocol suite green after the `NodeAuthResultPayload` change.

**Exit criteria:** an unregistered node hitting `/ws` receives a machine-readable
`node_not_found` reason; existing node auth tests pass.
Run: `go -C services/relay test ./...` and `pnpm test:ts`

### S4 — Rust: `node` CLI subgroup + config precedence

**Goal:** `nodus node start` / `nodus node pair` plumbing with the locked URL
precedence; no more localhost default.

Tasks:

- [x] Add `node` CLI subgroup in `services/storage-node/src/main.rs`
      (`node start`, `node pair`); existing root flags (`--data-dir`,
      `--force-adopt`) still boot the daemon as-is.
- [x] `relay_url` key added to `NodusConfigFile`; write/read in
      `src/config/mod.rs` (config.toml gains `relay_url` alongside `data_dir`).
- [x] URL resolution precedence: CLI `--relay` > `config.toml` `relay_url` >
      `NODUS_RELAY_URL` > **no default** (never localhost/127.0.0.1 for
      first-run pairing). Plan §7c.
- [x] Remove the `NODUS_RELAY_URL` → `ws://127.0.0.1:8080/ws` fallback in main.rs
      (the boot path must use the same precedence).
- [x] Rust tests: precedence order, empty-everything ⇒ error (not localhost),
      persistence read-back.

**Exit criteria:** bare `nodus node start` with no relay config fails loudly
instead of dialing 127.0.0.1; precedence unit tests pass.
Run: `cargo test --manifest-path services/storage-node/Cargo.toml`

### S5 — Rust: `nodus node pair` flow + unpaired UX

**Goal:** The pair subcommand redeems a code over HTTPS, persists `relay_url` on
success, and reports failures readably.

Tasks:

- [x] `nodus node pair` interactive (`dialoguer`): prompt relay URL (default to
      already-configured/public URL if present) then code.
- [x] `nodus node pair --relay <url> --code <code>` non-interactive.
- [x] Reuse the persistent Ed25519 identity (§5/§11) — never regenerate per
      attempt; nothing new written to `~/.nodus/identity/`.
- [x] HTTPS POST `/pairing/codes/redeem` with `{code, node_id, public_key}`;
      parse `{status:"ok", account_id}`. (`rustls-tls-native-roots` added to
      `reqwest` + `tokio-tungstenite` so HTTPS/WSS actually connect.)
- [x] On success: persist `relay_url` into config.toml (only then), print
      `node_id` + account_id, then connect via the normal WS challenge-response
      (`boot_daemon`).
- [x] On failure: print the machine-readable reason and
      "Storage Node is not paired. Run: `nodus node pair`"; the daemon sync loop
      also surfaces that guidance on `node_not_found`.
- [x] Tests: success path persists exactly once; identity unchanged across
      attempts; each failure reason surfaced; interactive prompts accept input.

**Exit criteria:** end-to-end `nodus node pair` against a *dev relay* succeeds and
a subsequent `nodus node start` reconnects without re-prompting.
Run: `cargo test --manifest-path services/storage-node/Cargo.toml`

### S6 — Web: API proxies + pairing lib

**Goal:** Next.js can issue codes and track node status.

Tasks:

- [x] `apps/web/app/api/pairing/codes/route.ts` (proxies `POST /pairing/codes`,
      authenticated via the session cookie).
- [x] `apps/web/app/api/pairing/codes/redeem/route.ts` (proxies the open redeem
      endpoint only if the UI needs it — otherwise skip and let CLI-only redeem).
      **Skipped:** S7 drives redeem through the CLI (`nodus node pair`), so no
      browser redeem proxy is needed.
- [x] `apps/web/lib/pairing.ts`: `createPairingCode()`, node list/polling via the
      existing `GET /nodes` path, node revocation reuse. **Node revocation:**
      the Relay has no `DELETE /nodes/{id}`; only device revocation exists, so
      there is nothing to reuse — left as a documented gap (not S6 scope).
- [x] Read `PUBLIC_RELAY_URL` server-side and expose it to the UI; keep internal
      `RELAY_URL` (dev default `http://localhost:8080`) strictly server-side and
      never rendered to users. Plan §3b. (Server-only `publicRelayUrl()` →
      server component → `DevicesClient` prop.)
- [x] Web tests: proxy sets the session cookie through, creation returns
      `{code, expires_at}`, PUBLIC_RELAY_URL rendering, polling states.

**Exit criteria:** `createPairingCode()` returns a real code from the dev Relay;
no PUBLIC_RELAY_URL/localhost leak in any client bundle.
Run: `pnpm test:ts` and `pnpm check-types`

### S7 — Web: "+ Add Storage Node" dialog

**Goal:** The Devices page can guide a user through pairing and shows node status.

Tasks:

- [x] Devices page "+ Add Storage Node" dialog: show relay URL
      (`PUBLIC_RELAY_URL`) + code + expiry countdown + CLI instructions
      (`nodus node pair --relay <url> --code <code>`).
- [x] Poll node status (pending → paired/offline/error) and reflect transitions;
      expiry/error states (code_expired, node already paired, owned elsewhere).
      **Divergence:** the browser only *issues* the code (the node redeems via
      the CLI), so the dialog surfaces issuance-side states — pending, paired,
      offline, expired, poll-error — and the redeem errors are surfaced by
      `nodus node pair` itself. Success is a new node in `GET /nodes` vs the
      baseline captured at open.
- [x] Empty state when no nodes; disabled/warned UI when `PUBLIC_RELAY_URL` is
      unset.
- [x] Reuse `packages/ui` primitives (e.g. `overlay`, `input`, `badge`) per the
      design-port conventions — no new bespoke styling.
- [x] Web tests: dialog render, countdown/expiry, poll success + failure
      transitions, unpaired error copy.

**Exit criteria:** a user can create a code, run the command, and watch the node
flip to paired without page reloads.
Run: `pnpm test:ts` and `pnpm lint`

### S8 — Deployment: single-origin unit + PUBLIC_RELAY_URL

**Goal:** The stack deploys as one public origin behind TLS with `/api/*` + `/ws`
→ Relay.

Tasks:

- [x] Build/deploy definition for the combined unit (Next.js standalone + Go
      Relay binary + PostgreSQL + Redis) — `deploy/` with `Dockerfile.web`
      (Next `standalone`), `Dockerfile.relay` (static Go, embedded migrations),
      `docker-compose.yml`, `.env.example`, `deploy/README.md`.
- [x] Reverse-proxy/TLS sample: `/ws`, `/buffer/*`, `/pairing/codes/redeem`,
      `/pairing/sessions/verify`, `/nodes/verify`, `/health` → Go Relay;
      everything else (incl. `/api/*` and all pages) → Next.js; proper
      Host/Origin handling; `AllowedOrigins` = the real origin.
      **Reconciled:** the plan's `/api/*` → Relay was stale — the web owns
      `/api/*` (session-cookie route handlers the browser calls) and proxies to
      the Relay internally via `RELAY_URL`. Plan §3b updated to match.
      **Seam from S5 resolved:** the node's `/pairing/codes/redeem` and
      `/buffer/fetch` are routed to the Relay under the single origin.
- [x] `PUBLIC_RELAY_URL` wired to Next (server env) + documented in the repo's
      env examples; never inferred from Host/Docker names/localhost.
      (`deploy/.env.example`, `deploy/docker-compose.yml`, `deploy/README.md`;
      `NEXT_PUBLIC_RELAY_URL` intentionally unset ⇒ same-origin `/ws`.)
- [x] Verify a Storage Node outside the Docker network can reach the public
      origin end-to-end (S5 happy path against the deployed URL). Verified live
      over the Caddy origin: host Rust node paired + WS-authenticated.

**Exit criteria:** fresh deploy → web app reachable, `POST /pairing/codes` works
through `/api`, `/ws` upgrades, and a real Rust node pairs via the public URL.
Run: manual E2E against the deployed stack.

### S9 — Docs & ADR

**Goal:** The security posture and protocol surface match the implementation.

Tasks:

- [ ] ADR `0006-self-hosted-node-bootstrap-pairing.md` under `docs/decisions/`
      (decision, context, consequences) — brief, mirroring ADR 0001–0005 tone.
      Optionally cross-link from `docs/decisions/README.md`.
- [ ] `docs/security/local-endpoints.md`: document the two new HTTP endpoints,
      rate limiting, hashed storage, plaintext-never-logged guarantee.
- [ ] `docs/protocol/message-catalog.md`: add `pairing_codes` API + the
      `node_auth_result.reason` field if not already catalogued.
- [ ] Re-check plan/Todo drift: if implementation diverged from §7b/§7c, fix the
      plan or the code (plan is source of truth for the decision).

**Exit criteria:** ADR + security + protocol docs up to date and internally
consistent.
Run: proofread pass (`rg -n "pairing_codes|node_not_found|PUBLIC_RELAY_URL" docs/`)

### S10 — Integration / E2E / hardening

**Goal:** Full lifecycle proven against a live stack.

Tasks:

- [ ] E2E: create code in UI → `nodus node pair` on a fresh node → node appears
      paired → WS challenge-response sync session authenticates.
- [ ] Negative E2E: second redemption of the same code fails; expired code fails;
      node already owned elsewhere ⇒ no account change (`node_owned_elsewhere`).
- [ ] Concurrency: rapid parallel redeems ⇒ single winner (covered in S2 but
      re-verified live).
- [ ] Restart resilience: Relay restart mid-pairing, then retry; consumed code
      still fails; node reconnect after relay restart uses WS auth only (code
      never needed again).
- [ ] Rapid re-pairing attempt with a *different* relay URL on an already-paired
      node ⇒ rejected or consistently documented behavior (v1 non-goal: re-pairing).
- [ ] Run full suite: `pnpm test`, `pnpm lint`, `pnpm check-types`.

**Exit criteria:** S1–S9 artifacts hold together under the scenarios above; full
test suite green.
Run: `pnpm test && pnpm lint && pnpm check-types`

---

## Non-negotiables (do not violate to "save time")

- Plaintext pairing codes are **never** stored, logged, or returned again after
  issuance (DB keeps only the SHA-256 hash).
- The code is a **bootstrap credential only** — it never replaces the node's
  Ed25519 identity or the WS challenge-response after setup. Reuse the existing
  identity; never regenerate per attempt.
- First-run node URL resolution must **never default to localhost/127.0.0.1/
  relay:8080**. Precedence: CLI `--relay` > `config.toml relay_url` >
  `NODUS_RELAY_URL` > none.
- `PUBLIC_RELAY_URL` is operator-configured, never inferred from Host headers or
  Docker service names.
- Redemption must be **atomic** (no double-claim) and **IP rate-limited**.
- RSS no QR-based pairing in v1; no central/shared Relay; no second long-term
  auth protocol; `storage_nodes` ownership must never move accounts.
- Opaque server-side sessions (§8/§13) stay as-is — this migration adds no
  JWT/token auth.

---

## Session Log

| Session | Date | Status | Notes |
|---|---|---|---|
| S1 | 2026-09-11 | done | migration, handler, code gen, route, unit tests |
| S2 | 2026-09-11 | done | redeem handler (transactional consume+register), proxy-aware rate limiter, route, integration tests |
| S3 | 2026-09-11 | done | `node_auth_result.reason="node_not_found"` for unpaired nodes; Go suite green |
| S4 | 2026-09-11 | done | `node` subgroup + global root flags, `relay_url` config key, precedence resolver, ws/wss normalization, no-localhost boot guard, tests |
| S5 | 2026-09-11 | done | `node pair` (prompts/non-interactive), HTTPS redeem + typed failure reasons, persist-on-success, identity reuse, `node_not_found` unpaired UX, rustls TLS; dev-relay E2E verified |
| S6 | 2026-09-11 | done | `/api/pairing/codes` proxy, `createPairingCode`/`findNode`, server-only `publicRelayUrl()` → `DevicesClient`, ws-provider same-origin, `.env.example`; no bundle localhost leak |
| S7 | 2026-09-11 | done | `AddStorageNodeDialog` (code/command/copy/countdown), `GET /nodes` new-node poll, paired refresh, `findNewNode`+`formatCountdown`; primitives only; 70 web tests green |
| S8 | 2026-09-11 | done | `deploy/` single-origin unit (web+relay+pg+redis+caddy), corrected routing (`/api/*`→Next, relay-owned paths proxied), `PUBLIC_RELAY_URL` wired, Next standalone; live E2E: host node paired + WS-authed via Caddy |
| S9 | — | pending | |
| S10 | — | pending | |
