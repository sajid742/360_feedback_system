# Deployment & Run Guide — Enterprise 360

A single, self-consistent monorepo. This guide reflects the **current** state.
For the full administrator-facing manual (environment-variable reference,
health/readiness policy, containers, CI, backup/restore, upgrade, troubleshooting)
see `docs/content/deploy.html`; for the partner APIs and connectors see
`docs/content/api.html`.

## Layout

```
enterprise-360-app/
  apps/api/                 NestJS — 26 modules; main.ts, app.module.ts
  apps/web/                 React (Vite) — 21 feature areas + AppShell
  apps/mock-sis/            standalone vendor-style SIS (own database `mock_sis`)
  packages/shared-types/
  database/000_initial_schema.sql   canonical DDL for a FRESH database
  database/001_reconcile.sql        idempotent, additive reconcile
  ops/                              DOCKER.md, backup/restore scripts, upgrade runbook
  compose.yaml                      THE FULL ECOSYSTEM — `docker compose up -d`
  compose.prod.yaml                 production overlay
  docker-compose.yml                Postgres 16 + Redis 7 only (dev) — `npm run db:up`
  package.json                      npm workspace root — all db:*/sis:*/build:* scripts
```

Both `apps/api` and `apps/web` **type-check clean under strict mode**
(`npm run typecheck`).

## 1. Prerequisites

Node 20+, npm 10+, Docker (Postgres 16 + Redis 7 via compose). Redis is optional
— without it, message delivery runs inline. Prisma is pinned to **5.22.0**;
always invoke it as `npx prisma@5.22.0 …` (the npm scripts already do).

## 2. Infrastructure and environment files

```bash
cp apps/api/.env.example  apps/api/.env      # then set JWT_ACCESS_SECRET + MFA_ENCRYPTION_KEY
cp apps/web/.env.example  apps/web/.env
cp apps/mock-sis/.env.example apps/mock-sis/.env
npm run db:up                                 # postgres + redis
```

`MFA_ENCRYPTION_KEY` must be **exactly 64 hex chars**: `openssl rand -hex 32`.
Use a different value for `JWT_ACCESS_SECRET`.

> The **root** `.env.example` declares only `POSTGRES_*` / `REDIS_PORT` and is
> consumed by `docker-compose.yml` — it is **not** the API's environment file.
> Do not copy it to `apps/api/.env`. The authoritative variable list is the
> environment-variable section of `docs/content/deploy.html`.

> `MFA_ENCRYPTION_KEY` encrypts MFA seeds **and** every stored HR/SIS connector
> secret. Keep it in your backups (`ops/backup.sh` captures it automatically) —
> a database restored without the matching key cannot decrypt them.

## 3. Install

```bash
npm install          # once, at the ROOT — this is an npm-workspaces monorepo
```

## 4. Schema → client → seed → tenant

```bash
npm run db:apply             # 000_initial_schema.sql, then 001_reconcile.sql
npm run db:generate          # npx prisma@5.22.0 generate
npm run db:seed              # permission catalogue

# NOTE the `-w apps/api`. The root db:bootstrap-tenant script is itself an
# `npm run`, and the second npm hop swallows everything after `--` as npm
# config — the admin is then created with the DEFAULT password and no error.
npm run -w apps/api db:bootstrap-tenant -- --no-starter-content \
  --org "CARE Pvt. Ltd." --slug care \
  --email sajidq@carepvtltd.com --password 'Password123!'

npm run db:seed-roles        # refresh the five system roles + their grants
npm run db:sample            # org chart, competencies, published questionnaire
npm run db:demo              # demo cycles + scored feedback + RBAC role assignments
```

**`db:seed-roles` runs AFTER `db:bootstrap-tenant`, not before.** It iterates the
organisations that already exist and re-seeds their five system roles, so on an
empty database it has nothing to work on and does nothing. `bootstrap-tenant`
creates the org *and* its five roles, and `db:seed-roles` afterwards syncs their
permission grants — which is exactly the order `deploy.ps1` uses (steps 7–8).
Re-run it after any release that adds permissions.

`--no-starter-content` matters when `db:sample` will follow: without it the
tenant ends up with two "Standard 360 Review" templates and two overlapping
competency sets. `db:demo` is what assigns roles to the 50 sample employees —
skip it and those logins can do nothing, and the test suites fail.

Cross-platform schema apply (Windows-friendly — no local psql needed) is exactly
what `db:apply` runs:

```bash
docker compose -f docker-compose.yml cp database/000_initial_schema.sql postgres:/schema.sql
docker compose -f docker-compose.yml exec -T postgres psql -U postgres -d enterprise360 -v ON_ERROR_STOP=1 -f /schema.sql
npm run db:reconcile
```

## 5. Run

```bash
npm run dev:api     # http://localhost:3000 — routes under /api/v1
npm run dev:web     # http://localhost:5173
npm run dev:sis     # http://localhost:3100/api/v1 (admin UI at /admin) — optional
```

Open <http://localhost:5173/login> and sign in with org slug `care`,
`sajidq@carepvtltd.com` / `Password123!`.

## 6. Smoke test

1. `GET http://localhost:3000/health` → `{"status":"ok",…}` and
   `GET http://localhost:3000/ready` → 200 with `"ready":true`.
   **Both live at the ROOT, outside `/api/v1`.**
2. `POST /api/v1/auth/login` returns an access token.
3. Settings → Feature Flags → add a flag, toggle it → persists.
4. Competencies → Categories → create a category, then a competency → a v1 draft
   is auto-created; open Behaviour Indicators.

## 7. Tests

```bash
npm run typecheck    # api + web
npm test             # 26 API integration tests  (needs a running, fully seeded stack)
npm run test:ui      # 1 Playwright smoke test   (needs the Vite DEV server on :5173)
```

The UI test must run against `npm run dev:web` — `vite preview` does not carry
the `/api/v1` proxy, so every API call 404s. `.github/workflows/ci.yml` runs the
whole sequence and is the executable reference for a correct deployment.

## 8. Notes

- The backend sets a global prefix `api/v1`, with three exclusions mounted at the
  root: `/health`, `/ready` and `/r/:code`. The Vite dev server proxies
  `/api/v1`, `^/r/` and `^/qr` to port 3000 (path-boundary regexes, so `/reports`
  is **not** proxied).
- Permissions are data — `db:seed` inserts codes, `db:seed-roles` and
  `bootstrap-tenant` grant them to the system roles. New modules add their
  seeders to `apps/api/prisma/seed.ts`. After any upgrade that adds permissions,
  re-run both and have users sign in again (permissions ride in the access token).
- Authentication endpoints: `POST /auth/login` (returns either a session or
  `{mfaRequired, mfaToken}`), `POST /auth/mfa/login`, `POST /auth/refresh`
  (rotating; reuse of a rotated token revokes the whole chain), `POST /auth/logout`,
  `GET /auth/me`, `POST /auth/password/change`, `POST /auth/mfa/{setup,enable,disable}`,
  `GET /auth/mfa/status`, `GET/DELETE /auth/sessions`, `GET /auth/sso/:provider/start`,
  `GET /auth/sso/callback`, `POST /auth/ldap/login`.
- **Refresh tokens are opaque random strings, not JWTs** — 32 random bytes stored
  as a SHA-256 hash in `refresh_tokens`. `JWT_REFRESH_SECRET` appears in the CI
  workflow and the compose files but is read by **no code**.
- MFA needs `MFA_ENCRYPTION_KEY` (64 hex). Password policy, lockout, captcha, SSO
  providers and LDAP are configured per-org in the `configurations` table
  (module `auth`) — keys `password_policy`, `lockout`, `captcha`, `sso`, `ldap`.
  SSO/LDAP require real provider config to function; `ldapjs` is a runtime dep.
- Communication providers are per-org config (module `communication`, keys
  `email` SMTP, `sms` twilio/generic-HTTP, `whatsapp` meta/twilio/waha/mock,
  `general` publicBaseUrl + webhookSecret) — all editable at runtime under
  Communication → Providers, each with an enable/disable switch. See
  `COMMUNICATION_SETUP.md`. A disabled channel or missing config is recorded as
  `skipped`/error, not delivered. The delivery queue uses BullMQ when
  `REDIS_HOST` is set and **falls back to inline delivery otherwise**. Short
  links resolve at `/r/:code` (outside the API prefix). Runtime deps: `bullmq`,
  `nodemailer`, `qrcode`.
- **Inbound provider delivery webhooks are signature-verified and fail-closed.**
  `POST /api/v1/communication/webhooks/:provider` requires
  `X-Webhook-Signature: sha256=<hex>` (HMAC-SHA256 of the raw body) — with
  `X-Hub-Signature-256` and `X-Twilio-Signature` accepted as aliases. An
  organisation with **no** webhook secret configured cannot accept callbacks at
  all, and every rejection returns an identical `401`; the real reason is written
  to the log.
- Tailwind 3 + hand-written shadcn primitives — do **not** run `npx shadcn add`
  (its current CLI emits Tailwind v4).

## 9. Network access from other devices (LAN, or a real host name)

`apps/web/vite.config.ts` sets `server.host: true`, so the Vite dev server binds
`0.0.0.0` instead of loopback only. `http://localhost:5173` behaves exactly as
before and `http://<LAN-IP>:5173` additionally works — no hard-coded address, so
a changed DHCP lease needs no edit. Before this, the connection from a phone or a
second laptop was simply refused, with no error logged anywhere.

On Windows, `./start-dev.ps1` detects the current LAN IPv4 address (preferring an
interface that has a default gateway) and prints both the localhost and the LAN
URLs after launching the three servers. On Linux/macOS, find it with
`hostname -I` or `ipconfig getifaddr en0`.

The proxy targets inside `vite.config.ts` stay on `localhost` deliberately: they
are resolved by the Vite process on the server machine, not by the visiting
browser. The browser only ever requests a relative `/api/v1` path from whichever
host served the page.

### The three settings that must agree

Opening `http://<LAN-IP>:5173` on another device usually needs nothing else — the
page and the API share one origin through the dev proxy, so no CORS check
happens. Beyond that, these three have to name the **same** address, the one the
other device actually types:

| Setting | Where | What it controls |
|---|---|---|
| `CORS_ORIGIN` | `apps/api/.env` | The browser origin the API accepts cross-origin calls from. Needed only when a device calls the API **directly** on `:3000`, bypassing the dev proxy. |
| `PUBLIC_APP_URL` | `apps/api/.env` | The base for links the system **generates** — password-reset emails, parent-evaluation links, QR codes. |
| The API host | — | The API must be reachable at that same host name/IP on `:3000`. |

- **`CORS_ORIGIN`** — an explicit value always wins, so a configured deployment
  is unaffected. Unset (or blank) in development, the API reflects the caller's
  origin; unset in production it falls back to `http://localhost:5173`. Do not
  leave it as an empty string in a config-managed environment: an empty string is
  treated as "not set" by the API, but a literal `CORS_ORIGIN=` handed to a
  process manager that keeps it verbatim would match no origin at all and make
  every preflight fail with what looks like a routing bug.
- **`PUBLIC_APP_URL`** — defaults to `http://localhost:5173`. Left there, every
  recipient gets a link that only opens on the server itself. Set it to
  e.g. `http://192.168.1.20:5173` for LAN testing, or to the real public URL in
  production. Per-tenant, **Communication → Providers → General → Public base
  URL** (`general.publicBaseUrl`) overrides it; `PUBLIC_APP_URL` is the fallback
  when a tenant has not set one. See `COMMUNICATION_SETUP.md`.

If the page does not load at all from the other device, the port is being blocked
before any of this matters — check the host firewall (`Test-NetConnection
-ComputerName <IP> -Port 5173` on Windows).

## Database schema updates (existing installs)

There is **no Prisma Migrate history and none must be created.** The base DDL in
`database/000_initial_schema.sql` only creates tables on a **fresh** database;
new columns/tables reach an existing one through the **idempotent, additive**
`database/001_reconcile.sql`, which also stamps `schema_migrations`.

- `./deploy.ps1` detects an existing schema, skips the base DDL, and always runs
  the reconcile — so re-running deploy brings an old database fully up to date.
- Manually: `npm run db:reconcile` (Docker Postgres), or
  `psql -U postgres -d enterprise360 -v ON_ERROR_STOP=1 -f database/001_reconcile.sql`.
- Never run `prisma migrate dev`, `prisma migrate deploy` or `prisma db push`
  against `enterprise360`. (`prisma db push` is used **only** for the Mock SIS
  database, by `npm run sis:push`.)
- Verify afterwards: `curl -s http://localhost:3000/ready` — `checks.schema`
  compares the applied version with the one this build expects.

**Symptom this fixes:** `db:sample` or the API failing with
`PrismaClientKnownRequestError … The column "…" does not exist` (P2022) — the
database predates a column a newer build expects. Run the reconcile (or re-run
`./deploy.ps1`) and retry. The reconcile is additive and safe to run repeatedly;
it never drops data or alters the partial (soft-delete) unique indexes.

The Mock SIS has its own database (`mock_sis`); set it up with `npm run sis:setup`
(run from the repo **root** — the `sis:*` scripts are defined there, not in
`apps/mock-sis`). `./deploy.ps1` does this automatically.

Upgrades: see `ops/UPGRADE.md`. Backup/restore: see `ops/BACKUP_RESTORE.md`.
Containers: see `ops/README-docker.md`.
