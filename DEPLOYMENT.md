# Deployment Manual — Enterprise 360 Feedback System

For the system administrator deploying and upgrading the application. Everything here is
verified against this repository; where a command is shown, it is the command that works.

**Docker is the supported deployment.** The from-source workflow is for development only
and is covered in `README.md`.

| I want to... | Go to |
|---|---|
| Deploy for the first time | [Part 1](#part-1--initial-deployment) |
| Upgrade a working installation | [Part 2](#part-2--upgrade-deployment) |
| Undo a bad upgrade | [Part 3](#part-3--rollback) |
| Understand the Docker architecture | [Part 4](#part-4--docker-architecture) |
| Fix a startup problem | [Part 6](#part-6--troubleshooting) |
| Install or renew a licence | `LICENSING.md` |
| Back up or restore data | `ops/BACKUP_RESTORE.md` |
| Release mechanics in depth | `ops/RELEASES.md` |
| Every environment variable | `.env.docker.example` (annotated) and `ops/DOCKER.md` |

---

## Part 1 — Initial deployment

### 1.1 Prerequisites

| Requirement | Notes |
|---|---|
| **Docker Desktop** (Windows/macOS) or Docker Engine + Compose v2 (Linux) | Must provide `docker compose` (v2). Standalone `docker-compose` v1 is not supported |
| **8 GB RAM** available to Docker | Six containers, one of which runs a browser engine |
| **20 GB free disk** | Images are roughly 4 GB, plus volumes and retained releases |
| **Windows PowerShell 5.1** or later | For the `.ps1` scripts. No extra modules required |
| Ports **8080, 3000, 3100, 3001, 5432** free | All configurable — see §1.4 |

No internet access is required at run time. See `LICENSING.md` for air-gapped operation.

### 1.2 Required directory structure

Unzip the release. The folder must contain at least:

```
compose.yaml            the full stack definition
.env.docker.example     the environment template
ops\                    init-env.ps1, docker-init.sh, backup/restore, deploy/rollback
database\               000_initial_schema.sql, 001_reconcile.sql
start-docker.ps1        first-run / development entry point
```

A package built with `ops\make-release.ps1` also contains `images\*.tar` and
`load-images.ps1`. **If those are present, load the images and do not build:**

```powershell
.\load-images.ps1
.\start-docker.ps1 -NoBuild
```

### 1.3 Create the environment file

```powershell
cd "C:\path\to\Enterprise360_App_2026-08-28-v1"
.\ops\init-env.ps1
```

This copies `.env.docker.example` to `.env` and generates the four values Compose refuses to
start without. **Re-running it never overwrites a secret you already have**, so it is safe
on a working install.

| Generated | Why it cannot have a default |
|---|---|
| `JWT_ACCESS_SECRET` | Signs sessions. A published default would let anyone mint a token |
| `MFA_ENCRYPTION_KEY` | 64 hex characters. **Also encrypts HR and SIS provider credentials** |
| `WAHA_API_KEY` | The `X-Api-Key` the application sends to WAHA |
| `WAHA_DASHBOARD_PASSWORD` | Unset, WAHA randomises it on every start and prints it only to its own log |

> **WARNING — back up `MFA_ENCRYPTION_KEY` with your database.** It encrypts the HR and SIS
> provider secrets held in PostgreSQL. Lose it and those are unrecoverable: every provider
> credential must be re-entered and every MFA user re-enrolled.

### 1.4 Settings to review before the first start

Edit `.env`. Every other variable has a working default.

```env
ORG_NAME=CARE Pvt. Ltd.              # the first tenant, created once by db-init
ORG_SLUG=care                        # what users type at sign-in
ADMIN_EMAIL=admin@carepvtltd.com
ADMIN_PASSWORD=ChangeThisNow!
DEFAULT_ORG_SLUG=care                # which tenant the sign-in page belongs to
PUBLIC_APP_URL=http://192.168.1.50:8080
SEED_DEMO_DATA=true                  # false gives a clean tenant: admin + roles, no demo content
```

> **`PUBLIC_APP_URL` is the setting people get wrong.** Every outgoing link — parent
> evaluation invitations, password resets, QR codes — is built from it. Left at `localhost`
> on a shared server, recipients get a link to **their own** computer: delivered, token
> spent, dead. Set it to the address users will actually type.

Ports, if the defaults clash:

```env
WEB_PORT=8080        API_PORT=3000        MOCK_SIS_PORT=3100
WAHA_PORT=3001       POSTGRES_PORT=5432
```

### 1.5 Start

```powershell
.\start-docker.ps1
```

It checks Docker, creates `.env` if missing, validates the Compose configuration **before**
building anything, then runs `docker compose up -d --build`.

The first run builds four images: **5–15 minutes.** Later runs take seconds.

`-NoBuild` skips the build. Use it only with a release package whose images you have loaded
— otherwise you run whatever images already exist, possibly an older release unzipped
elsewhere.

### 1.6 What database initialisation does

`db-init` is a one-shot container that runs on every start and exits. Every step is
idempotent, so there is no separate first-run command to remember. In order:

1. Creates the `mock_sis` database alongside the main one.
2. Applies `database/000_initial_schema.sql`, then `database/001_reconcile.sql`, and stamps
   `schema_migrations`.
3. Seeds the permission catalogue and the five system roles
   (**Super Admin, HR/Admin, Manager, Employee, Viewer**).
4. Bootstraps the tenant from `ORG_NAME` / `ORG_SLUG` / `ADMIN_EMAIL` / `ADMIN_PASSWORD`.
5. Seeds demo content when `SEED_DEMO_DATA=true`.
6. Pushes and seeds the Mock SIS schema.

**There is no migration tool to run by hand.** The SQL is hand-maintained and applied on
every start. `001_reconcile.sql` is additive and idempotent — 643 `IF NOT EXISTS`
statements, and no `DROP`, `TRUNCATE`, `DELETE` or `SET NOT NULL`.

### 1.7 Install the licence

Full procedure in **`LICENSING.md`**. In short: sign in as the administrator, open
**Licence** in the menu, paste the licence you were sent, press **Install licence**.

### 1.8 Verify the deployment

```powershell
docker compose -f compose.yaml ps
```

All six long-running containers should be `running`, and `e360-db-init` `exited (0)`.

```powershell
curl http://localhost:3000/health          # liveness - 200 whenever the process is up
curl http://localhost:3000/ready           # readiness - database, redis, schema version
curl http://localhost:8080/                # web
curl http://localhost:3100/api/v1/health   # Mock SIS - note it IS under /api/v1
```

A healthy `/ready` reports `"status":"ok"` with `database: up`. `"degraded"` means Redis is
down (delivery falls back to inline) **or** the applied schema version trails the build.
Both are reported; neither stops the application.

Then sign in at `PUBLIC_APP_URL` with organisation `care` and your `ADMIN_EMAIL`.

---

## Part 2 — Upgrade deployment

> **The whole application is one release.** `e360-api`, `e360-web`, `e360-mock-sis` and
> `e360-api-tools` are built, verified and rolled back **together**. An old web image with a
> new API is not a state this process can produce.

### 2.1 Use the release script, not `start-docker.ps1`

`start-docker.ps1` rebuilds images in place. Because `compose.yaml` pins **untagged** names
(`image: e360-api`), the previous image becomes nameless — and a nameless image is deleted
by `docker image prune`, `docker system prune` and Docker Desktop's **Clean up** button.

For a working installation you cannot afford to lose:

```powershell
.\ops\deploy-release.ps1
```

### 2.2 What it does, in order

```
1  PRE-FLIGHT    Docker running, .env present, compose config valid, >= 5 GB free
                 -> nothing has changed yet; a failure here costs nothing

2  IDENTIFY      which images the running containers are actually using

3  BACK UP       pg_dump through the container  -> backups\db-<id>-prev.dump
                 tag all four images            -> e360-*:<id>-prev
                 write the manifest             -> releases\<id>-prev\manifest.json
                 -> if this fails, the deployment STOPS. Nothing destructive has run

4  BUILD         docker compose build
                 -> does NOT touch running containers. A failure leaves the
                    application serving on the previous release

5  START         docker compose up -d

6  HEALTH        wait for postgres, redis, api, web, mock-sis to report healthy
                 confirm db-init exited 0

7  SMOKE         /health, /ready, web /, mock-sis /api/v1/health,
                 SELECT count(*) FROM employees

8  SUCCESS       tag the new images, write the manifest, mark it current,
                 apply retention (5 releases by default)

9  FAILURE       restore the previous release automatically, as a complete set
```

Switches: `-Keep N` (retention), `-Timeout N` (health wait, default 180s),
`-SkipDbBackup`, `-WhatIfDeploy` (back up and stop, changing nothing else).

### 2.3 Pre-deployment checklist

- [ ] Read the release notes for schema or configuration changes
- [ ] At least 10 GB free disk
- [ ] Know which release is current: `.\ops\rollback.ps1 -List`
- [ ] Full backup taken if this is production (`ops\BACKUP_RESTORE.md`)
- [ ] Users told — the stack is briefly unavailable during step 5
- [ ] Licence to hand if the edition or expiry is changing

### 2.4 What happens if it fails

| Fails at | Result |
|---|---|
| Pre-flight | Nothing changed. Application still serving |
| Backup | **Deployment stops.** Nothing changed |
| Build | Application still serving on the previous release; previous tags intact |
| Health or smoke | **Automatic rollback** to the release captured in step 3 |
| The rollback itself | Reported explicitly, with the manifest path and the manual commands |

The dump taken in step 3 is **never restored automatically** — that would discard everything
written since. Its path is printed so you can restore it deliberately.

---

## Part 3 — Rollback

### 3.1 When to roll back

- The new release fails health or smoke checks (this happens automatically)
- A defect appears after deployment that is worse than the problem you were fixing
- A configuration or licence change has made the application unusable

**Do not roll back to escape a data problem.** Image rollback restores code, not data.

### 3.2 Find the previous known-good release

```powershell
.\ops\rollback.ps1 -List
```

```
RELEASE                CREATED               VERIFIED   IMAGES
2026-09-01-1420        2026-09-01T14:20:03Z  yes        4/4
2026-09-02-0930        2026-09-02T09:30:11Z  yes        4/4  <- current
```

**A release showing fewer than 4/4 cannot be rolled back to**, and is listed in red.

### 3.3 Restore

```powershell
.\ops\rollback.ps1 -Previous                    # one release back
.\ops\rollback.ps1 -Release 2026-09-01-1420     # a specific one
```

You are asked to type the release id to confirm (`-Force` skips this). Then:

1. **Verifies every image exists.** If any is missing it aborts **before** stopping
   anything, and the application keeps serving.
2. `docker compose down` — containers only; **volumes are not touched**.
3. Re-points all four image names from the **one** manifest.
4. `docker compose up -d --no-build`.
5. Waits for health and re-runs the smoke checks.

### 3.4 Verify the rollback

```powershell
docker compose -f compose.yaml ps
curl http://localhost:3000/ready
```

Then sign in and confirm the behaviour you rolled back to is the behaviour you get.

### 3.5 What rollback does NOT restore

| | Restored? |
|---|---|
| Application code (all four images) | **Yes** |
| PostgreSQL data (`pgdata`) | **No** |
| Redis queue (`redisdata`) | No |
| WhatsApp session (`waha_sessions`, `waha_media`) | No |
| `.env` and its secrets | No |
| The installed licence | No — it lives in PostgreSQL and does not need to be |

### 3.6 Database migration considerations

**Schema changes are forward-only.** Nothing reverses them.

Today this is safe: `001_reconcile.sql` is additive and idempotent, so rolled-back code runs
against a database with extra columns it simply ignores. After a rollback `/ready` reports
**`degraded`** with a schema mismatch — expected, and not a failure, because readiness is
gated on the database being *up*, not on the schema matching.

> **WARNING.** The moment a release drops a column, renames one, or adds `NOT NULL` without
> a default, image rollback alone stops being sufficient. That is what the pre-deployment
> dump is for. Restoring it discards everything written since it was taken, so it is a
> deliberate decision — see `ops\BACKUP_RESTORE.md`.

---

## Part 4 — Docker architecture

```
Enterprise 360 (compose project "e360")
    |
    +-- APPLICATION IMAGES  (built here; versioned and rolled back as ONE release)
    |     e360-web          nginx + the built SPA
    |     e360-api          the NestJS API
    |     e360-mock-sis     standalone vendor SIS simulator
    |     e360-api-tools    db-init: applies the SQL, runs the seed chain
    |
    +-- UPSTREAM IMAGES     (never built here, never rolled back)
    |     postgres:16-alpine
    |     redis:7-alpine
    |     devlikeapro/waha:latest
    |
    +-- PERSISTENT DATA     (survives every deployment and every rollback)
          pgdata          everything: organisations, employees, cycles, scores, licence
          redisdata       BullMQ delivery queue
          waha_sessions   the linked WhatsApp session
          waha_media      WhatsApp media
```

**There is no separate worker service.** BullMQ runs in-process inside the API and falls
back to inline delivery when Redis is unavailable.

### Services

| Service | Image | Container | Host port | Depends on | Health check |
|---|---|---|---|---|---|
| postgres | `postgres:16-alpine` | `e360-postgres` | 5432 | — | `pg_isready` |
| redis | `redis:7-alpine` | `e360-redis` | not published | — | `redis-cli ping` |
| db-init | `e360-api-tools` | `e360-db-init` | — | postgres healthy | none — one-shot, judged by exit code |
| api | `e360-api` | `e360-api` | 3000 | postgres + redis healthy, db-init completed | `GET /health` |
| web | `e360-web` | `e360-web` | 8080 | api started | `wget /` |
| mock-sis | `e360-mock-sis` | `e360-mock-sis` | 3100 | postgres healthy, db-init completed | `GET /api/v1/health` |
| waha | `devlikeapro/waha:latest` | `e360-waha` | 3001 | — | `wget /ping`, 90s start period |

Network: one bridge network, `e360`. **Inside Docker, services address each other by service
name, never `localhost`** — the API reaches `postgres:5432`, `redis:6379`, `mock-sis:3100`
and `waha:3000`; nginx proxies `/api/v1` to `api:3000`.

### Images versus data

| Docker images hold | Volumes and configuration hold |
|---|---|
| Application code | All business data |
| Node dependencies | The installed licence |
| The compiled SPA | Uploaded content |
| The SQL migration files | The linked WhatsApp session |
| The compiled licence verification key | Every secret in `.env` |

Rebuilding images never touches data. Restoring images never restores data.

---

## Part 5 — Backup

Full runbook: `ops\BACKUP_RESTORE.md`. Before a production upgrade, back up **all four**:

| # | What | How |
|---|---|---|
| 1 | **Application images** | `ops\deploy-release.ps1` does this automatically (tags + manifest) |
| 2 | **Database** | `ops\backup.ps1`, or the automatic pre-deployment dump |
| 3 | **Volumes** | `waha_sessions` if WhatsApp is linked — otherwise a QR re-scan is needed |
| 4 | **Configuration** | **Copy `.env` somewhere safe.** It is gitignored and irreplaceable |

---

## Part 6 — Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `up` fails citing `JWT_ACCESS_SECRET` or `MFA_ENCRYPTION_KEY` | `.env` missing or the secret is blank | `.\ops\init-env.ps1` |
| `WAHA_DASHBOARD_PASSWORD` error | Same | Same |
| Web loads, every API call fails | API not healthy | `docker compose logs api --tail 50` |
| Application loads but is empty | `db-init` failed | `docker compose logs db-init`, then `docker compose run --rm db-init` |
| No demo data although `SEED_DEMO_DATA=true` | The volume was seeded by an older build; the marker guard keeps the old data | `docker compose run --rm -e DEMO_RESEED=true db-init` |
| Feedback links contain `localhost` | `PUBLIC_APP_URL` not set | Set it in `.env`, then `docker compose up -d` — recreates the API, no rebuild |
| Licence page reports no verification key | The build carries no trusted key | See `LICENSING.md`. On a release build this means the build is faulty — contact the supplier |
| "Found multiple config files" warning | Both `compose.yaml` and `docker-compose.yml` exist | Harmless. The scripts pin `-f compose.yaml` |
| `NativeCommandError` from a `.ps1` | Windows PowerShell promotes Docker's stderr to an error | Already handled in the shipped scripts. Do not add `$ErrorActionPreference = 'Stop'` |
| Changes did not take effect | Ran with `-NoBuild`, or an image of the same name exists from another folder | Re-run without `-NoBuild` |
| WAHA unhealthy for the first minute | It boots a browser engine (90s start period) | Wait. It is excluded from the deployment health gate for this reason |

```powershell
docker compose -f compose.yaml ps
docker compose -f compose.yaml logs -f api
docker compose -f compose.yaml logs db-init
docker compose -f compose.yaml restart api
docker compose -f compose.yaml down          # stops; KEEPS data
```

> **WARNING — `docker compose down -v` deletes every volume**, including the database and
> the WhatsApp session. There is no undo, and it is never part of a normal deployment.

---

## Appendix — development from source

Not a deployment path. `README.md` has the full sequence; in short:

```powershell
npm install
npm run db:up            # PostgreSQL + Redis only (docker-compose.yml)
npm run db:apply         # schema + reconcile
npm run db:seed
npm run -w apps/api db:bootstrap-tenant -- --org "CARE Pvt. Ltd." --slug care --email admin@carepvtltd.com --password 'ChangeThisNow!'
npm run db:seed-roles
.\start-dev.ps1
```

> **Note the `-w apps/api`.** The root `db:bootstrap-tenant` script is itself an `npm run`,
> and the second npm hop swallows everything after `--` as npm configuration — the
> administrator is then created with the default password and no error.

A development build carries the built-in development licence (all modules, unlimited
employees), labelled as such in the UI. See `LICENSING.md` §4.
