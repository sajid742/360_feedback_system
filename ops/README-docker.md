# Docker — start here

**The full guide is [`ops/DOCKER.md`](./DOCKER.md).** This page is the two-minute version
and the image reference.

```powershell
.\start-docker.ps1                     # checks Docker, creates .env, starts everything
```

Linux/macOS, or step by step: `./ops/init-env.sh` then `docker compose up -d`.

> **`docker compose up -d` alone fails on a fresh unzip** — `required variable
> MFA_ENCRYPTION_KEY is missing a value`. `.env` is deliberately not in the package, so
> every new extract needs it created once. The commands above do that.

Then open **http://localhost:8080** — organisation `care`, `sajidq@carepvtltd.com`,
`Password123!`.

> **This does not replace the from-source workflow.** `start-dev.ps1`, `npm run dev:*` and
> `npm run db:up` are unchanged. `npm run db:up` is pinned to `-f docker-compose.yml` and
> still starts only PostgreSQL and Redis. See DOCKER.md §25.

## Compose files

| File | What it starts | Used by |
|---|---|---|
| `compose.yaml` | web, api, postgres, redis, mock-sis, waha, db-init | plain `docker compose …` (Compose prefers this filename) |
| `compose.prod.yaml` | overlay: no mock-sis, no waha, no published db/api ports, no demo seed | `docker compose -f compose.yaml -f compose.prod.yaml up -d` |
| `docker-compose.yml` | postgres, redis | `npm run db:up` / `npm run db:down` — the development dependencies |

`docker-compose.prod.yml` no longer exists; `compose.prod.yaml` replaces it and fixes the
three defects the old file had (`MOCK_SIS_DATABASE_URL` naming, missing `SIS_API_KEY`,
missing `CORS_ORIGIN`/`PUBLIC_APP_URL`).

## Images

Multi-stage Dockerfiles, all built from the **repository root** context (npm-workspaces
monorepo):

| Image | Dockerfile | Serves |
|---|---|---|
| `e360-api` | `apps/api/Dockerfile` (`runtime`) | NestJS API on `:3000`. Prisma client generated at build; `/app/database` carries both SQL files |
| `e360-api-tools` | `apps/api/Dockerfile` (`tools`) | The `db-init` one-shot. Keeps `node_modules`, the ts-node seed scripts and `psql`, which the slim runtime image cannot run |
| `e360-web` | `apps/web/Dockerfile` | Vite SPA via nginx on `:80`; proxies `/api/v1` and `^/(r\|qr)/` to `api` |
| `e360-mock-sis` | `apps/mock-sis/Dockerfile` | Mock SIS on `:3100`, admin at `/admin` |

Build one by hand:

```bash
docker build -f apps/api/Dockerfile      -t e360-api .
docker build -f apps/web/Dockerfile      -t e360-web .
docker build -f apps/mock-sis/Dockerfile -t e360-mock-sis .
```

The web image takes one build argument, `VITE_DEFAULT_ORG_SLUG` (fed from `ORG_SLUG`),
because Vite bakes `VITE_*` at build time. `VITE_API_BASE_URL` is deliberately left
relative so the same image works on localhost and on a LAN address without a rebuild.

## Addressing

Inside the network, services talk **by service name**:
`api → postgres:5432 · redis:6379 · mock-sis:3100 · waha:3000`, `web → api:3000`.
From a browser they are on `localhost` at the published ports: 8080, 3000, 3100, 3001.

`http://waha:3000` in the application's WhatsApp settings — not `localhost:3001`. That is
the most common mistake; DOCKER.md §22 explains why.

WAHA carries **two unrelated credentials**, and confusing them is the second most common
mistake: `WAHA_API_KEY` is the `X-Api-Key` header the application sends, while
`WAHA_DASHBOARD_USERNAME`/`WAHA_DASHBOARD_PASSWORD` are HTTP basic auth for the
`/dashboard` page in a browser. Both are generated into `.env` and pinned in
`compose.yaml`; left unset, WAHA randomises the dashboard password on every start.
DOCKER.md §19.3.

## Health checks

`/health` (liveness) and `/ready` (readiness) are mounted at the **root**, outside
`/api/v1`, and are **not** proxied by the web container — probe `api` directly. `/ready`
returns 503 only when the database is unreachable; an unreachable Redis or an outdated
schema report `degraded` but stay ready.

Mock SIS is the opposite: its health route keeps the global prefix, so it answers at
`/api/v1/health` — which is what its compose health check probes.

## Database initialisation

Handled automatically by the `db-init` service on every `up` — it runs the real chain
(`000_initial_schema.sql` → `001_reconcile.sql` → `db:seed` → `db:seed-roles` →
`db:bootstrap-tenant` → optionally `db:sample` + `db:demo` → mock-sis `db:push` +
`db:seed`) and every step is idempotent, so repeated runs change nothing. See
`ops/docker-init.sh` and DOCKER.md §11–12.

To re-run it: `docker compose run --rm db-init`.

**Demo data after an upgrade.** `db:demo` stops once its marker cycle exists, so a volume
first seeded by an older build keeps that older demo data — rebuilding the image does not
change it, because the guard runs before any seeding. To regenerate it from the current
code:

```powershell
docker compose run --rm -e DEMO_RESEED=true db-init
```

Scoped to the demo content of one tenant; never runs on a normal start. DOCKER.md §15.

## Data

`e360_pgdata` holds everything. `docker compose down` **keeps** it;
`docker compose down -v` **deletes** it, along with the WhatsApp session in
`e360_waha_sessions`. DOCKER.md §13–14.

## CI

`.github/workflows/ci.yml` runs on every push/PR: `npm ci` → typecheck → Prisma generate →
apply schema → full seed chain → build api/web → install Chromium → boot the API and the
Vite dev server → run the API integration tests and the UI smoke test, plus a
`docker-build` job that builds all three images. It requires `package-lock.json` to be in
sync (`npm ci` is strict).

## Sandbox note

In the reference sandbox used to verify this stack, the container build network sits
behind a TLS proxy with a self-signed CA, so an in-container `npm ci` needs that CA
trusted. On a normal network — and in CI against the public npm registry — the Dockerfiles
build unmodified. The full stack was verified end to end: all six services healthy,
initialisation idempotent across restarts, data and WhatsApp session preserved across
`down`/`up`, and the API→WAHA path confirmed up to the physical QR scan.
