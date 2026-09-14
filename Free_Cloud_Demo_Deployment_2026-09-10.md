# Free-Cloud Demo Deployment — Enterprise 360 Feedback System

**Date:** 2026-09-10 · **Goal:** existing Docker application → free cloud → public HTTPS URL → test/demo · **Not production.**

Everything below was checked against your actual `compose.yaml`, `compose.prod.yaml`, both Dockerfiles, `apps/web/nginx.conf`, `ops/docker-init.sh` and `.env.docker.example`. Where a number appears, I measured it on a real run of your code rather than estimating it — those measurements are marked **[measured]**.

---

## 1. What your stack actually needs

From `compose.yaml`, seven services exist. They are not equally necessary:

| Service | Image / build | Required for a demo? | Why |
|---|---|---|---|
| **postgres** | `postgres:16-alpine` | **Yes** | The only thing that must persist. Everything else is stateless |
| **api** | `apps/api/Dockerfile` target `runtime` | **Yes** | NestJS, listens on `$PORT` (default 3000) |
| **web** | `apps/web/Dockerfile` (nginx) | **Yes** | Static SPA + reverse proxy for `/api/v1` and the short-link path `/r/` (its config also proxies `/qr/`, which no backend route currently serves) |
| **db-init** | same Dockerfile, target `tools` | One-shot | Applies the SQL schema, seeds permissions/roles, creates the tenant + admin, optionally demo data. Exits |
| **redis** | `redis:7-alpine` | **No** | Optional by design. Without it the API falls back to inline delivery |
| **mock-sis** | `apps/mock-sis/Dockerfile` | **No** | Test fixture. `compose.prod.yaml` already sets `replicas: 0` |
| **waha** | `devlikeapro/waha` | **No** | Optional WhatsApp gateway. `compose.prod.yaml` already sets `replicas: 0` |

`compose.prod.yaml` has effectively already made this decision for you: it scales mock-sis and WAHA to zero and stops publishing the Postgres and API ports. A free-cloud demo is the same shape, minus Redis.

### Measurements that decide what will fit

| What | Value | How it was obtained |
|---|---|---|
| Fully seeded demo database | **13 MB** | **[measured]** — schema + `db:sample` + `db:demo`, then `pg_database_size()` (13,310,999 bytes) |
| Compressed dump of that database | **325 KB** | **[measured]** — `pg_dump -Fc` (332,879 bytes) |
| API resident memory, idle | **128 MB** | **[measured]** — `dist/main.js`, `NODE_ENV=production` |
| API resident memory, after sign-in + org chart + employees + cycles | **135 MB** | **[measured]** |
| API cold start to `/health` = 200 | **1.5 s** | **[measured]** |
| API with **no Redis** | `/ready` → HTTP **200**, `{"status":"ok","ready":true,"redis":{"status":"skipped"}}` | **[measured]** — with `REDIS_HOST` unset the probe is skipped, not failed |
| Disk written by the app at runtime | **none** | No `multer`, no `UploadedFile`, no `writeFileSync`/`createWriteStream` anywhere in `apps/api/src`. Imports arrive as base64 JSON and are parsed in memory (`org-import/services/parse.service.ts`) |
| WebSockets | **none** | No gateway, no `socket.io` |
| Scheduled jobs | **4** | `reminder.service` hourly, `hr-sync` hourly, `sis-sync` hourly, `report-schedule` daily 07:00 |

The two numbers that matter most: **13 MB of data** and **135 MB of RAM**. Your application fits inside a free tier comfortably. The constraint will be CPU and sleep, not size.

---

## 2. The three genuinely free options

I checked the platforms that still have a real free tier in September 2026. Three are worth your time.

| | **Render** | **Northflank** | **Oracle Cloud Always Free** |
|---|---|---|---|
| **Shape** | PaaS — one service per container | PaaS — projects with several services | A plain VM you own |
| **Free tier limits** | 512 MB RAM instances; 5 GB bandwidth/mo; 500 build minutes/mo; up to 25 services on the free Hobby workspace | 2 services + 1 database + 2 cron jobs ("developer sandbox") | 2 Arm cores + 12 GB RAM total (**halved from 4/24 on 15 June 2026, with no announcement**), plus 2 small x86 VMs; 200 GB block storage |
| **Docker support** | Native. Builds your Dockerfile, or deploys a prebuilt image from a registry | Native. Dockerfile or registry image | Total — it is Docker. `docker compose up -d` runs your stack unchanged |
| **PostgreSQL** | Managed free Postgres: 1 GB storage, 256 MB RAM, **expires 30 days after creation** (14-day grace) | 1 free database addon | Your own `postgres:16-alpine` container, no size limit |
| **RAM / CPU** | 512 MB / 0.1 vCPU per free instance | Not published for the sandbox tier | Up to 12 GB / 2 Arm cores |
| **Storage** | No persistent disks on free instances (fine — your app writes none) | Addon storage only | 200 GB |
| **Sleep / idle** | **Spins down after 15 min with no inbound traffic; ~1 min to wake** | **Always on, no sleeping** | Always on |
| **Public URL / HTTPS** | Automatic `*.onrender.com` with managed TLS; custom domains free | Automatic HTTPS URL | None — you install Caddy or nginx and point a domain at it yourself |
| **Env vars / secrets** | Dashboard per service; also become Docker build args | Dashboard per service | Your `.env` file |
| **Credit card** | **Not required to start** | **Required** — "all users must add a payment method to start creating resources… regardless of plan" | **Required** for account verification |
| **The catch for this app** | The front-end container cannot reach the API over Render's private network — free services *can send* private requests but *cannot receive* them. And no shell or one-off jobs on free, so `db-init` cannot be run there | Card up front; sandbox resource sizes undocumented, so the API may or may not fit | Signing up and actually getting Arm capacity is the hard part; then you administer a server |

**Ruled out, and why:** **Fly.io** withdrew its free allowances — there is no free tier to deploy into. **Railway** replaced its free tier with one-time trial credit. **Koyeb** does still have a free tier, but it is *one* service per organisation (you need two) and its free Postgres is capped at **5 hours of active time**, which cannot host a demo anyone can visit.

---

## 3. Recommendation

# → Render

### Why

1. **No credit card.** Northflank and Oracle both demand one before you create anything. You asked for genuinely free; Render is the only one of the three you can finish today without reaching for a card.
2. **It builds your Dockerfiles as they are.** Point it at the repo, give it `./apps/api/Dockerfile`, and it builds the same image `docker compose build` does. Multi-stage works, and your final stage is already `runtime` — the stage Docker builds by default — so nothing needs changing.
3. **The database is in the same dashboard,** with an internal connection string, and your services can reach it (free services *can* make outbound private-network calls, they just cannot receive them).
4. **HTTPS and a public URL are automatic,** which is the actual deliverable here.
5. **It fits.** 512 MB against a **[measured]** 135 MB, and 1 GB of database against a **[measured]** 13 MB.

### What you are accepting

- **The API sleeps after 15 minutes** and takes about a minute to wake. Your app boots in 1.5 s **[measured]** — the minute is Render starting the container, not your code. The first visitor after a quiet spell waits; everyone after that does not.
- **The free database expires 30 days after you create it.** For a demo that is usually fine. §11 says how to swap in a permanent free Postgres if it is not.
- **0.1 vCPU is slow.** Report generation and bulk parent-link generation will take noticeably longer than on your laptop. This is the real limit, not memory.
- **Hourly and daily scheduled jobs will not fire reliably**, because a sleeping instance runs nothing. See §10.

---

## 4. How your Compose stack maps onto Render

| Compose service | On Render | Note |
|---|---|---|
| `postgres` | **Render Postgres** (free) | Created from the dashboard, not from your image |
| `api` | **Web Service**, Docker, `./apps/api/Dockerfile` | Unchanged image |
| `web` | **Static Site** (recommended) or a second Web Service | See below |
| `db-init` | **Run locally, then copy the result up** | Free instances have no shell and no one-off jobs, so it runs against your local Postgres and the seeded database is restored into the cloud (§3) |
| `redis` | Omitted | App degrades gracefully; add Render Key Value free later if you want the queue |
| `mock-sis` | Omitted | Already `replicas: 0` in your prod overlay |
| `waha` | Omitted | Needs a persistent session volume and a QR scan from a real phone |

### The one adaptation, and why it is needed

Your `web` image is nginx doing two jobs: serving `apps/web/dist`, and proxying `/api/v1/` and `/(r|qr)/` to `http://api:3000`. That hostname only resolves inside a Docker network. On Render's free tier it cannot be made to resolve, because **a free web service cannot receive private-network requests** — that is documented platform behaviour, not a configuration mistake.

So the front end has to reach the API by its public URL. Two ways:

**Option A — Static Site (recommended; no code changes at all).** Render serves `apps/web/dist` and does the proxying itself with a rewrite rule. Render static sites are always free and **never sleep**, so only the API has a cold start. The SPA is byte-identical to the one inside your web image — same `npm run build:web`.

**Option B — keep the web Docker image.** Requires a five-line, backward-compatible patch to `apps/web/Dockerfile` so the proxy target is a build argument. Given in §12, and I have tested it. Use this if you specifically want both tiers running as containers.

The rest of this runbook uses **Option A**.

---

## 5. Prerequisites

**On your machine**

- Docker Desktop, already working — you need it to seed and dump the database locally.
- Your app folder with the stack running once: `docker compose up -d` reaching `http://localhost:8080`.
- Git.

**Pre-flight check — do this first, and do not skip it.** The copy of the repository I reviewed is incomplete in two ways that would each break the build on Render. Both take ten seconds to rule out on your machine, and both would otherwise fail several minutes into a remote build with an unhelpful message.

**(a) All four workspace manifests must exist.** The API Dockerfile copies them before `npm ci`:

```powershell
cd "D:\AI 360 Feedback\360 FBS App\Enterprise360_App_2026-08-28-v1"
Get-ChildItem apps\api\package.json, apps\web\package.json, apps\mock-sis\package.json, packages\shared-types\package.json
```

All four must be listed. *In my copy `apps/mock-sis` is absent entirely*, which would break `apps/api/Dockerfile` (two `COPY` lines), `apps/web/Dockerfile`, the `mock-sis` compose service and the last step of `ops/docker-init.sh`.

**(b) `apps/web` must be listed in the root `workspaces` array.** Both `npm run build:web` and the web Dockerfile's build step run `npm --workspace apps/web run build`, which fails with *"No workspaces found"* if it is not:

```powershell
node -e "console.log(require('./package.json').workspaces)"
```

You want to see `apps/api`, `apps/web`, `apps/mock-sis` and `packages/*`. *In my copy the array is only `["apps/api", "packages/*"]`, even though `package-lock.json` still carries `apps/web` and `apps/mock-sis` entries* — again, almost certainly an artefact of the partial copy, since `npm run build:web` clearly runs on your machine. But confirm it, because if it is real on your side then neither the static-site build command in Step 5 nor the web image in Option B can work until it is fixed.

**Accounts**

- **GitHub** — required. Render deploys from a repository. Private repositories are fine.
- **Docker Hub** — not required. It is an alternative if you would rather build locally and push an image (§12).
- **Render** — sign up with GitHub. No card.

---

## 6. Deployment steps

### Step 0 — choose your two service names first

Render URLs are `https://<service-name>.onrender.com`, and each side needs to know the other's URL. Decide now and the whole thing is a straight line. This runbook uses:

- API service: `e360-api` → `https://e360-api.onrender.com`
- Front end: `e360-web` → `https://e360-web.onrender.com`

Names are globally unique, so add a suffix if they are taken — and use your real names everywhere below.

### Step 1 — push the repository to GitHub

```powershell
cd "D:\AI 360 Feedback\360 FBS App\Enterprise360_App_2026-08-28-v1"
git init                       # skip if it is already a repository
git add -A
git commit -m "Deploy to Render"
git branch -M main
git remote add origin https://github.com/<you>/enterprise-360.git
git push -u origin main
```

Your `.gitignore` already excludes `node_modules/`, `dist/` and every `.env`, so nothing secret travels. The push is about 34 MB.

### Step 2 — create the database

Render dashboard → **New → Postgres**.

- Name `e360-db`, PostgreSQL **16**, region **Frankfurt** (or whichever is nearest your audience — *use the same region for every service*), instance type **Free**.
- Once created, copy both connection strings from the database's Info page: the **Internal Database URL** (for the API) and the **External Database URL** (for you, from your laptop).

### Step 3 — load the database from your laptop

Free instances have no shell and no one-off jobs, so `db-init` cannot run on Render. It does not need to: seed locally with the machinery you already have, then copy the result up. This is also the safer path — the cloud database never runs the seed scripts at all.

**3a. Get the database you want, locally.**

With demo content (50 employees, 6 cycles, scored feedback, SIS roster):

```powershell
docker compose up -d
```

Or a clean tenant — administrator, permissions and the five roles, nothing else. Set it in `.env`, not on the command line: `db-init` runs on *every* `up`, so a one-off `-e SEED_DEMO_DATA=false` would be undone by the next `docker compose up -d` reading `SEED_DEMO_DATA=true` from `.env` and seeding the demo content after all.

```powershell
docker compose down -v          # discards the current volume — take a dump first if you need it
notepad .env                    # set SEED_DEMO_DATA=false (and your own ADMIN_EMAIL / ADMIN_PASSWORD)
docker compose up -d
```

> **Before you publish demo data.** The demo tenant ships every sample user with the password `Password123!`, and `.env.docker.example` sets the administrator to `sajidq@carepvtltd.com` / `Password123!`. On a URL anyone can reach, change the administrator password in the application before you share the link — or set your own `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `.env` before the first `up`.

**3b. Dump it.** Write the dump inside the container and copy it out — this avoids PowerShell mangling binary data on `>`:

```powershell
docker compose exec -T postgres pg_dump -U postgres -d enterprise360 --no-owner --no-acl -Fc -f /tmp/e360.dump
docker compose cp postgres:/tmp/e360.dump .\e360-demo.dump
```

`--no-owner --no-acl` matters: Render's database user is not `postgres`, and without these the restore fails on ownership.

**3c. Restore into Render** using the **External** Database URL:

```powershell
docker run --rm -v "${PWD}:/w" postgres:16-alpine `
  pg_restore --no-owner --no-acl -d "<EXTERNAL_DATABASE_URL>?sslmode=require" /w/e360-demo.dump
```

**[measured]** — this exact dump/restore was rehearsed end to end: 325 KB dump, clean restore, verified afterwards as 50 employees, 2,385 feedback responses, schema version `2026.08.21-01`. `pgcrypto` is carried inside the dump.

The schema needs the `pgcrypto` extension. It is in the dump, and Render lets the database user run `CREATE EXTENSION` on PostgreSQL 13+. If the restore does complain, open the **PSQL Command** on the database Info page, run `CREATE EXTENSION IF NOT EXISTS pgcrypto;`, and re-run the restore.

**3d. Verify:**

```powershell
docker run --rm postgres:16-alpine psql "<EXTERNAL_DATABASE_URL>?sslmode=require" `
  -c "SELECT version FROM schema_migrations ORDER BY applied_at DESC LIMIT 1;" `
  -c "SELECT count(*) AS employees FROM employees;"
```

The version must read **`2026.08.21-01`** — that is what `EXPECTED_SCHEMA_VERSION` in `health.service.ts` compares against, and a mismatch makes `/ready` report a schema problem.

### Step 4 — deploy the API

**New → Web Service** → connect your GitHub repository.

| Setting | Value |
|---|---|
| Name | `e360-api` |
| Region | **same as the database** |
| Branch | `main` |
| Root Directory | *(leave blank — the Dockerfile expects the repo root as build context)* |
| Language / Runtime | **Docker** |
| Dockerfile Path | `./apps/api/Dockerfile` |
| Instance Type | **Free** |
| Health Check Path | `/health` |

`/health` sits at the root, outside the `/api/v1` prefix — that is deliberate in `main.ts`, and it is the right path for Render's check. `/ready` would also work — it answers 200 — but `/health` is the simpler signal: it means "the process is up", with no dependency checks folded in.

Add the environment variables from §7, then **Create Web Service**. The first build takes several minutes (`npm ci` across the workspace, Prisma generate, `nest build`).

### Step 5 — deploy the front end

**New → Static Site** → same repository.

| Setting | Value |
|---|---|
| Name | `e360-web` |
| Root Directory | *(blank)* |
| Build Command | `npm ci && npm run build:web` |
| Publish Directory | `apps/web/dist` |

Environment variable: `VITE_DEFAULT_ORG_SLUG = care` — this is the same build argument `compose.yaml` passes to the web image.

Then open the site's **Redirects/Rewrites** tab and add two **Rewrite** rules, so the browser keeps talking to one origin and never meets CORS:

| Source | Destination | Action |
|---|---|---|
| `/api/v1/*` | `https://e360-api.onrender.com/api/v1/*` | Rewrite |
| `/r/*` | `https://e360-api.onrender.com/r/*` | Rewrite |

The second one is not optional: `/r/:code` is the short-link route behind every parent-evaluation link and QR code, and it must reach the API rather than the SPA. (Render only applies a rewrite when no file exists at that path, which is exactly the behaviour the SPA needs.)

### Step 6 — point the API at the front end

Back on `e360-api`, confirm `PUBLIC_APP_URL` and `CORS_ORIGIN` are both `https://e360-web.onrender.com` and redeploy if you changed them.

This is the step people skip. `PUBLIC_APP_URL` is the base for every link in outgoing e-mail, every password reset and every parent-evaluation QR code. Left at `localhost`, recipients get links only the server can open — and with `NODE_ENV=production` the API refuses to send them at all.

### Step 7 — get your public URL

`https://e360-web.onrender.com` — shown at the top of the static site's dashboard page, HTTPS already terminated. That is the link you share.

---

## 7. Environment variables

Set these on the **`e360-api`** service. The five marked required are the ones you must set: `DATABASE_URL` and `MFA_ENCRYPTION_KEY` have no default at all, while `JWT_ACCESS_SECRET` silently falls back to the literal `change-me` and `CORS_ORIGIN` to `http://localhost:5173` — defaults that exist but are worse than useless in the cloud.

| Variable | Value | Required |
|---|---|---|
| `DATABASE_URL` | The database's **Internal** Database URL | **Yes** |
| `JWT_ACCESS_SECRET` | 64 hex characters, freshly generated | **Yes** |
| `MFA_ENCRYPTION_KEY` | **Exactly** 64 hex characters | **Yes** |
| `PUBLIC_APP_URL` | `https://e360-web.onrender.com` | **Yes** |
| `CORS_ORIGIN` | `https://e360-web.onrender.com` | **Yes** |
| `DEFAULT_ORG_SLUG` | `care` | Recommended |
| `TZ` | `Asia/Karachi` | Recommended — the reminder scheduler uses container local time |
| `LOG_LEVEL` | `warn` | Optional |
| `LOG_FORMAT` | `json` | Optional |
| `BRAND_APP_NAME`, `BRAND_ORG_NAME`, … | As in `.env.docker.example` | Optional — all read at runtime |

Generate the two secrets:

```powershell
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })
```

Run it twice. `MFA_ENCRYPTION_KEY` also encrypts HR and SIS connector secrets — if you ever restore this database somewhere else, that key has to travel with it.

**Deliberately not set:**

- `REDIS_HOST` / `REDIS_PORT` — leaving them unset is what puts the API into inline delivery. **[measured]**: it logs `Redis not configured — using inline delivery.` and `/ready` returns HTTP 200 with `"status":"ok"` and `redis: skipped`. (Set `REDIS_HOST` to something unreachable and you get `redis: down` and an overall `degraded` instead — still 200, but there is no reason to do that.)
- `SIS_BASE_URL` / `SIS_API_KEY` — Mock SIS is not deployed.
- `LICENSE_PUBLIC_KEY` / `LICENSE_REQUIRE` — see §10.
- `PORT` — Render sets it, and `main.ts` already reads `process.env.PORT`. Do not override it.
- `NODE_ENV` — the runtime image sets `production`.

---

## 8. Database setup — the short version

You are not running migrations in the cloud. The chain is:

```
local docker compose  →  db-init applies 000_initial_schema.sql + 001_reconcile.sql,
                         seeds permissions/roles, creates the tenant + administrator,
                         optionally the demo content
        ↓  pg_dump -Fc --no-owner --no-acl
        ↓  pg_restore into Render Postgres
Render Postgres  ←  the API connects over the internal URL
```

**Applying a schema change later.** When `001_reconcile.sql` gains something new, run it straight against the cloud database — it is idempotent by construction:

```powershell
docker run --rm -v "${PWD}\database:/sql" postgres:16-alpine `
  psql "<EXTERNAL_DATABASE_URL>?sslmode=require" -v ON_ERROR_STOP=1 -f /sql/001_reconcile.sql
```

Then confirm `/ready` reports `schema: ok` again.

**Backups.** Free Render Postgres has no automatic backups. One command, and worth running before anything interesting:

```powershell
docker run --rm -v "${PWD}:/w" postgres:16-alpine `
  pg_dump "<EXTERNAL_DATABASE_URL>?sslmode=require" --no-owner --no-acl -Fc -f /w/backup.dump
```

---

## 9. Testing

Wake the API first — visit `https://e360-api.onrender.com/health` and give it a minute on the first hit.

| # | Check | Expected |
|---|---|---|
| 1 | `https://e360-api.onrender.com/health` | `{"status":"ok",…}` |
| 2 | `https://e360-api.onrender.com/ready` | HTTP 200, `"status":"ok"`, `database: up`, `schema: ok`, `redis: skipped` — skipped is right, Redis is not deployed |
| 3 | Open `https://e360-web.onrender.com` | Sign-in page, your branding, org slug pre-filled |
| 4 | Sign in as the administrator | Dashboard loads |
| 5 | Organization → Employees | 50 people (demo data) |
| 6 | Org Chart → People | Cards and reporting lines render |
| 7 | Appraisals → Cycles | Cycles listed with their deadlines |
| 8 | Reports → any report | Renders — slowly; 0.1 vCPU |
| 9 | Parent Evaluations → generate one link | The link must start `https://e360-web.onrender.com/r/…`. If it says `localhost`, `PUBLIC_APP_URL` is wrong |
| 10 | Open that `/r/…` link in a private window | The parent form opens — this proves the `/r/*` rewrite |
| 11 | Settings → Communication → send a test e-mail | Works only with an external SMTP provider configured (§10) |

A quick command-line pass:

```powershell
curl https://e360-api.onrender.com/health
curl https://e360-api.onrender.com/ready
curl -X POST https://e360-web.onrender.com/api/v1/auth/login `
  -H "Content-Type: application/json" `
  -d '{"organizationSlug":"care","email":"<your admin>","password":"<your password>"}'
```

Note the field name is **`organizationSlug`**, not `orgSlug` — **[measured]**, the shorter name fails validation.

---

## 10. What will not work on the free cloud

| Feature | Status | Detail |
|---|---|---|
| **SMTP / e-mail** | **Works** — with an external provider | Nothing to deploy; configure host, port 587, username and password under Communication → Providers. Your Ethereal test account works unchanged. Outbound 587 is not blocked |
| **WhatsApp via WAHA** | **Not available** | Needs ~1 GB RAM for its browser engine, a persistent volume for `.sessions`, and a QR scan from a real phone. None of that survives a free tier. Meta or Twilio credentials would work, since those are outbound HTTPS |
| **SMS** | **Works** — with a real provider | Outbound HTTPS to Twilio or similar |
| **Redis** | **Not deployed** | The delivery queue falls back to inline sending, and `/ready` reports `redis: skipped`. Render Key Value has a free 25 MB tier if you later want the queue back |
| **File uploads** | **Works** | **[measured]** — the app writes nothing to disk. Imports arrive as base64 JSON and are parsed in memory, so the absence of persistent disks costs nothing |
| **Background jobs** (delivery queue) | **Degraded, works** | Inline instead of queued |
| **Scheduled jobs** | **Unreliable — the real casualty** | Four jobs: reminders hourly, HR sync hourly, SIS sync hourly, report schedules daily 07:00. A sleeping instance runs none of them, and it sleeps after 15 idle minutes. Expect them to fire only when someone happens to be using the app. Trigger the equivalents by hand when demoing |
| **WebSockets** | **Not used** | Nothing to break |
| **Persistent data** | **Postgres only** | The one thing that must survive. Note the 30-day expiry |
| **External APIs** | **Work** | Outbound HTTPS is unrestricted |
| **Mock SIS** | **Not deployed** | Live "sync from SIS" is unavailable. The seeded roster (120 students, 200 guardians, 20 teachers) is in the database, so parent evaluations demo fine |
| **Licensing** | **Runs on the built-in development licence** | `build-config.ts` is committed as `BUILD_CHANNEL = 'internal'` and Render passes no build argument, so the image grants the development licence. Correct for a demo — and a reminder that a *customer* build must invert the Dockerfile default to `customer`, which is still outstanding |

---

## 11. Known free-tier limitations

- **Sleep.** The API spins down after 15 minutes without inbound traffic and takes about a minute to return. The static front end never sleeps, so the page loads instantly and the first API call is the one that waits. Tell your demo audience, or open the app a minute early. Keep-alive pingers are against Render's free-tier terms.
- **0.1 vCPU.** The tightest limit. Reports and bulk parent-link generation will be several times slower than on your laptop.
- **512 MB RAM.** **[measured]** 135 MB in normal use, so there is real headroom — but a very large import in one request could still spike it.
- **The database expires 30 days after creation,** with a 14-day grace period before deletion. Free Postgres is one per workspace.
  *If you need it to outlive that:* create a free **Neon** project instead (0.5 GB storage, 100 compute-hours/month, no expiry — your database is **[measured]** 13 MB) and put its connection string in `DATABASE_URL`. Neon suspends the compute after 5 minutes idle and resumes on the next connection, which pairs naturally with a service that sleeps anyway. Everything else in this runbook is unchanged.
- **5 GB of bandwidth and 500 build minutes per month.** A full deploy of both services costs roughly ten minutes of build time, so budget around fifty deploys a month.
- **No shell and no one-off jobs** on free instances — hence the seed-locally-and-restore approach.
- **No automatic database backups** on the free plan. §8 has the one-line dump.
- **Not production.** No backups, no HA, credentials for messaging providers stored unencrypted in the database (per the correction in the current manuals), and demo passwords in the seed data.

---

## 12. Appendix

### A. Option B — keeping the web Docker image

If you want both tiers as containers rather than a static site, the web image needs to know the API's public URL at build time. This patch adds a build argument that **defaults to the current Compose behaviour**, so local `docker compose up` is completely unaffected.

Append to the `runtime` stage of `apps/web/Dockerfile`, after the `COPY … nginx.conf` line:

```dockerfile
# Where nginx sends /api/v1 and the short-link paths. Defaults to the Compose
# service name, so a local `docker compose up -d` is unchanged. Set it to the
# API's public URL on a host that has no private networking between services.
ARG API_ORIGIN=http://api:3000
RUN sed -i "s|http://api:3000|${API_ORIGIN}|g" /etc/nginx/conf.d/default.conf && \
    case "$API_ORIGIN" in https://*) \
      host=$(echo "$API_ORIGIN" | sed -E 's|^https://([^/]+).*|\1|'); \
      sed -i "s|proxy_set_header Host \$host;|proxy_set_header Host ${host};\n        proxy_ssl_server_name on;|g" \
        /etc/nginx/conf.d/default.conf ;; \
    esac
```

Then deploy the front end as a **Web Service** instead of a static site: Dockerfile Path `./apps/web/Dockerfile`, and two environment variables — `API_ORIGIN = https://e360-api.onrender.com` (Render turns environment variables into build arguments) and `PORT = 80`, because the image listens on a fixed port 80 and Render's port scan needs to be told.

Rewriting the `Host` header is not cosmetic: Render routes by it, and without `proxy_ssl_server_name on` the TLS handshake to the upstream fails.

I tested this: the substitution produces a config that passes `nginx -t` for both the default and the HTTPS form, and with a real nginx serving `apps/web/dist` against a live API, the SPA root, a deep client-side route, a proxied `POST /api/v1/auth/login` and the `no-store` header on `index.html` all behaved exactly as they do under Compose.

The trade-off: this second service also sleeps, so a cold visit costs two wake-ups instead of one.

### B. Docker Hub instead of GitHub builds

If you would rather not push source, or want to spend no build minutes:

```powershell
docker build -f apps/api/Dockerfile -t <dockerhub-user>/e360-api:demo .
docker push <dockerhub-user>/e360-api:demo
```

Then on Render choose **Deploy an existing image** and give it `docker.io/<dockerhub-user>/e360-api:demo`. Public repositories need no credentials. Redeploying afterwards means pushing a new tag and updating the image on the service.

### C. If you would rather not use a PaaS at all

**Oracle Cloud Always Free** gives you a VM that runs `docker compose -f compose.yaml -f compose.prod.yaml up -d` **completely unchanged** — Redis, Mock SIS and even WAHA included, with no sleeping and no 30-day database expiry. Your existing *Cloud Server Deployment Runbook (2026-09-07)* applies to it line for line, including the Caddy HTTPS section.

The reasons it is not the recommendation: it needs a credit card, Arm capacity in a given region is frequently unavailable at sign-up, the WAHA image may not have an Arm build, and you become the system administrator — patching, firewalling and backing up. That is the right trade for a pilot with a real client, and the wrong one for "I want a demo URL this afternoon".

Also worth knowing before you count on it: **Oracle halved the Always Free Arm allowance on 15 June 2026** — from 4 OCPU / 24 GB to 2 OCPU / 12 GB — with no blog post, no e-mail and no clarification about whether existing tenancies are affected. Users found out when instances stopped. 2 OCPU and 12 GB still runs your whole stack with room to spare, but it is a reminder that "always free" is a policy, not a contract.

---

## 13. What is verified, and what is not

Stated plainly so you know where to be careful.

**Verified by running it** — on your actual code, in this session:

- The `ops/docker-init.sh` chain against a real PostgreSQL 16: database creation, schema (`000` + `001`), permission catalogue, the five system roles, tenant and administrator, and the full demo dataset. Its final step — the Mock SIS roster — could not run, because `apps/mock-sis` is missing from my copy (see the pre-flight in §5). Nothing before that step depends on it.
- Database size, dump size, API memory, API boot time, and the `/health` and `/ready` responses with no Redis.
- `pg_dump -Fc --no-owner --no-acl` → `pg_restore` into an empty database, with the row counts and schema version checked afterwards.
- The Option B nginx patch, using a real nginx serving a prebuilt `apps/web/dist` and proxying to a live API: the substitution, `nginx -t` on both the default and HTTPS forms, the SPA root, a deep client-side route, a proxied `POST /api/v1/auth/login`, and the `no-store` header on `index.html`. The Vite build itself I did not run through `npm run build:web` — see the pre-flight.
- That the app writes nothing to disk and opens no WebSocket, by searching the API source.

**Taken from Render's own documentation, not executed** — I have no Render account, so the platform side of this runbook is documented behaviour rather than a rehearsal:

- That a Static Site rewrite forwards a `POST` body and the `Authorization` header to an external destination. Render documents rewrites to full external URLs; I could not confirm header forwarding. **If sign-in fails through the static site but works against the API URL directly, this is the thing to suspect** — fall back to Option B, which proxies through nginx and is verified.
- Exact free-tier sleep and wake timings.
- That Render's port scan finds nginx on port 80 when `PORT=80` is set (Option B only).
- The 30-day free-database expiry and the free instance specifications, which come from Render's pricing and free-tier pages.

---

## 14. Summary

| | |
|---|---|
| **Recommended platform** | **Render** — Web Service (Docker) for the API, Static Site for the front end, free managed Postgres |
| **Why** | No credit card; builds your existing Dockerfiles unmodified; database in the same dashboard; automatic public HTTPS; and your app measurably fits (135 MB against 512 MB, 13 MB against 1 GB) |
| **Prerequisites** | Docker Desktop, Git, a GitHub account, a Render account. All four workspace `package.json` files present |
| **Deployment steps** | Choose service names → push to GitHub → create Postgres → seed locally and `pg_restore` up → deploy the API as a Docker web service → deploy the front end as a static site with two rewrite rules → set `PUBLIC_APP_URL` |
| **Environment variables** | `DATABASE_URL`, `JWT_ACCESS_SECRET`, `MFA_ENCRYPTION_KEY`, `PUBLIC_APP_URL`, `CORS_ORIGIN` are required; deliberately leave `REDIS_HOST`, `SIS_BASE_URL` and `PORT` unset |
| **Database setup** | `db-init` runs on your laptop, never in the cloud; `pg_dump -Fc --no-owner --no-acl` then `pg_restore`. Schema must read `2026.08.21-01` |
| **Testing** | `/health`, `/ready` (`redis: skipped` is correct), sign in, 50 employees, a report, and a parent link that starts `https://` and not `localhost` |
| **Known limitations** | 15-minute sleep with a ~1-minute wake; 0.1 vCPU; database expires after 30 days; scheduled jobs will not fire reliably; no WAHA, no Mock SIS, no Redis; 5 GB bandwidth and 500 build minutes a month |

---

### Sources

- [Deploy for Free – Render Docs](https://render.com/docs/free)
- [Pricing | Render](https://render.com/pricing)
- [Private Network – Render Docs](https://render.com/docs/private-network)
- [Docker on Render – Render Docs](https://render.com/docs/docker)
- [Web Services – Render Docs](https://render.com/docs/web-services)
- [Static Site Redirects and Rewrites – Render Docs](https://render.com/docs/redirects-rewrites)
- [Create and Connect to Render Postgres – Render Docs](https://render.com/docs/postgresql-creating-connecting)
- [Supported Extensions for Render Postgres – Render Docs](https://render.com/docs/postgresql-extensions)
- [Platform Features by Plan – Render Docs](https://render.com/docs/new-workspace-plans)
- [Pricing FAQ | Koyeb](https://www.koyeb.com/docs/faqs/pricing)
- [Pricing — Northflank](https://northflank.com/pricing)
- [Pricing on Northflank – Northflank Docs](https://northflank.com/docs/v1/application/billing/pricing-on-northflank)
- [Northflank free tier – FreeTier.co](https://freetier.co/directory/products/northflank)
- [Neon Free plan limits and quotas](https://neon.com/faqs/free-plan-limits-and-quotas)
- [7 Fly.io Alternatives in 2026: Real Pricing After the Free Tier Died](https://expresstech.io/7-fly-io-alternatives-in-2026-real-pricing-after-the-free-tier-died/)
- [Railway Free Tier: Did They Remove It? Pricing History 2026](https://www.saaspricepulse.com/blog/railway-pricing-history)
