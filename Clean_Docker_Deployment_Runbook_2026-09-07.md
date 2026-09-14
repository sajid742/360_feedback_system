# Deploying a Clean 360 App on a Client Machine (Docker)

**Date:** 2026-09-07
**Scope:** first-time deployment of an empty (non-demo) tenant on a customer server, including prerequisites and licensing.
**Status:** procedure verified against this repository — `compose.yaml`, `.env.docker.example`, `ops/make-release.ps1`, `ops/deploy-release.ps1`, `tools/license.cjs`, `apps/api/Dockerfile`, `DEPLOYMENT.md`, `LICENSING.md`. Sizing figures come from the 2026-09-05 performance tests.

This document elaborates the existing `DEPLOYMENT.md` Part 1 for the specific case of a **clean customer install** — no demo data — and pulls the licensing steps inline, because they span two machines and that is where deployments go wrong.

---

## 0. The one thing to understand first

There are **two machines**, and the split between them is the whole licensing design:

| | Vendor machine (yours) | Client machine |
|---|---|---|
| Holds the source tree | yes | **no** |
| Holds `license-private.pem` | yes | **never** |
| Runs `ops/make-release.ps1` | yes | no (the script is stripped from the package) |
| Runs `tools/license.cjs` | yes | no (`license.cjs` is on the forbidden list) |
| Builds images | yes | **no** — loads `.tar` files |
| Runs the stack | no | yes |

If you hand the client a buildable source tree instead of a release package, the compiled-in public key can simply be replaced with one of their own and most of the licensing protection is gone. The package format exists to prevent that; `make-release.ps1` refuses to produce an archive containing `*.ts`, `*.map`, `*.pem`, `license.cjs`, `write-build-config.cjs`, `Dockerfile*`, `tsconfig*.json`, `.env` or `*-license.txt`.

---

## Part A — Prerequisites on the client machine

### A.1 Hardware

Sized from the 2026-09-05 load tests against production-shaped data (800 employees, 8,120 students, 21,691 reviewer assignments):

| | Minimum | Recommended |
|---|---|---|
| vCPU | 4 | 8 |
| RAM | 8 GB **available to Docker** | 16 GB |
| Disk | 50 GB SSD | 100 GB SSD |

**One properly sized server is sufficient. Do not separate the database onto its own tier.** PostgreSQL never exceeded 1% CPU or 22 of 200 connections in any test, including a 600-user spike, and the database is 25 MB on disk at full production volume. The API is the constraint and it is CPU-bound on JSON work — spend the budget on cores for the application, not on a database server.

The 50 GB is not for data. It is images (~4 GB), retained release image sets, database dumps and log volume.

### A.2 Software

| Requirement | Notes |
|---|---|
| **Docker Desktop** (Windows/macOS) or **Docker Engine + Compose v2** (Linux) | Must provide `docker compose` as a subcommand. Standalone `docker-compose` v1 is **not supported** |
| **Windows PowerShell 5.1+** | Only if you use the `.ps1` operational scripts. No modules required |
| Nothing else | No Node, no Java, no `psql` on the host. Everything runs in containers |

**No internet access is required at run time.** See `LICENSING.md` §7 for air-gapped operation.

### A.3 Ports

Free on the host: **8080** (web), **3000** (API), **3100** (mock SIS), **3001** (WAHA), **5432** (PostgreSQL). All are remappable in `.env` (`WEB_PORT`, `API_PORT`, `MOCK_SIS_PORT`, `WAHA_PORT`, `POSTGRES_PORT`).

Consider whether **5432 should be published at all** on a customer server. Nothing outside the Compose network needs it; removing the mapping is the single easiest hardening step.

### A.4 Network

The client's users must be able to reach the host on the web port. Decide the **exact address they will type** before you start — you need it for `PUBLIC_APP_URL` in step C.3, and getting it wrong silently breaks every outgoing link.

---

## Part B — Build the release (vendor machine, once per version)

### B.1 One time ever: create the signing keys

```bash
node tools/license.cjs keygen
```

Writes `license-public.pem` and `license-private.pem` to `../e360-license-keys` — deliberately **outside** the repository.

> **`license-private.pem` is the only thing that can mint a licence.** It must never be committed, never be placed on any server, never be included in an image, a repository or a customer package, and never be run inside a customer's container. Back it up somewhere offline. Losing it means re-issuing every licence; leaking it means anyone can mint their own.
>
> `--force` regenerates the pair and **invalidates every licence already issued**. There is a guard on it for a reason.

`license-public.pem` is the half that ships — compiled into the image, never pasted into a file the customer can edit.

### B.2 Build and package

```powershell
.\ops\make-release.ps1 -Version 2026-09-07-v1 `
  -PublicKeyFile "..\e360-license-keys\license-public.pem"
```

This:

1. Builds `e360-api` and `e360-web` with `--build-arg BUILD_CHANNEL=customer` and the trusted **public** key stamped in by `apps/api/scripts/write-build-config.cjs`. `BUILD_CHANNEL=customer` is also what compiles the built-in development licence **out**, so a licence becomes mandatory.
2. Exports the images with `docker save`.
3. Copies only the allow-listed operational files (`compose.yaml`, `compose.prod.yaml`, `.env.docker.example`, `start-docker.ps1`, `deploy.ps1`, the docs, `database/*.sql`, `ops/*.ps1|*.sh|*.md`), then removes `ops\make-release.ps1` itself.
4. **Refuses to produce the archive** if anything forbidden slipped in.

The script takes the **public** key only and refuses anything that looks private.

### B.3 ⚠ Known defect to check before you ship

`apps/api/src/license/build-config.ts` line 33 is committed as:

```ts
export const BUILD_CHANNEL = 'internal' as BuildChannel;
```

and `apps/api/Dockerfile` line 35 is `ARG BUILD_CHANNEL=` (empty), with the stamper skipped when the arg is empty. So a plain `docker compose build` — the path a customer would take if they ever got a source tree, and the path *you* take when testing locally — produces an image that **grants the built-in development licence**.

`make-release.ps1` always passes `BUILD_CHANNEL=customer`, so a proper release is correct. But the safe default is inverted. The proposed fix (change the Dockerfile default to `ARG BUILD_CHANNEL=customer`, so an unspecified build fails closed rather than open) **has not been applied**. Until it is:

- Never ship an image built by anything other than `make-release.ps1`.
- After building, confirm the channel took effect — see step D.4.

### B.4 Issue the customer's licence

```bash
node tools/license.cjs create \
  --org "CARE Pvt. Ltd." --slug care \
  --edition professional --employees 800 \
  --expires 2027-09-06 \
  --license-id "CARE-360-2026-0001" \
  --out care-license.txt
```

`--slug` **must equal** the `ORG_SLUG` you will put in the client's `.env`. It is what binds the licence to that installation and stops it being moved to another customer.

Verify before sending:

```bash
node tools/license.cjs verify --file care-license.txt
```

Editions are starting points, not fixed tiers — every value is overridable. `professional` gives 365 days / 500 employees and includes parent feedback, SIS and HR modules; the `--employees 800` above overrides the seat count to match the measured population.

Send the client **two things and only two**: the release `.zip` and `care-license.txt`. Never the `.pem` files.

---

## Part C — Install on the client machine

### C.1 Unzip and load the images

```powershell
cd "C:\Enterprise360\Enterprise360_App_2026-09-07-v1"
.\load-images.ps1
```

Loading four saved images takes a few minutes. **Do not build on the client machine** — there is no source to build from, and if there were, see B.3.

### C.2 Generate the secrets

```powershell
.\ops\init-env.ps1
```

Copies `.env.docker.example` to `.env` and generates the values Compose refuses to start without:

| Generated | Why it cannot have a default |
|---|---|
| `JWT_ACCESS_SECRET` | Signs sessions. A published default would let anyone mint a token |
| `MFA_ENCRYPTION_KEY` | 64 hex characters. **Also encrypts HR and SIS provider credentials** |
| `WAHA_API_KEY` | The `X-Api-Key` the application sends to WAHA |
| `WAHA_DASHBOARD_PASSWORD` | Left unset, WAHA randomises it on every start and prints it only to its own log |

Re-running never overwrites a secret that already exists, so it is safe on a working install.

> **Back up `MFA_ENCRYPTION_KEY` together with the database, not separately from it.** It encrypts the HR and SIS provider secrets stored in PostgreSQL. A database restored without the matching key is a database whose provider credentials are unrecoverable and whose MFA users must all re-enrol. Treat the pair as one artefact.

### C.3 Configure `.env` for a clean tenant

Edit `.env`. Everything not listed here has a working default.

```env
# ---- first-run tenant (used ONCE by db-init) ----
ORG_NAME=CARE Pvt. Ltd.
ORG_SLUG=care                        # must match the licence --slug
ADMIN_EMAIL=admin@carepvtltd.com
ADMIN_PASSWORD=<a real password, changed at first sign-in>
DEFAULT_ORG_SLUG=care                # which tenant the sign-in page belongs to

# ---- THE clean-install setting ----
SEED_DEMO_DATA=false                 # administrator, permissions and the five roles. Nothing else.

# ---- the setting people get wrong ----
PUBLIC_APP_URL=https://360.client.example

# ---- operational ----
TZ=Asia/Karachi                      # the reminder scheduler uses container local time
LOG_FORMAT=json
LOG_LEVEL=log
```

**`SEED_DEMO_DATA=false` is what makes this a clean install.** `true` gives the full demo tenant — 50 employees, 6 cycles, scored feedback, a SIS roster — which is right for a sales demo and wrong for a customer.

**`PUBLIC_APP_URL` must be the address people actually type.** Every outgoing link is built from it: parent evaluation invitations, password resets, QR codes. Left at `localhost` on a shared server, each recipient gets a link to *their own* computer — the message is delivered, the token is spent, the link is dead. It must never be a Docker service name (`http://web:80`); those resolve only inside the container network. The API warns at startup and, with `NODE_ENV=production` (which the runtime image sets), **refuses to send** such links rather than sending a broken one.

Also review the white-label defaults (`BRAND_APP_NAME`, `BRAND_ORG_NAME`, colours, logo URL). These are defaults only — whatever an administrator sets in Brand Studio wins — but they set what the client sees on day one. Deploying for a new client is a change to this file, not to the code or the image.

### C.4 Start

```powershell
.\start-docker.ps1 -NoBuild
```

`-NoBuild` is mandatory here: without it, Compose builds, and on a package with no source that either fails or picks up whatever images already exist from another unzipped release.

### C.5 What database initialisation does

`db-init` is a one-shot container that runs on every start and exits. Every step is idempotent, so there is no separate first-run command to remember:

1. Creates the `mock_sis` database alongside the main one.
2. Applies `database/000_initial_schema.sql`, then `database/001_reconcile.sql`, and stamps `schema_migrations`.
3. Seeds the permission catalogue and the five system roles (Super Admin, HR/Admin, Manager, Employee, Viewer).
4. Bootstraps the tenant from `ORG_NAME` / `ORG_SLUG` / `ADMIN_EMAIL` / `ADMIN_PASSWORD`.
5. Seeds demo content **only when `SEED_DEMO_DATA=true`** — skipped here.
6. Pushes and seeds the Mock SIS schema.

**There is no migration tool to run by hand.** The SQL is hand-maintained and reapplied on every start; `001_reconcile.sql` is additive and idempotent — 643 `IF NOT EXISTS` statements, no `DROP`, `TRUNCATE`, `DELETE` or `SET NOT NULL`.

If you ever need to bootstrap a second tenant later, note the flags are `--slug` / `--email` / `--password` (**not** `--admin-email`), and call the workspace script in one hop:

```bash
npm run -w apps/api db:bootstrap-tenant -- --slug abc --email admin@abc.edu --password '…' --no-starter-content
```

Two npm argument parsers in series eat `--flag value` pairs; a root alias that hops through `npm run -w` will silently drop them.

---

## Part D — Install the licence

### D.1 Nothing to configure

A release build already carries the trusted public key, compiled in. There is nothing to paste into `.env` and nothing to restart. `LICENSE_PUBLIC_KEY` in `.env.docker.example` is **inert on a customer build** and is kept only so an internal build can point at a throwaway key pair.

If the Install button reports that there is no verification key, the **build** is faulty, not the configuration — no environment change can fix it.

### D.2 Install

Sign in as the administrator, open **Licence** in the menu, paste the licence (or **Choose file**), press **Install licence**.

The licence is written to PostgreSQL, so it survives `docker compose down` and `up`, and is covered by the normal database backup. Only `docker compose down -v` destroys it, along with everything else. `db-init` never touches the licence — it seeds tenants and demo content only — so a later demo re-seed cannot overwrite it.

### D.3 If it is refused

| Message | Cause |
|---|---|
| *no licence verification key* | Build produced without a trusted key. Rebuild the release with `ops/make-release.ps1` |
| *issued for the organisation "x", but this installation is "y"* | The licence `--slug` must equal `ORG_SLUG` in `.env` |
| *could not be verified* | Truncated paste, or signed with a different key pair |

### D.4 Confirm the build channel took effect

Because of the defect in B.3, verify on the client machine that this is genuinely a customer build: with no licence installed, the application must **refuse to operate**, not fall through to a development licence. If it runs happily unlicensed, you have shipped an internal-channel image and must rebuild.

Belt and braces, set explicitly in `.env`:

```env
LICENSE_REQUIRE=true
```

and restart the API container. On a correct customer build this is redundant; on a mis-built one it is the difference between enforced and not.

### D.5 What licensing does and does not do — state this plainly to the client

**True:**

- The licence is an **Ed25519-signed claim**. Editing the readable payload invalidates the signature.
- The **private signing key never leaves the vendor's machine** — not in the repository, not in any Docker image, not in any customer package.
- A release build carries only the **public** key, compiled into `dist`, so it can verify and never sign.
- A licence is **bound to the organisation slug**, so it cannot be moved to another customer's installation.
- Installation and replacement are recorded in the audit trail.

**Must not be claimed:**

> A licence cannot stop a technically capable administrator with root or Administrator access on the server. They control the operating system, the container runtime and the files on disk, and can modify the application. The design raises the effort from a configuration change to a deliberate modification of a delivered binary artefact — which makes a bypass an evidenced act rather than a plausible accident. It does not make the software uncrackable, and no on-premise licensing scheme can.

The commercial protections carry the rest: support and upgrades conditional on a valid licence, the audit trail, and the contract.

---

## Part E — Verify the deployment

```powershell
docker compose -f compose.yaml ps
```

All six long-running containers `running`; `e360-db-init` `exited (0)`.

```powershell
curl http://localhost:3000/health          # liveness  — 200 whenever the process is up
curl http://localhost:3000/ready           # readiness — database, redis, schema version
curl http://localhost:8080/                # web
curl http://localhost:3100/api/v1/health   # Mock SIS  — note it IS under /api/v1
```

`/health` and `/ready` are mounted at the **root**, outside the `/api/v1` prefix that the other 312 routes use.

A healthy `/ready` reports `"status":"ok"` with `database: up`, and a schema version matching the build's expected `2026.08.21-01`. `"degraded"` means either Redis is down (delivery falls back to inline) **or** the applied schema version trails the build. Both are reported; neither stops the application, but the second one means `db-init` did not do what you think it did.

Then, from a machine that is **not** the server, sign in at `PUBLIC_APP_URL` with organisation `care` and the admin e-mail. Doing this from the server itself is how a bad `PUBLIC_APP_URL` survives to production.

### E.1 Before the client sends anything to real people

Check that outbound messaging is configured deliberately rather than by accident:

```sql
select module, key, value->>'enabled' from configurations where module='communication';
```

**No rows means nothing can dial out** — which is the correct state for a fresh install, and the state to keep until the client has entered their own provider credentials under Communication → Providers. Those credentials are encrypted with `MFA_ENCRYPTION_KEY` (see C.2).

Send one test evaluation link to a number you control and confirm the URL in the received message is the `PUBLIC_APP_URL` address, reachable from a phone on the client's network.

---

## Part F — Hand over: what the client must operate

### F.1 Backups — four separate things

Per `ops/BACKUP_RESTORE.md`. They are genuinely separate and a backup of one is not a backup of another:

1. **The database** — `pg_dump -Fc` run through the container, so the host needs no `psql`.
2. **`.env`** — including `MFA_ENCRYPTION_KEY`. Store it with the dumps, not separately.
3. **Volumes** — `pgdata`, `redisdata`, and any uploaded brand assets.
4. **Images** — the `.tar` files from the release package, so a restore does not depend on rebuilding.

A database dump without the matching `MFA_ENCRYPTION_KEY` is a partial backup that will look fine until the day someone restores it.

### F.2 Upgrades and rollback

- Upgrade: `.\ops\deploy-release.ps1` — treats the four images as one versioned release unit, tags and records the currently running set, dumps the database, and rolls back automatically as a complete set if the new release fails to become healthy. Never a mixture of old web and new API.
- Rollback: `.\ops\rollback.ps1`.
- `start-docker.ps1` remains the first-run entry point only; it is not the upgrade path.

Note: **`ops/UPGRADE.md` currently contradicts `DEPLOYMENT.md` on rollback.** `DEPLOYMENT.md` Part 3 is the accurate one. That discrepancy should be resolved before this package goes to a customer.

Do not delete old images to reclaim space without first checking they are not referenced by a retained release manifest.

### F.3 Optional: resource limits

`compose.resources.yaml` is an opt-in overlay carrying limits derived from the performance tests:

```powershell
docker compose -f compose.yaml -f compose.resources.yaml up -d
```

It caps Redis at 256 MB, gives PostgreSQL 2 CPU / 4 GB with `pg_stat_statements` permanently enabled, and gives the API 4 CPU / 4 GB with a V8 heap ceiling below the container limit. **Its numbers were measured running the API from source on a box shared with the load generator** — container CPU limits and the nginx hop are not represented. Treat it as a starting point to verify on the client's hardware, not as a validated configuration.

If you scale the API (`--scale api=2`), be aware that `@nestjs/schedule` cron jobs — SIS auto-sync, reminders, report schedules — **fire in every replica**. Either keep exactly one replica or gate the schedulers behind a flag set on one instance only.

---

## Summary checklist

**Vendor machine**

- [ ] `license-private.pem` exists, backed up offline, and is on no server
- [ ] `make-release.ps1` run with `-PublicKeyFile` pointing at the public half
- [ ] Package built — archive produced, meaning the forbidden-content check passed
- [ ] Licence created with `--slug` equal to the client's `ORG_SLUG`, and verified
- [ ] Only the `.zip` and the licence `.txt` are being sent

**Client machine**

- [ ] Docker Compose v2; 4+ vCPU, 8+ GB to Docker, 50+ GB SSD
- [ ] Ports free; 5432 publication reconsidered
- [ ] `load-images.ps1` run — images loaded, **not** built
- [ ] `init-env.ps1` run; `MFA_ENCRYPTION_KEY` recorded with the backup procedure
- [ ] `SEED_DEMO_DATA=false`
- [ ] `ORG_SLUG` matches the licence
- [ ] `PUBLIC_APP_URL` is the address users type, verified from another machine
- [ ] `TZ` set to the client's timezone
- [ ] `start-docker.ps1 -NoBuild`
- [ ] `db-init` exited 0; `/ready` reports schema `2026.08.21-01`
- [ ] Licence installed; unlicensed behaviour confirmed to be refusal (D.4)
- [ ] Communication providers deliberately empty until the client configures them
- [ ] Backup procedure documented and one restore rehearsed
