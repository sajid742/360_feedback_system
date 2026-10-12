# AGENTS.md — working notes for this repository

## Running it in the Base44 sandbox

```bash
docker compose -f docker-compose.base44.yml up -d --build
```

Everything else (ports, seeding, healthchecks, env wiring) lives in
`docker-compose.base44.yml`; `.base44/environment.json` records the preview port,
the start command and the two boot-required secrets.

### Why a separate compose file

`compose.yaml` (the repo's own) builds the **release** images: `apps/api/Dockerfile`
and `apps/web/Dockerfile` both `COPY . .` and bake compiled assets in. Running those
in the sandbox would freeze the code — edits would never appear. The Base44 stack
instead runs every application service from the bind-mounted source on the plain
`Dockerfile.base44-node` runtime, using the project's own dev/watch commands, so the
edit loop stays live. `compose.yaml`, `compose.prod.yaml`, `docker-compose.yml` and
the PowerShell scripts are untouched.

### Service wiring, and the traps in it

| | |
|---|---|
| preview entry | host `3000` → `web` (Vite dev server on `5173`) — single-origin, so the browser never calls the API directly and no CORS applies |
| API | `api:3000` inside the network, **not published**; global prefix `/api/v1`, health at the root `/health` + `/ready` |
| proxy | `apps/web/vite.config.ts` proxies `/api/v1`, `^/r/`, `^/qr` to `VITE_PROXY_TARGET`, defaulting to `http://localhost:3000` |
| mock SIS | `mock-sis:3100`; its health route is **not** excluded from the prefix, so it answers at `/api/v1/health` |
| Redis | optional for the API — without it delivery is inline and `/ready` reports `degraded` |

- **The Vite proxy target must be the `api` service, not localhost.** `web` is its own
  container, so `http://localhost:3000` there is the web container itself. Compose sets
  `VITE_PROXY_TARGET=http://api:3000`; unset, the config keeps its original default and
  from-source development is unchanged.
- **Vite's dev-server host allowlist** (`server.allowedHosts`) only exists on Vite ≥ 6.1.
  This project is on the 5.x line, which does not check `Host`, so the preview host needs
  no allowlist. Compose still passes `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` so a future
  Vite upgrade keeps working.
- `apps/web/vite.config.ts` already sets `server.host: true` (binds `0.0.0.0`), which is
  why the container port is reachable.
- No external credentials are required to boot. E-mail/SMS/WhatsApp providers and 1BILL
  billing are configured per tenant in the app (Communication → Providers), and the
  `ai` module falls back to heuristics without a vendor key. WhatsApp needs a QR scan
  with a real phone, so WAHA is not part of this stack.
- `NODE_ENV=development` on purpose: with a non-production `NODE_ENV` and no installed
  licence the app runs on its built-in development licence (`LICENSE_REQUIRE` unset).

### Secrets

`JWT_ACCESS_SECRET` (≥ 32 chars; the API refuses to start on a missing/weak one) and
`MFA_ENCRYPTION_KEY` (exactly 64 hex chars) are required at boot. Both are delivered by
the platform to `/run/base44/app.env`, listed **last** under `env_file:` in the compose
file, so a value replaced in the dashboard always wins over local defaults. They are
placeholders generated for the sandbox — replace them before any shared deployment, and
remember that swapping `MFA_ENCRYPTION_KEY` makes already-stored encrypted provider
secrets unreadable.

### Seed data (idempotent — safe on every `up`)

`deps` installs from `package-lock.json` and generates the Prisma 5.22.0 client, then
`db-init` runs the project's own `ops/docker-init.sh`: creates the `mock_sis` database,
applies `database/000_initial_schema.sql` + `001_reconcile.sql`, seeds permissions and
the five system roles, bootstraps the `care` tenant, and seeds demo content (demo cycles,
scored feedback, RBAC role assignments) plus the mock-SIS roster.

Sign in with organisation slug `care`, `sajidq@carepvtltd.com` / `Password123!`.

To regenerate demo content from the current code (the demo marker otherwise keeps older
data forever):

```bash
docker compose -f docker-compose.base44.yml run --rm -e DEMO_RESEED=true db-init
```

### Verification

- `curl -s http://localhost:3000/` → the SPA shell; `curl -s http://localhost:3000/api/v1/health` proxies to the API.
- Inside the stack: `docker compose -f docker-compose.base44.yml exec -T api node -e "require('http').get('http://localhost:3000/ready',r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>console.log(r.statusCode,b))})"` — `/ready` reports the database and Redis.
- `npm run typecheck` (api + web) works inside a service, e.g.
  `docker compose -f docker-compose.base44.yml exec -T api npm run typecheck`.
- The repo's own tests need the full seed chain and a running stack: `npm test` (API,
  26 integration tests) and `npm run test:ui` (Playwright). The Playwright download is
  skipped during the sandbox install (`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`), so
  `test:ui` needs `npx playwright install` first.

### Notes

- `npm ci` runs against the bind-mounted repo, so `node_modules` lives in the checkout
  (gitignored) and is shared by every service — never install in two services at once.
- NestJS/Vite watch both read the bind mount directly; on this Linux sandbox inotify
  works, so no polling flags are needed. If edits ever stop appearing, add
  `CHOKIDAR_USEPOLLING=1` (web) / `TSC_WATCHFILE=PriorityPollingInterval` (api) to the
  service environment and call `reload_preview`.
