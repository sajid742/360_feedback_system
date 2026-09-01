# Windows Deployment — verified

This stack was deployed and verified end-to-end (DB → schema → seed → admin →
backend → API → auth → login → frontend) on Windows with Docker Desktop.
Every command below is run from the **project root** in PowerShell.

> **This page is the FROM-SOURCE path**: the API, web and Mock SIS run on your
> machine with Node, and Docker supplies only PostgreSQL and Redis. Hot reload,
> a debugger, real stack traces — the right mode for development.
>
> If you would rather run the **entire ecosystem in containers** — including
> WAHA for WhatsApp — with a single `docker compose up -d` and no Node
> installation at all, see **`ops/DOCKER.md`**. Both modes are supported and use
> separate databases; do not run them at the same time (they share ports 3000 and
> 5432).

## Prerequisites
- **Node.js 20+** (`node -v`), npm 10+ (`npm -v`)
- **Docker Desktop** running (provides PostgreSQL 16 + Redis 7 — no local psql needed)

## Before you run a script — PowerShell execution policy

`deploy.ps1` and `start-dev.ps1` are plain text files in the repository and are
**not digitally signed**, so a default Windows policy (`RemoteSigned`, plus the
"downloaded from the internet" mark-of-the-web on a cloned or unzipped copy) will
refuse to run them:

```
.\deploy.ps1 : File C:\...\deploy.ps1 cannot be loaded. The file
C:\...\deploy.ps1 is not digitally signed. You cannot run this script on the
current system.
```

This is Windows' execution policy, not a fault in the script. Two fixes:

```powershell
# 1. Bypass the policy for this one invocation (nothing on the machine changes)
powershell -ExecutionPolicy Bypass -File .\deploy.ps1 -AdminPassword 'Password123!'

# 2. Or clear the mark-of-the-web on the file, then run it normally
Unblock-File .\deploy.ps1
Unblock-File .\start-dev.ps1
./deploy.ps1 -AdminPassword 'Password123!'
```

## One command

```powershell
./deploy.ps1 -AdminPassword 'Password123!'
```

`deploy.ps1` runs eleven steps: checks prerequisites; starts Postgres + Redis;
waits for Postgres; creates the `enterprise360` and `mock_sis` databases if
missing; writes `apps/api/.env`, `apps/web/.env` and `apps/mock-sis/.env` with a
freshly generated 64-hex `MFA_ENCRYPTION_KEY` and `JWT_ACCESS_SECRET`; runs
`npm install`; generates the Prisma client; applies the base schema **only on an
empty database** and then always the idempotent reconcile; seeds permissions;
creates the administrator; refreshes the five system roles; loads sample data;
and finally generates, pushes and seeds the Mock SIS database.

Parameters (all optional):

| Parameter | Default |
|---|---|
| `-OrgName` | `CARE Pvt. Ltd.` |
| `-OrgSlug` | `care` |
| `-AdminEmail` | `sajidq@carepvtltd.com` |
| `-AdminPassword` | `ChangeMe123!` |
| `-DbName` | `enterprise360` |
| `-NoSampleData` | switch — skip `db:sample` |
| `-Run` | switch — launch the dev servers when finished |

```powershell
./deploy.ps1 -Run                                  # ...and start the servers
./deploy.ps1 -NoSampleData                         # skip the demo dataset
./deploy.ps1 -OrgName "CARE Foundation" -OrgSlug care-foundation -AdminEmail admin@carefoundation.org -AdminPassword 'Secret123!' -Run
```

> **`deploy.ps1` does not run `db:demo`.** It stops after `db:sample`. Run
> `npm run db:demo` afterwards for the full demonstration dataset — it is also
> what assigns RBAC roles to the 50 sample employees, so without it those logins
> can do nothing and the test suites fail.

> **The bare default admin password is `ChangeMe123!`.** Pass
> `-AdminPassword 'Password123!'` to match the documented CARE credentials, or
> pick your own. Change it immediately on anything reachable by others.

## Start the servers

`./start-dev.ps1` opens **three** PowerShell windows (Mock SIS, API, web). Or run
them yourself in three terminals:

```powershell
npm run dev:sis     # http://localhost:3100/api/v1  (admin UI at /admin)
npm run dev:api     # http://localhost:3000/api/v1
npm run dev:web     # http://localhost:5173
```

Open <http://localhost:5173/login> and sign in.

## Reaching the app from a phone or another laptop

`apps/web/vite.config.ts` sets `server.host: true`, so the web dev server listens
on every interface rather than loopback only. `http://localhost:5173` is
unchanged; `http://<your-LAN-IP>:5173` now works too.

`./start-dev.ps1` detects the current LAN IPv4 address — a non-loopback,
non-APIPA address, preferring an interface that has a default gateway — and
prints it after starting the three servers:

```
From another device on the same Wi-Fi:
  Web      -> http://192.168.1.20:5173
  API      -> http://192.168.1.20:3000/api/v1
```

Nothing is hard-coded, so a new DHCP lease needs no edit. If the address cannot
be determined the script says so; find it manually with
`ipconfig | findstr IPv4`.

Open the **Web** URL on the other device. The page calls the API through the dev
server on that same host and port, so the browser sees a single origin and no
CORS configuration is involved. If it does not load, the port is blocked before
anything else matters — check with:

```powershell
Test-NetConnection -ComputerName 192.168.1.20 -Port 5173
```

Two values in `apps/api/.env` must name the address the other device actually
uses:

- **`PUBLIC_APP_URL`** — the base for links the system *generates*
  (password-reset emails, parent-evaluation links and QR codes). It defaults to
  `http://localhost:5173`, so left alone those links only open on the server
  itself. Set `PUBLIC_APP_URL=http://192.168.1.20:5173` (or your real host name).
- **`CORS_ORIGIN`** — the browser origin the API accepts cross-origin calls from.
  Needed only when a device calls the API **directly** on `:3000` instead of
  going through the dev proxy. An explicit value always wins; unset in
  development the API reflects the caller's origin, and unset in production it
  defaults to `http://localhost:5173`.

Restart the API after changing either. `DEPLOYMENT.md` §9 has the full
explanation.

## Credentials

| Field | Value |
|---|---|
| Organization slug | `care` |
| Admin email | `sajidq@carepvtltd.com` |
| Admin password | `Password123!` (or `ChangeMe123!` if you ran `./deploy.ps1` without `-AdminPassword`) |
| Sample users | `<firstname>.<lastname>@carepvtltd.com` — all share `Password123!` |

## Verify (PowerShell)

```powershell
# Liveness / readiness — these live at the ROOT, outside /api/v1
Invoke-RestMethod http://localhost:3000/health
Invoke-RestMethod http://localhost:3000/ready

# Login
$body = '{"organizationSlug":"care","email":"sajidq@carepvtltd.com","password":"Password123!"}'
Invoke-RestMethod http://localhost:3000/api/v1/auth/login -Method Post -ContentType 'application/json' -Body $body
```

`success: true` with an `accessToken` means the full stack is working.
`/ready` should report `"ready": true` and `checks.schema.status = "ok"`.

## No-Docker fallback (local PostgreSQL)

1. Create the databases (user/pass `postgres`/`postgres`, or edit
   `apps/api/.env`'s `DATABASE_URL`):
   ```powershell
   createdb -U postgres enterprise360
   createdb -U postgres mock_sis
   ```
2. Apply the schema, then the idempotent reconcile:
   ```powershell
   psql -U postgres -d enterprise360 -v ON_ERROR_STOP=1 -f database/000_initial_schema.sql
   psql -U postgres -d enterprise360 -v ON_ERROR_STOP=1 -f database/001_reconcile.sql
   ```
   (`npm run db:apply` and `db:reconcile` use `docker compose -f docker-compose.yml exec`
   and will not work against a native PostgreSQL.)
3. Copy and edit the environment files:
   ```powershell
   Copy-Item apps/api/.env.example      apps/api/.env
   Copy-Item apps/web/.env.example      apps/web/.env
   Copy-Item apps/mock-sis/.env.example apps/mock-sis/.env
   ```
   Set `JWT_ACCESS_SECRET` and a **different** 64-hex `MFA_ENCRYPTION_KEY` in
   `apps/api/.env`. Do **not** copy the root `.env.example` — it holds only the
   Docker Compose `POSTGRES_*` / `REDIS_PORT` variables and is not the API's
   environment file.
4. Install, generate, seed:
   ```powershell
   npm install
   npm run db:generate
   npm run db:seed
   npm run db:bootstrap-tenant        # see below for non-default values
   npm run db:seed-roles              # after the bootstrap — see the note below
   ```
   `db:seed-roles` re-seeds the five system roles for organisations that
   **already exist**, so on an empty database it does nothing. The bootstrap
   creates the organisation and its roles; `db:seed-roles` afterwards syncs their
   permission grants. `deploy.ps1` runs them in this order for the same reason.
5. Start the servers as above. Redis is optional — the delivery queue falls back
   to inline delivery when `REDIS_HOST` is unset.

Generate a 64-hex key without OpenSSL:

```powershell
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
```

## Creating the admin account (`db:bootstrap-tenant`)

The script is idempotent and needs **no arguments** — with none it creates
`care` / `sajidq@carepvtltd.com` / `ChangeMe123!`:

```powershell
npm run db:bootstrap-tenant
```

### If you pass flags, target the workspace directly

```powershell
npm run -w apps/api db:bootstrap-tenant -- --no-starter-content `
  --org "CARE Pvt. Ltd." --slug care `
  --email sajidq@carepvtltd.com --password 'Password123!'
```

> **Do not use the root script with flags.** The root `db:bootstrap-tenant` is
> itself an `npm run`, and the second npm hop consumes everything after `--` as
> npm config instead of forwarding it. There is no error: the script never sees
> the flags, falls back to its defaults, and creates the administrator with
> `ChangeMe123!` — while the console still prints the email you asked for. The
> failure only surfaces when every login is rejected.

### Or use environment variables (also avoids Windows quoting issues with `!`)

```powershell
$env:BOOTSTRAP_ORG="CARE Pvt. Ltd."; $env:BOOTSTRAP_SLUG="care"
$env:BOOTSTRAP_EMAIL="sajidq@carepvtltd.com"; $env:BOOTSTRAP_PASSWORD="Password123!"
npm run db:bootstrap-tenant
```

This is exactly what `deploy.ps1` does, which is why it is immune to the trap
above.

`--no-starter-content` matters when `db:sample` will follow: without it the
tenant gets a second "Standard 360 Review" questionnaire and an overlapping
competency set. Re-running the bootstrap is safe — if the org and admin already
exist it refreshes the system roles and reports so.

## Sample and demo data (recommended)

```powershell
npm run db:sample     # 50 employees in a single-rooted reporting tree,
                      # 23 departments, 39 designations, 3 competencies,
                      # 1 published questionnaire, 1 active scored cycle
npm run db:demo       # campuses, four cycles across completed/active/upcoming,
                      # calibration + released results, a full SIS roster,
                      # notifications, audit trail — AND the RBAC role
                      # assignments for the 50 sample employees
```

Both are idempotent — re-running reports "already present" and does nothing. Run
them after `db:bootstrap-tenant`. All sample users share the password
**`Password123!`** (org slug `care`). Useful logins:

- `imran.farooqi@carepvtltd.com` — Chairman, top of the org chart (Org Chart in the sidebar).
- `ayesha.siddiqui@carepvtltd.com` — Director Academics (HR/Admin); executive dashboards and calibration.
- `usman.malik@carepvtltd.com` — Director Administration (Manager); pending items in **My Reviews**.
- `hina.akhtar@carepvtltd.com` — Viewer; read-only.

## Tests

```powershell
npm run typecheck
npm test          # 26 API integration tests — needs the API on :3000 and a fully seeded DB (db:demo included)
npm run test:ui   # 1 Playwright smoke test — needs `npm run dev:web` on :5173, NOT `vite preview`
```

`vite preview` does not carry the `/api/v1` proxy, so the UI test fails at login
if it runs against a preview server.

## Troubleshooting

| Symptom | Cause & fix |
|---|---|
| `deploy.ps1`/`start-dev.ps1` **is not digitally signed. You cannot run this script** | Windows execution policy, not a script fault. Run `powershell -ExecutionPolicy Bypass -File .\deploy.ps1`, or `Unblock-File .\deploy.ps1` first. |
| The app opens on the server but not from a phone on the same Wi-Fi | Usually the host firewall — check `Test-NetConnection -ComputerName <IP> -Port 5173`. The dev server itself already listens on every interface (`server.host: true`). |
| Password-reset / parent-evaluation links point at `localhost` on another device | `PUBLIC_APP_URL` in `apps/api/.env` is still the default. Set it to the LAN address or real host name and restart the API. |
| Every login fails right after `deploy.ps1` or a manual bootstrap | The bootstrap flags were swallowed by the root npm script and the admin has `ChangeMe123!`. Try that password, then re-run with `npm run -w apps/api db:bootstrap-tenant -- …` or with `BOOTSTRAP_*` environment variables. |
| `Database "=public" does not exist` | Malformed `DATABASE_URL` in `apps/api/.env`. Use exactly `DATABASE_URL="postgresql://postgres:postgres@localhost:5432/enterprise360"` (no `?schema=public` — Prisma defaults to the public schema). |
| `MFA_ENCRYPTION_KEY must be 64 hex characters (32 bytes).` | The key is missing, base64, or the wrong length. Generate 64 hex chars (see above). If the database already holds encrypted secrets, restore the original key rather than generating a new one. |
| `PrismaClientInitializationError` (can't reach server) | PostgreSQL isn't running. Start Docker Desktop, then `npm run db:up` (or your local Postgres service), and retry. Use `npm run db:up`, **not** a bare `docker compose up -d` — that starts the full Docker stack instead of just the datastores. |
| `database "enterprise360" does not exist` | Create it: `docker compose -f docker-compose.yml exec -T postgres createdb -U postgres enterprise360` (or `createdb` locally), then re-apply the schema + seed. The `-f` matters — without it Compose targets the full-stack `compose.yaml` project. |
| `The column "…" does not exist` (Prisma P2022) | The database predates a column a newer build expects. Run `npm run db:reconcile` (or re-run `./deploy.ps1`) and retry. |
| Prisma client/schema mismatch or generation errors | A Prisma version other than the pinned 5.22.0 was used. Always `npx prisma@5.22.0 …`, or just `npm run db:generate`. |
| `Required: --org --slug ...` on bootstrap | Old script. The current one needs no arguments: `npm run db:bootstrap-tenant`. |
| `'prisma' / 'vite' / 'nest' / 'ts-node' is not recognized` | Dependencies aren't installed. Run **`npm install`** at the project root once (every fresh copy needs it), then retry. |
| `license:create` reports the flags as missing, and the echoed command shows them stripped | Two npm argument parsers in series - the root script used to hop through `npm run -w apps/api`, and npm ate the `--org value` pairs as its own config. The same trap as the `db:bootstrap-tenant` row below. Fixed on builds from 2026-08-28; on older ones call the tool directly: `node apps\api\scripts\license.cjs create --org "ABC University" --slug abc`. |
| `license:*` says ts-node is not installed | Fixed — the licence tools are now plain JavaScript with no dependencies and run in any folder with just Node. If you still see this, you are on a build older than 2026-08-27. |
| `db:*` says **"This looks like a DOCKER deployment"** | You are in a Docker folder, where the host deliberately has no Node dependencies. Use the Docker equivalent: `npm run docker:demo` to seed demo data, `npm run docker:logs` to see what initialisation did. |
| `TypeError: Cannot read properties of undefined (reading 'fileExists')` from a `db:*` command | Read the path in the stack trace: if it contains **`npm-cache\_npx`**, the failing `ts-node` is not this project's. Dependencies were never installed in that folder (or were installed without devDependencies), so `npx` downloaded its own copy of `ts-node` with no `typescript` beside it and that copy crashed in its config loader. Run **`npm install`** at the project root and retry. The `db:*` scripts no longer go through `npx`, so a fresh copy now names the missing package instead of failing this way. If you have `NODE_ENV=production` set in your shell, unset it — npm skips devDependencies when it is set, and `ts-node` is one of them. |
| "No licence is installed" / a licence banner appears | Expected on a production deployment until a licence is installed. Go to **Licence** in the menu and install the one supplied. Development and demo runs (`NODE_ENV` not `production`) use a built-in development licence and need nothing. See `LICENSING.md`. |
| The sign-in page shows the wrong client name or product name | Branding is configuration, not code. Set `BRAND_*` and `DEFAULT_ORG_SLUG` in `apps/api/.env` and restart the API, or edit it in **Configuration → Brand Studio**. See `WHITE_LABEL.md`. |
| Parents receive links containing `localhost` | `PUBLIC_APP_URL` is not set, or a stale `http://localhost:5173` is stored in Communication → Providers. Set `PUBLIC_APP_URL` in `apps/api/.env` to the address people actually use (`http://192.168.1.20:5173`, or your domain) and restart the API — a stored loopback value no longer overrides it. Or pass `.\deploy.ps1 -PublicAppUrl "http://192.168.1.20:5173"`. See `COMMUNICATION_SETUP.md` → *Public application URL*. |
| Email send fails: `self-signed certificate in certificate chain` | Not a credential problem. Antivirus SSL-scanning or a corporate proxy is intercepting the TLS connection and re-signing it with its own authority; Node does not read the Windows certificate store, so it refuses it. Export that authority's root certificate and start the API with `NODE_EXTRA_CA_CERTS=C:\certs\proxy-root.pem`, or tick **Accept untrusted certificate** in Communication → Providers → Email. Full steps in `COMMUNICATION_SETUP.md`. |
| WhatsApp send fails: `fetch failed` | Fixed — the Outbox now names the real cause (`ECONNREFUSED`, `ENOTFOUND`, TLS, 401, 404) and what to change. If you still see the bare text, you are on a build older than 2026-08-26. |
| `Missing script: sis:generate` / `sis:setup` | You are inside `apps/mock-sis`. The `sis:*` scripts live in the **root** `package.json` — `cd` back to the repo root. |
| `/health` or `/ready` returns 404 | They are mounted at the **root**, outside `/api/v1`, and are not proxied by the web server. Use `http://localhost:3000/health`. |
| API integration tests fail with 401/403 on sample users | `db:demo` was not run, so the sample employees hold no RBAC roles. Run `npm run db:demo`. |

**Verify your DATABASE_URL** (PowerShell, from `apps/api`):

```powershell
Get-Content .env | Select-String DATABASE_URL
```

It must end in `/enterprise360` — not `?schema=public` or anything ending in `=public`.

## Notes
- Env is auto-loaded via `dotenv`; `npm run` commands need no manual env exports.
- The API mounts under `/api/v1`, with `/health`, `/ready` and `/r/:code` at the
  root. The Vite dev server proxies `/api/v1`, `^/r/` and `^/qr` to port 3000, so
  no CORS setup is needed in dev.
- `MFA_ENCRYPTION_KEY` encrypts MFA seeds **and** all stored HR/SIS connector
  secrets. Keep it with your backups (`ops/backup.ps1` captures it automatically).
- Tailwind 3 + hand-written shadcn — do **not** run `npx shadcn add` (its current
  CLI emits Tailwind v4).
