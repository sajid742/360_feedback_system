# Enterprise 360 — Feedback & Performance Management System

A clean, multi-tenant monorepo: **NestJS + React (Vite) + TypeScript + Tailwind 3
+ PostgreSQL + Prisma**. One canonical schema, one design system, no legacy
conflicts.

## Two ways to run it

| | From source (development) | Docker (the whole ecosystem) |
|---|---|---|
| Start | `./deploy.ps1` once, then `./start-dev.ps1` | `./start-docker.ps1` |
| Needs installed | Node 20+, npm 10+, Docker (for Postgres + Redis) | Docker only |
| Web | http://localhost:5173 — Vite, hot reload | http://localhost:8080 — built assets via nginx |
| Runs | api, web, mock-sis + Postgres/Redis containers | api, web, postgres, redis, mock-sis, **waha** (WhatsApp) |
| Guide | `DEPLOYMENT.md`, `WINDOWS_DEPLOY.md` | **`ops/DOCKER.md`** |

Both are supported and fully independent — separate databases, separate web ports.
`npm run db:up` stays pinned to `docker-compose.yml` and still starts only
PostgreSQL and Redis, exactly as before. `ops/` also holds the backup, restore and
upgrade runbooks.

## Structure

```
enterprise-360-app/
  apps/api/                 NestJS API — :3000, global prefix /api/v1
  apps/web/                 React (Vite) SPA — :5173 in dev
  apps/mock-sis/            Standalone vendor-style Student Information System — :3100
  packages/shared-types/    shared type barrel
  database/                 000_initial_schema.sql + 001_reconcile.sql (canonical DDL)
  ops/                      DOCKER.md, backup/restore scripts, upgrade runbook
  compose.yaml              THE FULL ECOSYSTEM — what `docker compose up -d` starts
  compose.prod.yaml         production overlay (no mock-sis/waha, no exposed db)
  .env.docker.example       template for the Docker stack's .env
  docker-compose.yml        Postgres 16 + Redis 7 only — used by `npm run db:up`
  start-docker.ps1          THE DOCKER ENTRY POINT — creates .env, then starts everything
  deploy.ps1 / start-dev.ps1  one-command Windows deployment (from source)
```

### `apps/api/src` — 26 modules

`ai` · `appraisal` · `auth` · `bulk-generation` · `common` · `communication` ·
`competency` · `config` · `development` · `external-evaluation` ·
`feedback-audit` · `health` · `hr-integration` · `identity` · `integration` ·
`org-import` · `organization` · `provisioning` · `questionnaire` · `rbac` ·
`report-schedule` · `reports` · `sis` · `sis-integration` ·
`user-notifications` · `workflow`

`common/` holds the cross-cutting pieces: Prisma service, audit, RBAC guards,
request context, structured logging, the response envelope interceptor and the
global exception filter.

### `apps/web/src/features` — 21 feature areas

`ai` · `appraisal` · `auth` · `bulk-generation` · `communication` ·
`competency` · `config` · `development` · `external-evaluation` ·
`feedback-audit` · `hr-integration` · `integration` · `notifications` ·
`org-import` · `organization` · `provisioning` · `questionnaire` · `rbac` ·
`reports` · `sis-integration` · `workflow`

Plus `app/` (AppShell, RequireAuth, ErrorBoundary, page help), `components/`
(shared + hand-written shadcn-style `ui/` primitives), `lib/` (api client,
ECharts wrapper) and `pages/`.

### `apps/mock-sis`

An independent, vendor-style SIS with its **own** database (`mock_sis`), used to
integration-test the student/parent-feedback workflow. Vendor endpoints under
`/api/v1` are guarded by an `X-API-Key` header; a CRUD admin UI is served at
`/admin`. All `sis:*` scripts are defined in the **root** `package.json`.

## Conventions
- REST envelope `{ success, message, data, errors }`; `page/pageSize`,
  `sortBy/sortOrder`, `search`.
- Shared-schema multi-tenancy: every tenant table carries `organization_id`;
  scope comes from the JWT, never the client.
- Permissions are data (rows), resolved per user via roles — no hardcoded roles.
- Rating scales / proficiency levels are configurable data — never hardcoded.
- **Questionnaires are per quadrant, optionally.** A *quadrant* (feedback source —
  Self, Line Manager, Peer, Subordinate, Parents; the UI tab is **Sources**) may
  carry its own questionnaire template instead of the cycle's. Configure it at
  Appraisals → Cycles → open a cycle → **Sources** (permission
  `appraisal.cycle.manage`). The fallback rule is
  `source.templateId ?? cycle.templateId` — `feedback_sources.template_id` is
  nullable and NULL means "inherit the cycle questionnaire", so a cycle
  configured before this existed behaves exactly as before. The same resolution
  (`apps/api/src/appraisal/questionnaire-resolution.ts`) drives the form the
  reviewer opens, the answers the server accepts, and the coverage matrix, so
  they can never disagree.
- A competency is **shared** when two or more quadrants ask about it, and
  **quadrant-specific** when only one does. This is *derived* from the questions
  linked to each quadrant's effective questionnaire — there is no stored flag.
  The **Competency coverage** matrix on the same Sources tab shows it.
- TypeScript strict, no `any`, components ≤250 lines, functions ≤50 lines.
- Both apps type-check clean: `npm run typecheck`.
- **No Prisma Migrate.** The schema is applied from `database/000_initial_schema.sql`
  (fresh databases) and the idempotent `database/001_reconcile.sql` (everything
  else); `apps/api/prisma/schema.prisma` is kept 1:1 by hand. Never run
  `prisma migrate dev` or `prisma db push` against `enterprise360`.
- Prisma is pinned to **5.22.0** — always `npx prisma@5.22.0 …` (the npm scripts
  already do). A bare `npx prisma` pulls Prisma 7 and fails.

## Quick start

```bash
# 1. infrastructure + dependencies + schema + Prisma client
npm run db:up                    # Postgres 16 + Redis 7 via docker compose
npm install
npm run db:apply                 # 000_initial_schema.sql, then 001_reconcile.sql
npm run db:generate              # npx prisma@5.22.0 generate

# 2. seed chain, in order
npm run db:seed                  # permission catalogue

# NOTE the `-w apps/api`: the root db:bootstrap-tenant script is itself an
# `npm run`, and the second npm hop silently swallows the flags after `--`,
# creating the admin with the DEFAULT password instead.
npm run -w apps/api db:bootstrap-tenant -- --no-starter-content \
  --org "CARE Pvt. Ltd." --slug care \
  --email sajidq@carepvtltd.com --password 'Password123!'

# db:seed-roles comes AFTER the bootstrap: it re-seeds the five system roles for
# organisations that already exist, so on an empty database it does nothing.
npm run db:seed-roles            # the five system roles + their grants
npm run db:sample                # org chart, competencies, questionnaire
npm run db:demo                  # demo cycles, scored feedback, RBAC role assignments

# 3. optional: Mock SIS
docker compose -f docker-compose.yml exec -T postgres createdb -U postgres mock_sis
npm run sis:setup                # generate + push + seed

# 4. run
npm run dev:api                  # :3000  /api/v1   (health/ready at the ROOT)
npm run dev:web                  # :5173
npm run dev:sis                  # :3100  /api/v1   (admin UI at /admin)
```

Sign in at <http://localhost:5173/login> with org slug `care`,
`sajidq@carepvtltd.com` / `Password123!`. Every sample user created by
`db:sample` shares the password `Password123!`.

### From another device on the same network

`apps/web/vite.config.ts` sets `server.host: true`, so the dev server binds
`0.0.0.0` rather than loopback only — `http://localhost:5173` keeps working and
`http://<your-LAN-IP>:5173` additionally does. On Windows, `./start-dev.ps1`
detects the current LAN IPv4 address and prints both URLs; nothing is hard-coded,
so a changed DHCP lease needs no edit. Elsewhere, find it with
`hostname -I` / `ipconfig`.

Opening the web URL on the other device is normally all that is needed: the page
calls `/api/v1` through the Vite proxy on the same host and port, so the browser
sees one origin and performs no CORS check. Two settings in `apps/api/.env`
matter as soon as you leave `localhost`:

- `CORS_ORIGIN` — the URL the **browser** actually uses, e.g.
  `http://192.168.1.20:5173`. Only needed when a device calls the API directly on
  `:3000`. With no value set, development reflects the caller's origin;
  production defaults to `http://localhost:5173`. An explicit value always wins.
- `PUBLIC_APP_URL` — the base for links the system *generates* (password-reset
  emails, parent-evaluation links and QR codes). Left at its default, recipients
  get `localhost` links that only work on the server. Set it to the same address
  other devices use.

The API must be reachable at that same host name. See `DEPLOYMENT.md` §9 for the
full picture and `WINDOWS_DEPLOY.md` for the PowerShell specifics.

## Tests

```bash
npm run typecheck    # api + web, strict
npm test             # 26 API integration tests — needs a running, fully seeded stack
npm run test:ui      # 1 Playwright smoke test — needs the Vite DEV server on :5173
```

`npm test` and `npm run test:ui` both require the full seed chain **including
`db:demo`** (it assigns RBAC roles to the sample employees) and the API on
:3000. The UI test must run against `npm run dev:web`, not `vite preview` —
only the dev server carries the `/api/v1` proxy.
