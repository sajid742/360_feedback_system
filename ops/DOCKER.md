# Running the Enterprise 360° Feedback System with Docker

Everything — the web application, the API, PostgreSQL, Redis, Mock SIS and WAHA for
WhatsApp — starts with one command and initialises its own database on first run:

```powershell
docker compose up -d
```

Written for **Windows PowerShell**. Linux/macOS differences are noted where they matter.

> **This is one of two supported ways to run the system.** The from-source development
> workflow (`start-dev.ps1`, `npm run dev:*`, `npm run db:up`) is unchanged and still works
> exactly as it always has. See [§25](#25-development-mode-versus-docker-mode).

---

## Contents

| | | |
|---|---|---|
| [1. Docker overview](#1-docker-overview) | [10. Logs](#10-logs) | [19. WAHA setup in detail](#19-waha-setup-in-detail) |
| [2. Prerequisites](#2-prerequisites) | [11. Database initialisation](#11-database-initialisation-and-seeding) | [20. Connecting WhatsApp (QR)](#20-connecting-whatsapp--the-qr-procedure) |
| [3. First-time setup](#3-first-time-setup) | [12. Idempotency & schema version](#12-idempotency-and-schema-versioning) | [21. WAHA reconnection and reset](#21-waha-reconnection-and-reset) |
| [4. Environment configuration](#4-environment-configuration) | [13. Data persistence & volumes](#13-data-persistence-and-volumes) | [22. Configuring WhatsApp in the app](#22-configuring-whatsapp-in-the-360-admin-ui) |
| [5. Secrets](#5-secrets) | [14. Backup and restore](#14-backup-and-restore) | [23. Testing WhatsApp](#23-testing-whatsapp-from-the-application) |
| [6. Starting and stopping](#6-starting-and-stopping) | [15. Resetting the environment](#15-resetting-the-environment) | [24. LAN access](#24-lan-access) |
| [7. URLs and addressing](#7-urls-and-how-services-address-each-other) | [15b. **Preparing a new client**](#15b-preparing-the-installation-for-a-new-client) · [16. Rebuilding](#16-rebuilding-after-code-changes) | [25. Development vs Docker mode](#25-development-mode-versus-docker-mode) |
| [8. Health checks & startup order](#8-health-checks-and-startup-order) | [17. Mock SIS](#17-mock-sis) | [26. Production considerations](#26-production-and-deployment-considerations) |
| [9. Verifying the stack](#9-verifying-the-stack) | [18. HR, e-mail and SMS providers](#18-hr-e-mail-and-sms-providers) | [27. Troubleshooting](#27-troubleshooting) |

---

## 1. Docker overview

### What runs

| Service | Image | Host port | Inside Docker | What it is |
|---|---|---|---|---|
| `web` | built from `apps/web/Dockerfile` | **8080** | `web:80` | The React application served by nginx, which also proxies `/api/v1` and the short-link paths to the API |
| `api` | built from `apps/api/Dockerfile` | **3000** | `api:3000` | The NestJS API |
| `postgres` | `postgres:16-alpine` | 5432 | `postgres:5432` | Holds **both** databases: `enterprise360` and `mock_sis` |
| `redis` | `redis:7-alpine` | *(not published)* | `redis:6379` | Notification delivery queue. Optional — without it the API delivers inline |
| `mock-sis` | built from `apps/mock-sis/Dockerfile` | **3100** | `mock-sis:3100` | A stand-in student information system, with its own database and admin page |
| `waha` | `devlikeapro/waha` | **3001** | `waha:3000` | WhatsApp HTTP API |
| `db-init` | the API image, `tools` stage | — | — | One-shot. Creates the databases, applies the schema, seeds, then exits |

### What deliberately does **not** run as a container

- **Mock HR.** It is a provider *class inside the API* (`MockHrProvider`) returning a fixed
  in-memory snapshot. It is already in the `api` container. See [§18](#18-hr-e-mail-and-sms-providers).
- **A mock e-mail service.** The application has exactly one e-mail implementation — SMTP
  via nodemailer. An SMTP server is something you point at, not something this stack
  should invent. [§18](#18-hr-e-mail-and-sms-providers) shows how to add a mail catcher if you want one.
- **A mock SMS service.** SMS is Twilio or a generic HTTP gateway. There is no mock SMS
  provider in the product.

### Files

| File | Purpose |
|---|---|
| `compose.yaml` | **The full ecosystem.** What plain `docker compose` uses |
| `compose.prod.yaml` | Production overlay |
| `docker-compose.yml` | PostgreSQL + Redis only — the two dependencies of the from-source workflow. **Unchanged** |
| `.env.docker.example` | Template for `.env`; the authoritative variable list |
| `apps/api/Dockerfile` | Three stages: `build`, `tools` (used by `db-init`), `runtime` |
| `apps/web/Dockerfile` | Vite build → nginx |
| `apps/mock-sis/Dockerfile` | The vendor SIS service |
| `apps/web/nginx.conf` | Static serving, SPA fallback, `/api/v1` and short-link proxying |
| `start-docker.ps1` | **The Docker entry point.** Checks Docker, creates `.env`, validates, starts, reports |
| `ops/init-env.ps1` / `.sh` | Creates `.env` and generates the two required secrets |
| `ops/docker-init.sh` | What `db-init` runs |

Compose prefers `compose.yaml` over `docker-compose.yml`, which is why plain
`docker compose up -d` starts the whole stack while `npm run db:up` — pinned with
`-f docker-compose.yml` — still starts only the two development dependencies. Every
script that belongs to the from-source workflow (`db:up`, `db:down`, `db:apply`,
`db:reconcile`, and `deploy.ps1`) passes that `-f` explicitly, so adding the Docker stack
did not change what they do.

Because both filenames exist, Compose prints a warning on every command:

```
Found multiple config files with supported names: …\compose.yaml, …\docker-compose.yml
Using …\compose.yaml
```

That is informational and expected — it is telling you it picked the full stack, which is
what you want.

---

## 2. Prerequisites

- **Docker Desktop for Windows** with the WSL2 backend.
  `docker --version` should print a version, and `docker compose version` must report
  **v2 or newer** (the `docker compose` subcommand, not the old `docker-compose` binary).
- **About 6 GB of free disk** and **4 GB of RAM available to Docker**. WAHA alone wants
  roughly 1 GB because it runs a real browser engine.
- Nothing else listening on **8080, 3000, 3100, 3001, 5432**. See [§27](#27-troubleshooting) for
  conflicts — a local PostgreSQL on 5432 is the usual one.
- **No Node.js, PostgreSQL or Redis installation is required.** That is the point of this
  mode.

Check quickly:

```powershell
docker --version
docker compose version
docker info --format "{{.MemTotal}}"
```

> **WSL2 file I/O across the Windows/Linux boundary is slow.** If builds crawl, keep the
> repository inside the WSL filesystem rather than under `C:\Users\...`.

---

## 3. First-time setup

Four steps, once.

```powershell
cd "C:\path\to\enterprise-360-app"    # the folder containing compose.yaml
.\start-docker.ps1
```

That is the whole thing. `start-docker.ps1` checks Docker is running, creates `.env` and
generates the two required secrets, validates the configuration, starts the stack and
prints where everything is. It is safe to re-run.

Linux/macOS, or if you prefer the steps separately:

```powershell
.\ops\init-env.ps1        # ./ops/init-env.sh on Linux/macOS — creates .env, generates the secrets
docker compose up -d
```

> **`docker compose up -d` on its own will fail on a fresh unzip**, with
> *`required variable MFA_ENCRYPTION_KEY is missing a value`*. That is deliberate, not a
> defect: `.env` is not shipped in the package, and starting on a published example secret
> would be worse than failing. Run one of the two commands above first — they create it.

Both scripts copy `.env.docker.example` to `.env` and fill in `JWT_ACCESS_SECRET`
and a 64-hex `MFA_ENCRYPTION_KEY`. It is safe to re-run: it never overwrites a secret you
have already set, so it cannot silently invalidate the key that encrypts your provider
secrets. If PowerShell refuses to run either script because it is unsigned:

```powershell
powershell -ExecutionPolicy Bypass -File .\start-docker.ps1
```

<details><summary>Doing it by hand instead</summary>

```powershell
Copy-Item .env.docker.example .env
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })   # JWT_ACCESS_SECRET
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })   # MFA_ENCRYPTION_KEY
```

Paste each into the matching line in `.env`. Do not leave the template's placeholder
values — Compose treats all-zeros and `change-me…` as unset and refuses to start.
Linux/macOS: `cp .env.docker.example .env` and `openssl rand -hex 32`.
</details>

The first `up` builds four images and takes **5–15 minutes** depending on your machine and
network. Later starts take seconds.

Watch initialisation as it happens:

```powershell
docker compose logs -f db-init
```

It ends with:

```
▸ Initialisation complete
  Sign in at the web URL with organisation care / sajidq@carepvtltd.com
```

Then open **http://localhost:8080** and sign in:

| Field | Value |
|---|---|
| Organization | `care` |
| Email | `sajidq@carepvtltd.com` |
| Password | `Password123!` |

**Change that password immediately** for anything beyond a local trial.

> There is **no separate initialisation command to remember**. `db-init` runs on every
> `up` and is a fast no-op after the first time — [§12](#12-idempotency-and-schema-versioning)
> explains exactly why that is safe.

---

## 4. Environment configuration

Compose reads **`.env`** in the repository root. `.env.docker.example` is the template and
carries the full annotated list; the variables that matter most:

| Variable | Default | Notes |
|---|---|---|
| `JWT_ACCESS_SECRET` | *(none — required)* | Compose refuses to start without it |
| `MFA_ENCRYPTION_KEY` | *(none — required)* | **Exactly 64 hex characters** |
| `PUBLIC_APP_URL` | `http://localhost:8080` | The URL the **browser** uses. Sets `CORS_ORIGIN` *and* the base for links in outgoing e-mail, password resets and parent-evaluation QR codes |
| `SEED_DEMO_DATA` | `true` | `false` gives a clean tenant: administrator, permissions and roles, nothing else |
| `ORG_NAME` / `ORG_SLUG` / `ADMIN_EMAIL` / `ADMIN_PASSWORD` | CARE Pvt. Ltd. / `care` / `sajidq@carepvtltd.com` / `Password123!` | Used once, by `db-init`. Changing them later does not rename an existing tenant |
| `SIS_API_KEY` | `mock-sis-dev-key-change-me` | Shared between `api` and `mock-sis`. They must match |
| `WAHA_API_KEY` | *(generated)* | The `X-Api-Key` header. You also type this into the application's WhatsApp settings |
| `WAHA_DASHBOARD_USERNAME` / `WAHA_DASHBOARD_PASSWORD` | `admin` / *(generated)* | Basic-auth login for WAHA's dashboard in your browser — **not** the API key. Unset, WAHA randomises the password on every start ([§19.3](#193-waha-has-two-different-credentials)) |
| `WAHA_ENGINE` / `WAHA_IMAGE` | `WEBJS` / `devlikeapro/waha:latest` | `WEBJS` is the free engine. Pin the image for a reproducible deployment |
| `TZ` | `UTC` | **Set this to your own timezone.** The reminder scheduler uses the container's local time |
| `WEB_PORT` / `API_PORT` / `MOCK_SIS_PORT` / `WAHA_PORT` / `POSTGRES_PORT` | 8080 / 3000 / 3100 / 3001 / 5432 | Host side only. Change on a port clash |
| `LOG_FORMAT` / `LOG_LEVEL` | `json` / `log` | `text` is easier to read locally |

### Provider credentials are not in `.env`

SMTP passwords, Twilio tokens and the WAHA API key the application uses at runtime are
stored **per tenant in the database** and entered in the application under
**Communication**. That is deliberate: one deployment can serve several organisations with
different providers, and secrets are encrypted at rest.

### Development configuration stays separate

The from-source workflow reads `apps/api/.env`, `apps/web/.env` and `apps/mock-sis/.env`.
Docker does not touch those, and both sets can exist side by side.

### The one value baked at build time

Vite substitutes `VITE_*` values when the web image is **built**, not when it runs. Two
consequences, both handled:

- **`VITE_API_BASE_URL` is deliberately left relative** (`/api/v1`). nginx inside the web
  container proxies it to `api:3000`. That is why the same image works unchanged on
  `http://localhost:8080` *and* on `http://192.168.1.20:8080` — the browser simply calls
  whatever origin served the page. No rebuild is needed to change address.
- **`VITE_DEFAULT_ORG_SLUG`** is a build argument fed from `ORG_SLUG`; it only pre-fills
  the organisation box on the sign-in screen. Changing `ORG_SLUG` after the image exists
  needs `docker compose build web`.

---

## 5. Secrets

Two are required. Compose will refuse to start without them, by design:

```
required variable JWT_ACCESS_SECRET is missing a value:
set JWT_ACCESS_SECRET in .env — see .env.docker.example
```

**`.\ops\init-env.ps1` generates both for you** (`./ops/init-env.sh` on Linux/macOS) and
is safe to re-run. To do it by hand:

| Secret | Rule | Generate (PowerShell) |
|---|---|---|
| `JWT_ACCESS_SECRET` | Any long random string | `-join ((1..32) \| ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })` |
| `MFA_ENCRYPTION_KEY` | **Exactly 64 hex characters** | same command |

Linux/macOS: `openssl rand -hex 32` for each.

The template ships placeholders — all zeros for `MFA_ENCRYPTION_KEY`, `change-me…` for
the rest. Compose treats those as unset and refuses to start, which is deliberate: a
deployment running on a published example secret is worse than one that fails loudly.

> **`MFA_ENCRYPTION_KEY` also encrypts HR and SIS provider secrets.** Lose it and those
> become unrecoverable. Back it up alongside your database dumps ([§14](#14-backup-and-restore)).

`.env` is git-ignored; `.env.docker.example` contains placeholders only. Do not commit
real secrets, and generate fresh ones per deployment rather than reusing the examples.

---

## 6. Starting and stopping

```powershell
docker compose up -d          # start everything (builds on first run)
docker compose down           # stop and REMOVE containers — data is KEPT
docker compose stop           # pause without removing containers
docker compose start          # resume after stop
docker compose restart api    # restart one service in place
docker compose ps             # what is running, and whether it is healthy
```

After changing application source:

```powershell
docker compose up -d --build
```

> `docker compose down` is safe: it removes containers but not volumes. Only
> `docker compose down -v` destroys data — see [§13](#13-data-persistence-and-volumes).

---

## 7. URLs and how services address each other

### From your browser

| What | URL |
|---|---|
| **The application** | **http://localhost:8080** |
| API (direct) | http://localhost:3000/api/v1 |
| API liveness | http://localhost:3000/health |
| API readiness | http://localhost:3000/ready |
| Mock SIS admin | http://localhost:3100/admin |
| Mock SIS vendor API | http://localhost:3100/api/v1 *(needs `x-api-key`)* |
| WAHA dashboard | http://localhost:3001/dashboard *(basic auth — see [§19.3](#193-waha-has-two-different-credentials))* |
| WAHA API docs | http://localhost:3001/ *(same login)* |

### Inside Docker

Containers address each other **by service name on the service's own port** — never
`localhost`, which inside a container means that container itself:

```
api  →  postgres:5432 · redis:6379 · mock-sis:3100 · waha:3000
web  →  api:3000        (nginx proxies /api/v1 and ^/(r|qr)/)
```

The two addressing schemes are easy to confuse, and confusing them is the single most
common configuration mistake in this stack:

| Setting | Correct value | Wrong value people try |
|---|---|---|
| `SIS_BASE_URL` (API → Mock SIS) | `http://mock-sis:3100/api/v1` | `http://localhost:3100/api/v1` |
| WhatsApp Base URL (API → WAHA) | `http://waha:3000` | `http://localhost:3001` |
| `PUBLIC_APP_URL` (**browser** → web) | `http://localhost:8080` or your LAN URL | `http://web:80` |

WAHA is published on host port **3001** because the API already owns 3000 on the host —
but *inside* the network WAHA still listens on 3000. Hence `http://waha:3000`.

### The health endpoints are at the root

`/health` and `/ready` sit **outside** the `/api/v1` prefix and are not proxied by the web
container. Probing `http://localhost:3000/api/v1/health` returns 404 and is the usual
reason someone concludes a perfectly healthy API is down.

Mock SIS is the mirror image: its health route is **not** excluded from its global
prefix, so it answers at `/api/v1/health`, not `/health`. Its compose health check probes
that path for exactly this reason.

---

## 8. Health checks and startup order

Every long-running service declares a health check, and dependencies are expressed as
conditions rather than hopeful `depends_on` ordering:

| Service | Probe | Waits for |
|---|---|---|
| `postgres` | `pg_isready` | — |
| `redis` | `redis-cli ping` | — |
| `db-init` | *(one-shot)* | `postgres` **healthy** |
| `api` | `GET /health` (via node — the slim image has no curl) | `postgres` healthy, `redis` healthy, `db-init` **completed successfully** |
| `mock-sis` | `GET /api/v1/health` | `postgres` healthy, `db-init` completed successfully |
| `web` | `GET /` | `api` started |
| `waha` | `GET /ping`, `start_period: 90s` | — |

`db-init` uses `service_completed_successfully`, so the API never starts against an
un-migrated database — and if initialisation fails, the API does not start at all, which
is the correct, loud outcome rather than a subtly broken one.

WAHA is genuinely slow to boot because it launches a browser engine; its 90-second start
period is not padding. It reporting `starting` for a minute after `up` is normal.

---

## 9. Verifying the stack

```powershell
docker compose ps
```

All six long-running services should read `Up (healthy)` — `api`, `mock-sis`, `postgres`,
`redis`, `waha`, `web`. `db-init` shows `Exited (0)`, which is success.

Then:

```powershell
# API liveness and readiness
curl.exe http://localhost:3000/health
curl.exe http://localhost:3000/ready

# The web application
curl.exe -s -o NUL -w "%{http_code}`n" http://localhost:8080/login

# API → Mock SIS, container to container
docker compose exec api node -e "require('http').get('http://mock-sis:3100/api/v1/health',r=>console.log(r.statusCode))"

# API → WAHA, container to container
docker compose exec api node -e "require('http').get('http://waha:3000/ping',r=>console.log(r.statusCode))"
```

`/ready` returns a small JSON document reporting the database, Redis and the schema
version. Redis `down` is not fatal — the API falls back to inline delivery and stays
ready, reported as `degraded`.

---

## 10. Logs

```powershell
docker compose logs -f               # everything, live
docker compose logs -f api           # one service
docker compose logs db-init          # what initialisation did
docker compose logs --tail=100 waha
```

The API writes one JSON line per request including a request id (`LOG_FORMAT=json`). For
readable local output set `LOG_FORMAT=text` in `.env` and `docker compose up -d`.

---

## 11. Database initialisation and seeding

`db-init` runs the **real** initialisation chain — the same scripts the from-source
workflow uses, in the same order. Nothing was reimplemented for Docker:

| Step | Command | What it does |
|---|---|---|
| Databases | `psql` | Creates `enterprise360` and `mock_sis`. The Postgres image only creates the first |
| Schema | `database/000_initial_schema.sql` | Full schema. Harmlessly skipped when the tables already exist |
| Reconcile | `database/001_reconcile.sql` | Idempotent additive reconcile; stamps `schema_migrations` |
| Permissions | `npm run db:seed` | The permission catalogue |
| Roles | `npm run db:seed-roles` | The five system roles |
| Tenant | `npm run -w apps/api db:bootstrap-tenant -- …` | The organisation and its administrator |
| Sample | `npm run db:sample` | 50 employees, 23 departments, 3 campuses — *only when `SEED_DEMO_DATA=true`* |
| Demo | `npm run db:demo` | Cycles, feedback, scores, SIS roster, parent links — *same condition* |
| Mock SIS | `npm run -w apps/mock-sis db:push` + `db:seed` | Its schema and roster |

### Why `db-init` needs its own image stage

The runtime API image ships only `dist/`. It cannot run `db:seed`, `db:sample` or
`db:demo`, which are `ts-node` scripts. So `apps/api/Dockerfile` has a **`tools`** stage
that keeps `node_modules`, the scripts, the SQL files and `psql`, and `db-init` runs from
that stage. This is why `docker compose up -d` can be a complete answer rather than a
half one.

### The `-w apps/api` detail

`db-init` calls `npm run -w apps/api db:bootstrap-tenant -- --flags`, not the root script.
The root `db:bootstrap-tenant` is itself an `npm run`, and that second npm hop swallows
everything after `--` as npm configuration — silently creating the administrator with the
**default** password and making every login fail. It must stay `-w apps/api`.

### Re-running initialisation by hand

```powershell
docker compose run --rm db-init
```

Useful after restoring a backup, after upgrading the images, or if the first run failed.

---

## 12. Idempotency and schema versioning

Every step detects prior work rather than repeating it. This is a property of the existing
scripts, not something Docker added:

- the SQL uses `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`
- `db:seed` and `db:seed-roles` upsert
- `db:bootstrap-tenant` detects an existing org and only refreshes system roles
- `db:sample` checks for its marker department
- `db:demo` checks for its marker cycle, *Mid-Year Review 2027*
- the Mock SIS seed checks for an existing campus

A second start logs exactly that, and changes nothing:

```
✓ enterprise360 already exists
✓ mock_sis already exists
Org "care" + admin sajidq@carepvtltd.com already exist — system roles refreshed (5).
Sample data already present for 'care' — nothing to do.
Demo data already present for "care" (cycle "Mid-Year Review 2027" exists). Nothing to do.
Mock SIS already seeded — nothing to do.
```

**No user-entered data is ever overwritten by a restart.** This was verified: a category
created through the UI, and all 50 seeded employees, survived a full `down` / `up` cycle
untouched.

### Schema version checking is respected, not bypassed

`001_reconcile.sql` stamps `schema_migrations`. The API compares the newest stamp against
its compiled-in `EXPECTED_SCHEMA_VERSION` and reports a mismatch on `/ready` as
**`degraded`** (it stays ready — only an unreachable database returns 503). Because
`db-init` applies the reconcile on every start, an upgraded image brings its schema with
it and the check stays honest.

If `/ready` ever reports a schema mismatch, `docker compose run --rm db-init` applies the
reconcile and re-stamps the version.

---

## 13. Data persistence and volumes

Named volumes, prefixed with the project name `e360`:

| Volume | Holds | Losing it means |
|---|---|---|
| `e360_pgdata` | **Everything.** Both databases | Total data loss |
| `e360_waha_sessions` | The linked WhatsApp session | You must scan the QR code again |
| `e360_waha_media` | Media WAHA has cached | Nothing important |
| `e360_redisdata` | The delivery queue | At most a few in-flight notifications |

```powershell
docker volume ls
docker volume inspect e360_pgdata
```

### `down` versus `down -v`

| Command | Containers | Volumes | Use when |
|---|---|---|---|
| `docker compose stop` | stopped, kept | kept | Pausing briefly |
| `docker compose down` | **removed** | **kept** | Normal shutdown. **Your data is safe** |
| `docker compose down -v` | removed | **DELETED** | You genuinely want to start over |

> ### ⚠ `docker compose down -v` deletes your database and your WhatsApp session
>
> There is no undo. Every organisation, employee, cycle, response, score and provider
> credential is gone, and WhatsApp must be re-linked by scanning a QR code with the phone.
> Take a dump first ([§14](#14-backup-and-restore)) unless you truly mean it.

Verified behaviour: after `docker compose down` followed by `docker compose up -d`, the
database contents and the WAHA session were intact.

---

## 14. Backup and restore

```powershell
# Database → a file on your machine
docker compose exec -T postgres pg_dump -U postgres -Fc enterprise360 > backup.dump

# Restore into a running stack
Get-Content backup.dump -AsByteStream | docker compose exec -T postgres `
  pg_restore -U postgres -d enterprise360 --clean --if-exists
```

Linux/macOS restore: `docker compose exec -T postgres pg_restore … < backup.dump`.

Back up Mock SIS the same way against database `mock_sis`, if its roster matters to you.

> **Back up `MFA_ENCRYPTION_KEY` with the dump.** HR and SIS provider secrets are
> encrypted with it; restoring without the matching key leaves them unreadable.

`ops/backup.ps1` / `ops/backup.sh` and `ops/restore.*` remain the fuller documented
procedure — see `ops/BACKUP_RESTORE.md`. Run them from the **host**, against the
container.

---

## 15. Resetting the environment

**Full reset — deletes all data:**

```powershell
docker compose down -v
docker compose up -d
```

**Keep the data, re-run initialisation:**

```powershell
docker compose run --rm db-init
```

### Regenerating the demo data after an upgrade

```powershell
docker compose run --rm -e DEMO_RESEED=true db-init
```

**When you need this.** `db:demo` stops the moment its marker cycle exists. That is what
makes restarting a stack safe — it never duplicates or overwrites anything — and it is
also why a volume first seeded by an **older build keeps that older demo data for ever**.
Rebuilding the images does not help: the guard runs before any seeding does. If you
upgrade and still see demo content the release notes say was changed, this is why.

**What it does.** Deletes the demo content this application created for the tenant — its
five demo cycles and everything hanging off them, the demo SIS roster and its teacher
identity maps, and the demo notifications — then regenerates all of it from the current
code. It is scoped to one organisation and touches nothing else.

> **It never runs by itself.** A normal `docker compose up -d` does not set `DEMO_RESEED`,
> and the reset refuses to run unless `SEED_DEMO_DATA=true`. It leaves employees, users,
> roles, competencies, questionnaires and any cycle a person created completely alone —
> so it is not a way to wipe a working system, and `down -v` remains the only command
> that destroys everything.

From source, the same thing:

```powershell
npm run db:demo -- --force
```

**Clean tenant instead of the demo tenant:** set `SEED_DEMO_DATA=false` in `.env` *before*
the first `up` (or after a `down -v`). You then get the administrator, the permission
catalogue and the five system roles, and nothing else.

**Rebuild images from scratch** (after a dependency change, or when a cached layer is
suspect):

```powershell
docker compose build --no-cache
docker compose up -d
```

---

## 15b. Preparing the installation for a new client

Different from a demo reset. A demo reset regenerates *demo* content; this removes the
previous client entirely and leaves a clean, professionally configured starting point.

> ### ⚠ Take a backup first
> ```powershell
> docker compose exec -T postgres pg_dump -U postgres -Fc enterprise360 > before-newclient.dump
> ```
> Keep `MFA_ENCRYPTION_KEY` with it — HR/SIS provider secrets are encrypted with it and
> a restore without the matching key leaves them unreadable. For a genuine new client,
> **generate a fresh key** (`.\ops\init-env.ps1` does) rather than carrying a development
> key into their deployment.

### Preview first — changes nothing

```powershell
docker compose run --rm -e NEW_CLIENT=true -e NEW_CLIENT_DRY_RUN=true `
  -e ORG_NAME="New Client Ltd" -e ORG_SLUG=newclient `
  -e ADMIN_EMAIL=admin@newclient.com -e ADMIN_PASSWORD='Str0ng!Pass' db-init
```

It prints the target database, the organisations in scope and a count per category.

### Apply

```powershell
docker compose run --rm -e NEW_CLIENT=true `
  -e ORG_NAME="New Client Ltd" -e ORG_SLUG=newclient `
  -e ADMIN_EMAIL=admin@newclient.com -e ADMIN_PASSWORD='Str0ng!Pass' db-init
docker compose restart api
```

Then sign in with organisation `newclient` and that e-mail, and **change the password**.

From source, the same thing:

```powershell
npm run db:purge-client -- --dry-run --all      # preview
npm run db:new-client -- --force --org "New Client Ltd" --slug newclient `
  --email admin@newclient.com --password 'Str0ng!Pass'
```

`npm run db:purge-client -- --force --slug <slug>` removes one organisation and its
campuses without creating anything, if you want the two halves separately.

### What is removed

The target organisation(s) and everything scoped to them: campuses, users, employees,
departments, designations, roles, cycles, quadrants, participants, reviewer assignments,
feedback responses, scores, parent evaluation links, SIS roster snapshots and sync runs,
identity maps, notifications, campaigns, short links, development actions, workflows, API
keys, webhook endpoints, configurations, feature flags, system settings, sessions, tokens
and MFA data, audit logs — **and that client's own competencies, questions, questionnaires
and rating scales**, because the new client gets a fresh generic library rather than the
previous customer's edits.

### What is retained

The database schema, `schema_migrations`, and the global **permissions** catalogue.
Those are code-derived — provisioning refuses to run without permissions. Any
organisation you did **not** name is untouched.

### What the new client receives

| | |
|---|---|
| Rating scale | Standard 5-Point — Poor / Needs Improvement / Meets Expectations / Very Good / Excellent |
| Competencies | **10**, each with an active v1 and five proficiency levels. Core: Communication · Collaboration & Teamwork · Accountability & Delivery · Integrity & Professionalism · Adaptability. Performance: Problem Solving & Decision Making · Planning & Organisation · Stakeholder Focus. Leadership: Leadership & Developing Others · Innovation & Continuous Improvement |
| Questionnaires | **3**, all published and editable: *Standard 360 Review* (10 rating + 2 open-text, the cycle default every quadrant inherits) · *Parent / External Feedback* (short, plain language) · *Consolidated Parent Feedback* (exactly one rating question, as that feature requires) |
| Roles | The five system roles, and a Super Admin holding all permissions |
| Settings | `min_responses_to_show` 3 · `target_score` 3.5 · gap thresholds 0.5 / 1.0 · `comparisonMinQuadrants` 2 · reminders every 3 days |
| Cycles | **None.** No active cycle is created — the client builds their own |
| Communication | Email, SMS and WhatsApp all **disabled**, so nothing can be sent until a provider is configured |

Technical/job knowledge is deliberately not among the defaults: it is the one competency
that is genuinely role-specific, so a generic version would be wrong for most roles.

### Mock SIS is not client data

The `mock-sis` service is a **vendor simulator** with its own separate database
(`mock_sis`). It is not touched by any of this and holds a fictional roster for testing
the SIS connector. A real client deployment should not depend on it — use the production
overlay, which removes it along with WAHA:

```powershell
docker compose -f compose.yaml -f compose.prod.yaml up -d
```

---

## 16. Rebuilding after code changes

Docker mode serves **built** assets — it does not hot-reload. After changing source:

```powershell
docker compose up -d --build           # rebuild what changed and restart it
docker compose build web; docker compose up -d web    # just one service
```

If you are actively writing code, use development mode instead
([§25](#25-development-mode-versus-docker-mode)) — Vite hot-reloads and the API restarts on
save. Docker mode is for demonstrating, testing a release, and handing the system to
someone else.

**Database schema changes** belong in `database/001_reconcile.sql` with a new
`schema_migrations` stamp, exactly as in development. `db-init` applies it on the next
`up`.

---

## 17. Mock SIS

A genuine standalone NestJS service with its own Prisma schema and its own database — not
a stub inside the API. It supplies students, guardians, teachers and teaching assignments,
which is what parent feedback and the consolidated parent form depend on.

- The API reaches it at **`http://mock-sis:3100/api/v1`** (`SIS_BASE_URL`), authenticating
  with `SIS_API_KEY`. Both containers read the same value from `.env`; if they differ,
  every call is refused with 401.
- Its schema and roster are created by `db-init`. There is no manual step.
- **Admin page: http://localhost:3100/admin** — browse and edit the roster. It is
  deliberately unauthenticated, which is fine for a test fixture and is exactly why the
  production overlay removes this service entirely.
- In the application, choose the provider under **Student Integration**; `Mock SIS` is the
  built-in one, and the roster you see there comes from this container.

Verified: the vendor API returns **401 without** `x-api-key` and **200 with** it, and
`/admin` serves its page.

To run without it: `docker compose up -d --scale mock-sis=0`.

---

## 18. HR, e-mail and SMS providers

### HR — including Mock HR

**Mock HR needs no container.** It is `MockHrProvider` inside the API: a class returning a
fixed snapshot (2 campuses, 3 departments, 6 employees `HRE001`–`HRE006`). It is already
running in the `api` container.

To use it: **HR Integration → data source → External HR → provider → Mock HR (built-in)**,
then **Dry run** and **Sync now**. The `reduced` scenario exercises the update and
deactivate paths.

> Switching to External HR makes the organisation directory **read-only** — employee
> writes return 403 until you switch back to Internal.

Real providers — **BambooHR**, **Zoho People** (both wired but not validated against a
live vendor) and **Generic REST / CSV / SFTP** — need credentials entered on the same
screen. Nothing goes in `.env`; credentials are encrypted per tenant with
`MFA_ENCRYPTION_KEY`.

Containers have ordinary outbound network access, so calling a vendor API needs no Docker
configuration. Behind a corporate proxy, add `HTTP_PROXY`/`HTTPS_PROXY` to the `api`
service environment.

### E-mail

One implementation: **SMTP via nodemailer**. Configure it under **Communication → Email**
— host, port, TLS, authentication, username, password, sender name and address. Stored per
tenant in the database.

- **A real provider** (SendGrid, Amazon SES, Microsoft 365, your own server): use its host
  and port; nothing Docker-specific is required.
- **A local mail catcher for demos**, if you want one, is a three-line addition to
  `compose.yaml`:

  ```yaml
    mailpit:
      image: axllent/mailpit
      container_name: e360-mailpit
      ports: ['8025:8025']     # the web inbox
      networks: [e360]
  ```

  Then set host `mailpit`, port `1025`, authentication off, and read everything the system
  sends at http://localhost:8025. A debugging convenience, not a dependency — which is why
  it is not in the stack by default.

**With e-mail disabled** — the default — a send is recorded with status **`skipped`** and
the reason *"Channel is disabled in Communication settings."* That is correct, audited
behaviour, not a failure. **Send test** deliberately behaves differently: it bypasses the
enable switch and really connects, so with nothing listening it records **`failed`**.

### SMS

Two implementations, both external services: **Twilio** (account SID, auth token, sender
id) and a **generic HTTP gateway** (any endpoint — URL, method, JSON or form body, and
none / API-key / basic / bearer / OAuth2 authentication, with configurable parameter
names). Configure under **Communication → SMS**. There is no mock SMS provider; the
`skipped` behaviour above applies equally.

---

## 19. WAHA setup in detail

WhatsApp is the one channel with a first-class local option, because **`waha` is already a
supported provider in the application** — `WahaTransport` posts to `{baseUrl}/api/sendText`
with an `X-Api-Key` header. Nothing in the application changed to support Docker; you
simply point its WhatsApp settings at the container.

### 19.1 It starts with the stack

```powershell
docker compose ps waha
docker compose logs -f waha
```

Allow **60–90 seconds** before it reports healthy — it boots a browser engine.

### 19.2 Confirm it is alive

`/ping` needs no API key:

```powershell
curl.exe http://localhost:3001/ping
# {"message":"pong"}

curl.exe http://localhost:3001/api/version
# {"version":"2026.8.1","engine":"WEBJS","tier":"CORE","browser":"/usr/bin/chromium"}
```

### 19.3 WAHA has two different credentials

This trips people up, so it is worth being precise. They are unrelated, and they are used
in different places.

| | What it is | Where you use it | `.env` |
|---|---|---|---|
| **API key** | The `X-Api-Key` HTTP header | Every `curl` below, **and** the API Key field in the application at **Communication → WhatsApp** | `WAHA_API_KEY` |
| **Dashboard login** | Ordinary HTTP basic auth — a username and password box in the browser | The dashboard at http://localhost:3001/dashboard, and the API-docs page at http://localhost:3001/ | `WAHA_DASHBOARD_USERNAME` (default `admin`) and `WAHA_DASHBOARD_PASSWORD` |

Read them out of `.env` whenever you need them:

```powershell
Get-Content .env | Select-String 'WAHA_'
```

To load the API key into a variable for the commands below:

```powershell
$key = (Select-String -Path .env -Pattern '^WAHA_API_KEY=(.*)$').Matches.Groups[1].Value
```

Linux/macOS: `key=$(grep '^WAHA_API_KEY=' .env | cut -d= -f2)`.

> **Both are generated for you** by `start-docker.ps1` / `ops/init-env.ps1`, and both are
> pinned in `compose.yaml` from `.env`. That matters: **left unset, WAHA invents a new
> random dashboard password on every single start** and prints it only to its own log, so
> the login would change under you after each restart. WAHA also rejects weak values —
> `admin`, `waha`, `123`, an empty string, all-zeros — and silently substitutes a random
> one, which looks identical to "my password stopped working".

### 19.4 The dashboard

**http://localhost:3001/dashboard** — sign in with `WAHA_DASHBOARD_USERNAME` (`admin`) and
`WAHA_DASHBOARD_PASSWORD` from your `.env`, *not* the API key. It gives you sessions, the
QR code and live status without any curl at all, so if you prefer clicking, use it for
[§20](#20-connecting-whatsapp--the-qr-procedure) instead of the commands.

The API-docs page at **http://localhost:3001/** takes the same login.

If you ever lose the password, read it back from `.env` — or set a new one there and run
`docker compose up -d`:

```powershell
Get-Content .env | Select-String 'WAHA_DASHBOARD_PASSWORD'
```

### 19.5 Which engine

`WAHA_ENGINE=WEBJS` is the free engine and what this stack defaults to. `NOWEB` and `GOWS`
are WAHA Plus features. `WAHA_IMAGE` pins the version — worth doing for a deployment you
intend to keep.

### 19.6 Running without WAHA

```powershell
docker compose up -d --scale waha=0
```

Everything else runs normally; WhatsApp simply has no local provider. The production
overlay does this for you.

---

## 20. Connecting WhatsApp — the QR procedure

**Step 4 cannot be automated. It needs a phone with WhatsApp installed.**

**1. Have the phone ready first.** The QR code rotates roughly every 20 seconds, so open
WhatsApp before you generate one.

**2. Check WAHA is healthy.**

```powershell
docker compose ps waha         # should read Up (healthy)
curl.exe http://localhost:3001/ping
```

**3. Load the API key.**

```powershell
$key = (Select-String -Path .env -Pattern '^WAHA_API_KEY=(.*)$').Matches.Groups[1].Value
```

**4. List existing sessions** — on a fresh volume this is empty.

```powershell
curl.exe -H "X-Api-Key: $key" http://localhost:3001/api/sessions
```

**5. Create the session.** The application expects a session name; `default` is the
default in both places, so keep it unless you have a reason not to.

```powershell
curl.exe -X POST http://localhost:3001/api/sessions `
  -H "X-Api-Key: $key" -H "Content-Type: application/json" `
  -d '{\"name\":\"default\",\"start\":true}'
```

Linux/macOS: `-d '{"name":"default","start":true}'` (no backslashes).

**6. Check its status.** `SCAN_QR_CODE` is exactly what you want at this point.

```powershell
curl.exe -H "X-Api-Key: $key" http://localhost:3001/api/sessions/default
```

**7. Get the QR code.** Either open **http://localhost:3001/dashboard** and look at the
session, or save it as an image:

```powershell
curl.exe -H "X-Api-Key: $key" "http://localhost:3001/api/default/auth/qr?format=image" -o qr.png
Start-Process qr.png
```

**8. On the phone:** WhatsApp → **Settings** → **Linked devices** → **Link a device**.

**9. Scan the code** on your screen.

**10. If it expired before you scanned**, request it again (step 7). This is common and
harmless.

**11. Confirm the link.**

```powershell
curl.exe -H "X-Api-Key: $key" http://localhost:3001/api/sessions/default
```

`"status": "WORKING"` means WhatsApp is linked, and the `me` field shows the connected
number.

**12. Configure the application** with the session name and API key —
[§22](#22-configuring-whatsapp-in-the-360-admin-ui) — then send a test message,
[§23](#23-testing-whatsapp-from-the-application).

The session is stored in the `e360_waha_sessions` volume and survives restarts and
`docker compose down`. You do not repeat this procedure on every start.

---

## 21. WAHA reconnection and reset

### When the link drops

WhatsApp still drops a linked device occasionally — if the phone is offline for a long
period, if you unlink the device from the phone, or after a WAHA upgrade.

```powershell
# Where does it stand?
curl.exe -H "X-Api-Key: $key" http://localhost:3001/api/sessions/default

# Nudge it
curl.exe -X POST -H "X-Api-Key: $key" http://localhost:3001/api/sessions/default/restart
```

| Status | Meaning | What to do |
|---|---|---|
| `WORKING` | Linked and sending | Nothing |
| `STARTING` | Booting the engine | Wait |
| `SCAN_QR_CODE` | Not linked | Scan again — [§20](#20-connecting-whatsapp--the-qr-procedure) from step 7 |
| `FAILED` / `STOPPED` | Engine problem | Restart the session; if it persists, `docker compose restart waha` and check its logs |

No application configuration changes when a session reconnects — the base URL, session
name and API key stay the same.

### Deliberately resetting — linking a different number

```powershell
curl.exe -X POST   -H "X-Api-Key: $key" http://localhost:3001/api/sessions/default/logout
curl.exe -X DELETE -H "X-Api-Key: $key" http://localhost:3001/api/sessions/default
# then re-create (step 5) and scan with the new phone (steps 7–9)
```

> Do **not** use `docker compose down -v` to reset WhatsApp. It works, but it also deletes
> your entire database. The commands above are the surgical version.

### Wiping only WAHA's data

```powershell
docker compose stop waha
docker volume rm e360_waha_sessions e360_waha_media
docker compose up -d waha
```

---

## 22. Configuring WhatsApp in the 360 Admin UI

Sign in as an administrator and open **Communication** in the left navigation, then the
**WhatsApp** section:

| Field | Value |
|---|---|
| Enabled | **on** |
| Provider | **WAHA (WhatsApp HTTP API)** |
| Base URL | **`http://waha:3000`** |
| Session | `default` |
| API Key | your **`WAHA_API_KEY`** from `.env` — the `X-Api-Key` value, **not** the dashboard password |
| Webhook URL | leave blank unless you have configured delivery callbacks |

Save.

> ### ⚠ The Base URL must be `http://waha:3000`
>
> Not `http://localhost:3001`. The **API** calls WAHA, container to container, where
> `localhost` means the API's own container. `3001` is only what *your browser* uses.
> The field's placeholder text unhelpfully suggests `http://localhost:3000`, which is
> right for a from-source setup and wrong here. This is the most common mistake in the
> whole Docker setup.

The API key field shows `(set — blank keeps)` once a value is stored: leaving it blank on
a later save keeps the existing key rather than clearing it.

The provider list also offers **Meta Cloud API**, **Twilio WhatsApp** and **Mock (record
only)**. The mock provider records what *would* have been sent without contacting
anything, which is useful for demonstrating the workflow when no phone is available.

---

## 23. Testing WhatsApp from the application

**Communication → Send a test message**: choose channel **WhatsApp**, enter a recipient in
international format (`+923001234567`), then **Send test**. The delivery log records the
outcome.

**Before the QR code is scanned** you will see WAHA's own honest refusal — which is a
genuinely useful signal, because it proves the API reached WAHA and only the phone link is
missing:

```
WAHA send failed (422): {"error":"Session status is not as expected. Try to restart the session...",
                         "session":"default","status":"SCAN_QR_CODE","expected":["WORKING"]}
```

*(This exact response was observed during verification of this stack — the API→WAHA path
works; only the physical scan is outstanding.)*

**After scanning**, the same test delivers to the phone and the log records success.

Common outcomes:

| Log entry | Meaning |
|---|---|
| `skipped` — "Channel is disabled" | The WhatsApp toggle is off. Send test bypasses it, so this appears on real sends, not tests |
| 422 `SCAN_QR_CODE` | WAHA reached; session not linked. [§20](#20-connecting-whatsapp--the-qr-procedure) |
| 401 / 403 | The API key in the application does not match `WAHA_API_KEY` in `.env` (the dashboard password is a different credential — [§19.3](#193-waha-has-two-different-credentials)) |
| `ECONNREFUSED` / timeout | Base URL wrong — almost always `localhost` instead of `waha:3000` |

---

## 24. LAN access

Every published port binds `0.0.0.0`, so the stack is reachable from other devices on your
network as soon as Windows Firewall allows it. Two things must line up.

**1. Find your machine's LAN address.**

```powershell
ipconfig | Select-String "IPv4"
```

Linux/macOS: `hostname -I` or `ipconfig getifaddr en0`.

**2. Tell the application what address people will use.** In `.env`:

```
PUBLIC_APP_URL=http://192.168.1.20:8080
```

then:

```powershell
docker compose up -d
```

This sets `CORS_ORIGIN` **and** the base for links in outgoing e-mail, password resets and
parent-evaluation QR codes. Left at `localhost`, the application works in your own browser
but every link you send out opens nowhere on the recipient's device — which matters
enormously for parent feedback, where the whole delivery mechanism is a link.

Other devices then use **http://192.168.1.20:8080**. Nothing else changes: the web
container proxies `/api/v1`, so the browser only ever talks to one origin, and the same
image works on both addresses without a rebuild.

If Windows prompts about firewall access for Docker, allow it on **private** networks. If
no prompt appeared and the LAN cannot reach you:

```powershell
New-NetFirewallRule -DisplayName "E360 web 8080" -Direction Inbound -LocalPort 8080 -Protocol TCP -Action Allow
```

*(Run as Administrator. Only on a network you trust.)*

> A LAN-exposed stack is for a trusted network. Put TLS in front of it for anything more
> public — [§26](#26-production-and-deployment-considerations).

---

## 25. Development mode versus Docker mode

Both work. They are independent — different databases, different web ports — and
**nothing about the from-source workflow changed** when Docker support was added.

| | Development mode | Docker mode |
|---|---|---|
| **Start** | `.\start-dev.ps1` (or `npm run dev:api`, `dev:web`, `dev:sis`) | `docker compose up -d` |
| **Dependencies** | `npm run db:up` starts PostgreSQL + Redis only | Everything is in the stack |
| **Must be installed** | Node 20, npm 10, Docker (for the database) | Docker only |
| **Web** | http://localhost:5173 — Vite, hot reload | http://localhost:8080 — built assets, nginx |
| **Code changes** | Instant | Need `docker compose up -d --build` |
| **Configuration** | `apps/*/.env` | `.env` in the root |
| **Database** | Your local `enterprise360` | The `e360_pgdata` volume — **separate data** |
| **Mock SIS** | `npm run dev:sis` | Always running |
| **WAHA** | Not present unless you run it yourself | Always running |
| **Best for** | **Writing code.** Hot reload, debugger, real stack traces | **Demonstrating, testing a release, handing it to someone else, running it on a spare machine** |

`npm run db:up` and `npm run db:down` are pinned to `-f docker-compose.yml` — the
two-service development file — so they behave exactly as they always have. Plain
`docker compose up -d` picks `compose.yaml` and starts the full stack, because Compose
prefers that filename.

> **Do not run both at once.** They both want ports 3000 and 5432. Stop one before
> starting the other: `docker compose down`, or Ctrl+C in the `start-dev.ps1` window
> followed by `npm run db:down`.

The two databases are genuinely separate. Data you create in Docker mode is not visible in
development mode and vice versa. To move data between them, use `pg_dump` /`pg_restore`
([§14](#14-backup-and-restore)).

---

## 26. Production and deployment considerations

```powershell
docker compose -f compose.yaml -f compose.prod.yaml up -d
```

The overlay:

- removes **Mock SIS** and **WAHA** (`replicas: 0`) — a real deployment uses a real SIS,
  and the Mock SIS admin page is unauthenticated by design
- stops publishing the **PostgreSQL** and **API** ports; the browser reaches the API
  through the web container, and the database is not exposed at all
- sets `SEED_DEMO_DATA=false` — a clean tenant, no demo content
- applies modest memory limits

Beyond that:

- **Put a TLS-terminating reverse proxy in front** (Caddy, Traefik or nginx) and set
  `PUBLIC_APP_URL` to the `https://` address. The application does not terminate TLS
  itself.
- **Change every default**: `POSTGRES_PASSWORD`, `ADMIN_PASSWORD`, `SIS_API_KEY`,
  `WAHA_API_KEY`, and both secrets. Generate them fresh per environment.
- **Consider managed PostgreSQL** instead of the container, and point `DATABASE_URL` at
  it. Then `docker compose up -d --scale postgres=0`.
- **Do not scale the API beyond one replica.** Four `@Cron` jobs run in-process —
  reminders, HR sync, SIS sync and report schedules — with no leader election, so a second
  replica would duplicate every one of them.
- **Set `TZ`.** The reminder scheduler uses the container's local time, so leaving it at
  UTC sends the 09:00 reminders at 09:00 UTC.
- **Pin image versions** — `WAHA_IMAGE`, and the `postgres`/`redis` tags — so a rebuild
  months later produces the same stack.
- **Schedule backups** ([§14](#14-backup-and-restore)) and store `MFA_ENCRYPTION_KEY` with them.
- **Watch `/ready`** from your monitoring: it reports database, Redis and schema version.

If you need WhatsApp in production, run WAHA on the same network but review WAHA's own
licensing and the WhatsApp terms first — WEBJS drives a real WhatsApp Web session, which
is not the same commitment as the Meta Cloud API.

---

## 27. Troubleshooting

Start here, always:

```powershell
docker compose ps
docker compose logs <service>
```

| Symptom | Cause | Fix |
|---|---|---|
| **`required variable MFA_ENCRYPTION_KEY is missing a value`** (or the same for `JWT_ACCESS_SECRET`) | There is no `.env` in the folder you ran from, or the secret is blank. **Unzipping does not create one** — `.env` is deliberately not shipped, and every fresh extract needs it again | Run `.\start-docker.ps1` instead of `docker compose up -d`; it creates `.env` and then starts the stack. Confirm with `Get-Content .env \| Select-String MFA_ENCRYPTION_KEY` — you should see 64 hex characters. See [§3](#3-first-time-setup) |
| **`port is already allocated`** | Something else owns the port | `netstat -ano \| findstr :8080`, then stop it or change `WEB_PORT` in `.env`. Usual culprits: a local PostgreSQL on 5432, or a from-source API on 3000 |
| **A container will not start** | Look, don't guess | `docker compose logs <service>` |
| **Build fails, `npm ci` errors** | Network or registry issue | Retry; check Docker Desktop has internet. Behind a corporate TLS proxy see the last row |
| **Build fails with `SELF_SIGNED_CERT_IN_CHAIN`** | A TLS-intercepting corporate proxy blocks npm *inside* the build | Not a defect in these files. Add your corporate CA to the build stage, or build on an unproxied network |
| **`db-init` exited non-zero, API never starts** | Initialisation failed — correctly loud | `docker compose logs db-init` and read the error. Safe to re-run: `docker compose run --rm db-init` |
| **Sign-in fails right after setup** | The administrator was created with a different password | Check `ADMIN_PASSWORD` in `.env`, then `docker compose run --rm db-init` |
| **API cannot reach PostgreSQL** | Starting before the database is ready | Should not happen — `api` waits for `postgres` to be healthy. If it does, `docker compose logs postgres` and confirm `POSTGRES_PASSWORD` matches on both |
| **`/ready` says `degraded`, Redis `down`** | Redis unreachable | Often benign — the API falls back to inline delivery and stays ready. `docker compose ps redis` |
| **`/ready` reports a schema mismatch** | Image newer than the database | `docker compose run --rm db-init` |
| **`http://localhost:3000/api/v1/health` → 404** | Wrong path | `/health` and `/ready` are at the **root**, outside `/api/v1` ([§7](#7-urls-and-how-services-address-each-other)) |
| **Web page loads but nothing works** | nginx cannot reach the API | `docker compose logs api`; test from inside: `docker compose exec web wget -qO- http://api:3000/health` |
| **CORS errors in the browser console** | `PUBLIC_APP_URL` does not match the address you typed | Set it to the exact origin including the port, then `docker compose up -d` ([§24](#24-lan-access)) |
| **Links in e-mails point at localhost** | Same cause | Set `PUBLIC_APP_URL` to the address recipients can actually reach |
| **API cannot reach Mock SIS** | Wrong URL or mismatched key | `SIS_BASE_URL` must be `http://mock-sis:3100/api/v1`, never `localhost`. `SIS_API_KEY` must be identical in both services |
| **Mock SIS unhealthy** | Probing the wrong path | Its health route is `/api/v1/health`, not `/health` — unlike the API, it keeps the global prefix |
| **API cannot reach WAHA** | Almost always `localhost` in the Base URL | Must be **`http://waha:3000`** ([§22](#22-configuring-whatsapp-in-the-360-admin-ui)). Verify: `docker compose exec api node -e "require('http').get('http://waha:3000/ping',r=>console.log(r.statusCode))"` |
| **WAHA stuck `starting`** | It boots a browser engine | Give it 90 seconds. Then `docker compose logs waha`; if it is short on memory, raise Docker Desktop's RAM allocation |
| **QR code expires before you scan** | It rotates every ~20 seconds | Open WhatsApp on the phone *first*, then request the QR again ([§20](#20-connecting-whatsapp--the-qr-procedure)) |
| **WhatsApp shows `SCAN_QR_CODE` again** | Link dropped | Restart the session, scan again ([§21](#21-waha-reconnection-and-reset)) |
| **WhatsApp test says 401** | API key mismatch | The key in **Communication → WhatsApp** must equal `WAHA_API_KEY` in `.env` — not `WAHA_DASHBOARD_PASSWORD` |
| **The WAHA dashboard rejects your login** | You are entering the API key. The dashboard uses basic auth | Use `WAHA_DASHBOARD_USERNAME` (`admin`) and `WAHA_DASHBOARD_PASSWORD` from `.env` ([§19.3](#193-waha-has-two-different-credentials)) |
| **The WAHA dashboard password changes after every restart** | `WAHA_DASHBOARD_PASSWORD` is unset or weak, so WAHA generates a random one each start and prints it only to `docker compose logs waha` | Set a strong value in `.env` (`ops/init-env.ps1` does) and `docker compose up -d`. WAHA rejects `admin`, `waha`, `123`, empty and all-zeros |
| **Everything is slow on Windows** | WSL2 cross-filesystem I/O | Keep the repository inside the WSL filesystem, not under `C:\Users\...` |
| **A rebuild seems to change nothing — the old screen keeps appearing** | The browser is reusing a cached `index.html`, which names the hashed bundles, so it keeps loading the previous build's assets | Fixed in `apps/web/nginx.conf`: `index.html` and API responses are now `no-store`, hashed assets `immutable`. Rebuild the web image (`docker compose up -d --build web`) and hard-refresh once (**Ctrl+F5**); after that every deploy is picked up automatically |
| **An edit saves and shows on one screen but another still shows the old value** | Same cause — a cached API response, or a cached bundle | As above. The API proxy now sends `Cache-Control: no-store` |
| **No demo data after `start-docker.ps1`** | Everything that seeds the database happens in the one-shot `db-init` container. `docker compose up -d` returns as soon as containers are *created*, so a failure there used to be silent | `start-docker.ps1` now reports db-init's exit code and counts the employees. To see what happened: `npm run docker:logs` (or `docker compose logs db-init`). To seed or re-seed: `npm run docker:demo` (or `docker compose run --rm -e DEMO_RESEED=true db-init`) |
| **`npm run db:demo` on the host says ts-node is not installed** | That is a FROM-SOURCE command. In Docker mode the host has no Node dependencies and needs none | Use `npm run docker:demo` instead. The error message now says this when it detects a Docker folder |
| **A new release behaves like the old one — fixes missing, no demo data, old screens** | `compose.yaml` pins fixed, untagged image names (`e360-api`, `e360-web`, `e360-api-tools`). Plain `docker compose up -d` **reuses an image of that name built from any other folder**, so unzipping a new release beside an old one silently runs the OLD code. The project name is pinned too (`name: e360`), so the database volume is shared as well | `start-docker.ps1` now builds by default, which fixes it. With plain Compose, always use `docker compose up -d --build` after taking a new release. To prove which code is running: `docker image inspect e360-api --format '{{.Created}}'` |
| **`start-docker.ps1` aborts with `NativeCommandError`** | Windows PowerShell turns anything a native tool writes to **stderr** into an error, and under `$ErrorActionPreference = 'Stop'` that is fatal. Docker printed its "Found multiple config files" warning to stderr on every command, because this folder holds both `compose.yaml` and `docker-compose.yml` | Fixed three ways in the script: the compose file is pinned with `-f compose.yaml` so the warning never appears, the global `'Stop'` is gone (matching `deploy.ps1`, which documents the same trap), and captured native calls run through a helper that neutralises stderr |
| **No demo data after starting** | Everything that seeds the database happens in the one-shot `db-init` container, and `docker compose up -d` returns as soon as containers are *created* — a failure there was silent | Check what it did: `docker compose logs db-init`. Seed or re-seed: `docker compose run --rm -e DEMO_RESEED=true db-init` |
| **`npm run db:demo` on the host says ts-node is not installed** | That is a FROM-SOURCE command; in Docker mode the host has no Node dependencies and needs none | Use `docker compose run --rm -e DEMO_RESEED=true db-init`. The message now says this when it detects a Docker folder |
| **A licence banner appears, or modules are missing** | No licence installed, or the licence excludes those modules | Install the licence under **Licence** in the menu. Set `LICENSE_PUBLIC_KEY` in `.env` first, or licences cannot be verified. The licence is stored in PostgreSQL and survives restarts. See `LICENSING.md` |
| **The sign-in page shows the wrong client** | `DEFAULT_ORG_SLUG` / `BRAND_*` not set for this deployment | Set them in `.env` beside `compose.yaml` and `docker compose up -d`. They are read at RUNTIME — no image rebuild. See `WHITE_LABEL.md` |
| **Parents receive links containing `localhost`** | `PUBLIC_APP_URL` is still the default, so links point at the recipient's own machine | Set `PUBLIC_APP_URL` in `.env` beside `compose.yaml` to the address people actually type — `http://192.168.1.20:8080` on a LAN, or your https domain — then `docker compose up -d`. Never a service name such as `http://web:80`: those resolve only inside the container network. `start-docker.ps1` now warns when it is left at localhost, and the API logs the effective value at startup |
| **A `db:*` command dies with `Cannot read properties of undefined (reading 'fileExists')`** | The give-away is `_npx` in the stack-trace path. `ts-node` was not installed in that folder, so `npx` quietly downloaded its own copy — without the `typescript` it needs — and ran that | Run `npm install` (or `.\deploy.ps1`) in that folder first. The `db:*` scripts no longer go through `npx`, so this situation now reports the missing dependency in one plain sentence instead of a stack trace |
| **Data disappeared** | `docker compose down -v` was run | The volume is gone; restore from a dump ([§14](#14-backup-and-restore)). Use `down` without `-v` in future |
| **Demo data still shows old content after an upgrade** | The volume was first seeded by an older build, and `db:demo`'s marker guard stops it re-seeding. Rebuilding the image does not help | `docker compose run --rm -e DEMO_RESEED=true db-init` ([§15](#15-resetting-the-environment)) |

### Collecting everything for a support request

```powershell
docker compose ps > diag.txt
docker compose logs --tail=200 >> diag.txt
docker compose exec api node -e "require('http').get('http://localhost:3000/ready',r=>{r.pipe(process.stdout)})" >> diag.txt
```

Check `diag.txt` for secrets before sending it anywhere.
