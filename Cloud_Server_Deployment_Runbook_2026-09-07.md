# Deploying Enterprise 360 on a Single Cloud Server

**Date:** 2026-09-07
**Scope:** one Linux cloud server, Docker Compose, real client, production. No Kubernetes, no load balancer, no HA, no microservices.
**Source of truth:** this repository as it stands today — `compose.yaml`, `compose.prod.yaml`, `apps/web/nginx.conf`, `apps/web/Dockerfile`, `apps/api/Dockerfile`, `apps/api/src/main.ts`, `ops/docker-init.sh`, `ops/init-env.sh`, `ops/make-release.ps1`, `ops/DOCKER.md` §26, `ops/BACKUP_RESTORE.md`, `.env.docker.example`. Sizing comes from the 2026-09-05 performance tests. **No application or deployment file has been changed.**

Every command below was checked against the files. Where something in the repo would make a command fail as written, that is called out rather than papered over.

---

## The good news first

`compose.prod.yaml` already exists and already does most of what a production deployment needs:

- `postgres` and `api` stop publishing host ports — the database is not reachable from outside the Docker network at all, and the browser reaches the API through the web container's nginx at `/api/v1`
- `mock-sis` and `waha` are scaled to zero — the Mock SIS admin page is deliberately unauthenticated, so it must never be on a public server
- `SEED_DEMO_DATA=false`
- a 1 GB memory ceiling on the API
- **and one trap:** it changes the `web` port default from 8080 to **80** (see §3.4)

So the deployment command is `docker compose -f compose.yaml -f compose.prod.yaml up -d`, never plain `docker compose up -d`. Everything below assumes that.

---

# 1. Recommended Server

## 1.1 Sizing

Measured on a 2 vCPU / 8 GB box running the API, PostgreSQL, Redis **and** the load generator together, against production-shaped data — 800 employees, 8,120 students, 21,691 reviewer assignments:

| Component | Peak observed | What it means |
|---|---|---|
| **API** | 193% CPU (saturating both cores) | **This is the constraint.** CPU-bound on JSON work, not I/O |
| **PostgreSQL** | 1% CPU, 22 of 200 connections | Not the constraint, even in a 600-user spike |
| **Redis** | 1.4 MB, flat | Delivery queue only |
| **Database on disk** | 25 MB | At full production data volume |
| **API memory** | ~1 GB RSS steady | 30-min endurance run: 16,405 transactions, 0 errors, +16 MB RSS. No leak |

| | Minimum | **Recommended** |
|---|---|---|
| vCPU | 4 | **8** |
| RAM | 8 GB | **16 GB** |
| Disk | 80 GB SSD | **160 GB SSD** |

**Buy cores, not database.** The recommended tier is roughly four times the CPU headroom the application needed with the load generator removed. 4 vCPU genuinely works for the stated population; 8 is what I would put in front of a paying client so a cycle-opening day, a bulk generation and a SIS import can overlap unnoticed.

**Add 2 GB and a core if you run WAHA on the same box** — the WEBJS engine drives a real Chromium session and is by far the heaviest optional component. The production overlay disables it by default.

**Disk is not about data.** 25 MB of database against 80 GB is not a typo. The space goes to Docker images (~4 GB), retained release image sets, daily dumps and container logs.

**Do not split the database onto its own server or a managed service.** It would cost more, add a network hop to every query, and solve a problem the measurements say you do not have. Revisit only if PostgreSQL CPU ever sustains above ~40%.

## 1.2 Provider and instance

Any provider works — this is an ordinary Linux VM with Docker.

| Provider | Instance | Notes |
|---|---|---|
| **DigitalOcean** — default recommendation | Premium Droplet, 8 vCPU / 16 GB | Simplest console, snapshots and block storage built in. **Bangalore (BLR1) or Singapore (SGP1)** for South-Asian users |
| **Hetzner Cloud** | CCX33 (dedicated vCPU) | Best price for the performance by a wide margin. **EU/US regions only** — expect ~120–150 ms extra latency from Pakistan. Fine for a feedback app, noticeable |
| **AWS** | `t3.xlarge` / `m7i.xlarge` + gp3 | Only if the client mandates AWS. `me-central-1` (UAE) or `ap-south-1` (Mumbai) are closest |
| **Azure** | B4ms or D4as_v5 | Only if the client is a Microsoft shop |

**Choose the region by where the users are, not by price** — every page load crosses that link. For CARE Pvt. Ltd. in Pakistan: Mumbai, Dubai or Singapore. Check current pricing directly; it moves.

**OS: Ubuntu 24.04 LTS.** Every command below is written for it.

Take the provider's snapshot add-on. It is cheap and it is a second, independent recovery path.

---

# 2. Prerequisites

## 2.1 Before you touch the server

- **A domain** you control (e.g. `360.client.com`) with the ability to create an A record.
- **The release package** from `ops\make-release.ps1`, or the source tree if you will build on the server — read §3.2 first, there is a licensing trap.
- **The licence file** for this client, `--slug` matching the `ORG_SLUG` you will configure.
- **A decision on who holds `MFA_ENCRYPTION_KEY`** and where the second copy lives.

## 2.2 Install Docker

```bash
sudo apt update && sudo apt install -y ca-certificates curl gnupg unzip
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

docker --version && docker compose version
sudo usermod -aG docker $USER      # log out and back in
```

> **Do not `apt install docker.io` or `docker-compose`.** Ubuntu's `docker-compose` is v1, which this stack does not support, and the distro Docker is usually too old for the Compose features `compose.prod.yaml` uses.

**Prove `!reset` works before you trust it.** `compose.prod.yaml` uses the `!reset` YAML tag to remove published ports. An older Compose ignores it and **publishes PostgreSQL to the internet**. Once you have the app unpacked and `.env` created (§3), run:

```bash
docker compose -f compose.yaml -f compose.prod.yaml config | grep -c 'published:'
```

**Correct answer: `1`** — the web container, and nothing else. Anything higher means `!reset` was ignored; upgrade Compose before going further. (`!override`, the sibling tag, is documented as requiring Compose 2.24.4+; `!reset` is from the same era. Rather than trust a version string, use the check.)

## 2.3 Ports

| Port | Open to | Why |
|---|---|---|
| **22** | your admin IP only | SSH |
| **80** | world | HTTP → HTTPS redirect, and Let's Encrypt HTTP-01 validation |
| **443** | world | HTTPS |

Nothing else — not 5432, not 6379, not 3000, not 3001, not 8080. Under the production overlay only `web` publishes a port, and Caddy is the only thing that should reach it.

---

# 3. Deployment Steps

## 3.1 User and folder

```bash
sudo adduser --disabled-password --gecos "" e360
sudo usermod -aG docker e360
sudo mkdir -p /opt/e360 && sudo chown e360:e360 /opt/e360
sudo su - e360
```

## 3.2 Get the application onto the server

**Two options, not equivalent.**

### Option A — release package (recommended for a real client)

On Windows: `ops\make-release.ps1 -Version 2026-09-07-v1`.

> **Pre-flight on your build machine.** `make-release.ps1` builds from an explicit allow-list and dies on the first missing file (`Die "allow-listed file is missing: $f"`). It expects `compose.yaml`, `compose.prod.yaml`, `.env.docker.example`, `start-docker.ps1`, `deploy.ps1`, `README.md`, `DEPLOYMENT.md`, `WINDOWS_DEPLOY.md`, `LICENSING.md`, `COMMUNICATION_SETUP.md`, `WHITE_LABEL.md`. Confirm all ten exist at the repo root before you run it, or fix the allow-list — do not discover this at packaging time.

Then, on the server:

```bash
cd /opt/e360
# The zip has NO wrapping folder — Compress-Archive was given the stage folder's
# CONTENTS. Windows Explorer invents a folder on extract; Linux unzip does not, so
# without -d everything splats into /opt/e360.
unzip -d app Enterprise360_App_2026-09-07-v1.zip
cd app

# load-images.ps1 is PowerShell. This is the Linux equivalent:
for t in images/*.tar; do docker load -i "$t"; done
docker image ls | grep e360
```

**The package contains three images, not four:** `e360-api`, `e360-api-tools`, `e360-web`. `e360-mock-sis` is never saved — the production overlay runs it at `replicas: 0` anyway. Remember that for the rollback loops in §8.

The images are built with `BUILD_CHANNEL=customer`, which stamps in the trusted public key **and compiles the development licence out**. The client never holds the source. This is the configuration the licensing design assumes.

### Option B — build on the server from source

```bash
git clone <your-repo> /opt/e360/app && cd /opt/e360/app
```

> ### ⚠ If you build on the server, read this before `docker compose build`
>
> `apps/api/src/license/build-config.ts:33` is committed as `BUILD_CHANNEL = 'internal'`, and `apps/api/Dockerfile:35` is `ARG BUILD_CHANNEL=` — empty, which skips the stamper entirely. **A plain `docker compose build` produces an image that grants the built-in development licence and never asks for a real one.** The default fails open.
>
> `make-release.ps1` always passes `--build-arg BUILD_CHANNEL=customer`, which is why Option A is safe. Building here, you must pass it yourself — copy the **public** key up first (it is the half that is meant to ship):
>
> ```bash
> scp ../e360-license-keys/license-public.pem e360@<server>:/opt/e360/app/   # from your machine
>
> # on the server
> KEY_B64=$(base64 -w0 license-public.pem)
> docker compose -f compose.yaml -f compose.prod.yaml build \
>   --build-arg BUILD_CHANNEL=customer \
>   --build-arg LICENSE_PUBLIC_KEY_B64="$KEY_B64" \
>   --build-arg BUILD_ID=2026-09-07-v1 \
>   api web
> rm -f license-public.pem
> ```
>
> Those three argument names are exactly what the Dockerfile accepts. The fix — inverting the Dockerfile default to `ARG BUILD_CHANNEL=customer` so an unspecified build fails *closed* — has been proposed and **not applied**. Until it is, verify per §4.4 on every deployment.

**Also build-time:** the web image bakes `VITE_DEFAULT_ORG_SLUG` from `ORG_SLUG` (it pre-fills the organisation box on the sign-in page). **`.env` must contain the client's `ORG_SLUG` before you build `web`**, or you will need `docker compose build web` again.

> **Check your source is current.** The `2026-08-28` package on the build machine predates the 2026-09-05 SIS performance fix — its `sis-dataset.service.ts` is the pre-cache version, which costs ~460 ms on every SIS request instead of ~4 ms. Cut the release from the current tree, not from that folder.

## 3.3 Create `.env`

```bash
cd /opt/e360/app
bash ops/init-env.sh
```

**Use `bash ops/init-env.sh`, not `./ops/init-env.sh`.** PowerShell's `Compress-Archive` does not preserve Unix mode bits, so on Option A the `.sh` files extract without the execute bit and `./` gives *Permission denied*.

This is the Linux twin of `init-env.ps1`. It copies `.env.docker.example` to `.env` and generates, with `openssl rand -hex 32`, any of these that are missing, blank, all-zeros or still `change-me…`:

| Generated | Why it cannot have a default |
|---|---|
| `JWT_ACCESS_SECRET` | Signs sessions. A published default would let anyone mint a token |
| `MFA_ENCRYPTION_KEY` | 64 hex characters. **Also encrypts HR and SIS provider credentials and MFA seeds** |
| `WAHA_API_KEY` | The `X-Api-Key` the application sends to WAHA |
| `WAHA_DASHBOARD_PASSWORD` | Left unset, WAHA randomises it every start and prints it only to its own log |

Re-running never overwrites a secret already set, so it is safe on a working install.

> **Back up `MFA_ENCRYPTION_KEY` with the database, as one artefact.** A dump restored without the matching key gives you every row back and no working HR/SIS provider credentials — every one must be re-entered, every MFA user must re-enrol.

## 3.4 Edit `.env`

```bash
chmod 600 .env
nano .env
```

```env
# ---- database ----
POSTGRES_PASSWORD=<long random string>     # the template ships "postgres". Change it.

# ---- the setting people get wrong ----
PUBLIC_APP_URL=https://360.client.com      # exact origin. https. no trailing slash. no port.

# ---- THE PORT THAT COLLIDES WITH CADDY — read the warning below ----
WEB_PORT=8080

# ---- first-run tenant (db-init uses these ONCE) ----
ORG_NAME=CARE Pvt. Ltd.
ORG_SLUG=care                              # must equal the licence --slug
ADMIN_EMAIL=admin@client.com
ADMIN_PASSWORD=<strong; changed at first sign-in>
DEFAULT_ORG_SLUG=care

SEED_DEMO_DATA=false                       # the prod overlay forces this anyway

# ---- operational ----
TZ=Asia/Karachi                            # NOT UTC — see below
LOG_FORMAT=json
LOG_LEVEL=warn

# ---- pin so a rebuild in six months gives the same stack ----
WAHA_IMAGE=devlikeapro/waha:2026.8.1       # only if you use WAHA
```

> ### ⚠ `WEB_PORT` must be set explicitly, and it must not be 80
> `compose.yaml` defaults `WEB_PORT` to **8080**. `compose.prod.yaml` overrides the web port mapping to `'${WEB_PORT:-80}:80'` — **inverting the default to 80**. `.env.docker.example` ships `WEB_PORT=8080`, so following this runbook works. But blank or delete that line and the web container grabs host port 80, Caddy cannot bind it, and both the HTTPS redirect and the Let's Encrypt HTTP-01 challenge fail — with an error that points at Caddy rather than at Compose. Set it explicitly and leave it set.

Three settings deserve more than a line:

**`PUBLIC_APP_URL`.** Every outgoing link is built from it — parent invitations, password resets, QR codes — and it also becomes `CORS_ORIGIN`. It must be the exact origin users type. `communication.settings.ts` treats `localhost`, `127.0.0.1`, `::1`, `0.0.0.0` and the Docker service names as unreachable, and with `NODE_ENV=production` (which the runtime image sets) `requireExternalBaseUrl()` **throws a `BadRequestException` — "Refusing to send an unreachable link"** rather than sending a dead one. That refusal is correct behaviour and is exactly what you will hit if you leave this at localhost. Pick apex or `www` and be consistent; serving on both origins breaks CORS on whichever is not configured.

**`TZ`.** The reminder scheduler uses container local time. Left at UTC, "09:00 reminders" go out at 2 p.m. in Karachi.

**`POSTGRES_PASSWORD`.** The template ships `postgres`. Change it **before the first `up`** — it is baked into the volume at initialisation.

## 3.5 Start

```bash
cd /opt/e360/app
docker compose -f compose.yaml -f compose.prod.yaml up -d --no-build     # Option A
# docker compose -f compose.yaml -f compose.prod.yaml up -d              # Option B (builds)
```

**`--no-build` matters on Option A.** The release package contains no `apps/` and `Dockerfile*` is on `make-release.ps1`'s forbidden list, so any Compose action that decides to build will fail.

`db-init` runs as a one-shot container on every start and exits. Every step is idempotent, so there is no separate first-run command:

1. Creates the `mock_sis` database alongside the main one
2. Applies `database/000_initial_schema.sql`, then `database/001_reconcile.sql`, and stamps `schema_migrations`
3. Seeds the permission catalogue and the five system roles
4. Bootstraps the tenant from `ORG_NAME` / `ORG_SLUG` / `ADMIN_EMAIL` / `ADMIN_PASSWORD`
5. Skips demo content (`SEED_DEMO_DATA=false`)
6. Pushes and seeds the Mock SIS schema

**There is no migration tool to run by hand.** The SQL is hand-maintained and reapplied every start; `001_reconcile.sql` is additive and idempotent — 643 `IF NOT EXISTS` statements, no `DROP`, `TRUNCATE`, `DELETE` or `SET NOT NULL`.

## 3.6 Give the client a usable starting point

`SEED_DEMO_DATA=false` gives a tenant with an administrator, permissions and the five roles — **and nothing else. No competencies, no questionnaires, no rating scale.** The client cannot run a cycle on that.

Run the new-client provisioner once:

```bash
COMPOSE="docker compose -f compose.yaml -f compose.prod.yaml"

# preview — changes nothing
$COMPOSE run --rm \
  -e NEW_CLIENT=true -e NEW_CLIENT_DRY_RUN=true \
  -e ORG_NAME="CARE Pvt. Ltd." -e ORG_SLUG=care \
  -e ADMIN_EMAIL=admin@client.com -e ADMIN_PASSWORD='<strong>' db-init

# apply
$COMPOSE run --rm \
  -e NEW_CLIENT=true \
  -e ORG_NAME="CARE Pvt. Ltd." -e ORG_SLUG=care \
  -e ADMIN_EMAIL=admin@client.com -e ADMIN_PASSWORD='<strong>' db-init

$COMPOSE restart api
```

The client then has: the **Standard 5-Point** rating scale; **10 competencies** across core, performance and leadership, each with an active v1 and five proficiency levels; **3 published questionnaires** (*Standard 360 Review*, *Parent / External Feedback*, *Consolidated Parent Feedback*); report settings `min_responses_to_show` 3, `target_score` 3.5, reminders every 3 days; the five system roles and a Super Admin. **No cycles** — they build their own. **Email, SMS and WhatsApp all disabled**, so nothing can be sent until a provider is deliberately configured.

On a brand-new database there is nothing to remove, so this is purely additive. On an existing one it removes the previous tenant — back up first.

## 3.7 Verify

```bash
COMPOSE="docker compose -f compose.yaml -f compose.prod.yaml"
$COMPOSE ps
```

`postgres`, `redis`, `api`, `web` running; `e360-db-init` `exited (0)`; `mock-sis` and `waha` absent.

> **The API's health endpoints are not reachable from the host under the production overlay.** The API no longer publishes 3000, and `apps/web/nginx.conf` proxies only `/api/v1/` and `/(r|qr)/`. `/health` and `/ready` sit at the **root**, outside the `/api/v1` prefix, so nginx does not carry them. Check from inside:

```bash
$COMPOSE exec api node -e "require('http').get('http://localhost:3000/ready',r=>r.pipe(process.stdout))"

# and prove nginx can reach the API — the usual failure:
$COMPOSE exec web wget -qO- http://api:3000/health
```

A healthy `/ready` reports `"status":"ok"`, `database: up`, and schema version `2026.08.21-01` (the build's `EXPECTED_SCHEMA_VERSION`). `"degraded"` means Redis is down — the API falls back to inline delivery and stays ready — **or** the applied schema trails the build. Both are reported; the second means `db-init` did not do what you think.

**To eyeball the SPA before HTTPS is up, do not open 8080 to the world.** Tunnel it:

```bash
# from your workstation
ssh -L 8080:127.0.0.1:8080 e360@<server-ip>
# then browse http://localhost:8080
```

That keeps §2.3's port list honest.

---

# 4. License

## 4.1 The two-machine rule

| | Your machine | Cloud server |
|---|---|---|
| `license-private.pem` | yes, and nowhere else | **never** |
| `license-public.pem` | yes | only transiently, if building per Option B |
| `tools/license.cjs` | yes | no — it is on `make-release.ps1`'s forbidden list |
| Source tree | yes | preferably not (Option A) |

The private signing key must never be on the cloud server, in the repository, in a Docker image, or in the customer package. It is the only thing that can mint a licence.

## 4.2 Issue the licence (your machine)

```bash
node tools/license.cjs keygen        # once, ever — writes ../e360-license-keys/

node tools/license.cjs create \
  --org "CARE Pvt. Ltd." --slug care \
  --edition professional --employees 800 \
  --expires 2027-09-06 \
  --license-id "CARE-360-2026-0001" \
  --out care-license.txt

node tools/license.cjs verify --file care-license.txt
```

`--slug` **must equal `ORG_SLUG` in the server's `.env`.** That binding is what stops the licence being moved to another installation.

## 4.3 Install it

Nothing to configure. A release build carries the trusted public key compiled in; `LICENSE_PUBLIC_KEY` in `.env` is **ignored entirely on a customer build** (`license.crypto.ts` only reads it when the channel is not `customer`) and exists so an internal build can point at a throwaway key pair.

Sign in as the administrator → **Licence** → paste or choose the file → **Install licence**.

The licence lives in PostgreSQL, so it survives `docker compose down` and `up` and is covered by the database backup. Only `docker compose down -v` destroys it. `db-init` never touches it.

| Refusal | Cause |
|---|---|
| *no licence verification key* | Build produced without a trusted key. Not fixable by configuration — rebuild per §3.2 |
| *issued for the organisation "x", but this installation is "y"* | Licence `--slug` ≠ `ORG_SLUG` |
| *could not be verified* | Truncated paste, or a different key pair |

## 4.4 Prove enforcement is on

Because of the `BUILD_CHANNEL` defect, do not assume. Before installing the licence, confirm the application **refuses to operate unlicensed**. If it runs happily with no licence, you are on an internal build (`license.service.ts` returns the development licence when the build is internal and `LICENSE_REQUIRE` is not `'true'`) and must rebuild.

Belt and braces in `.env`:

```env
LICENSE_REQUIRE=true
```

then `$COMPOSE up -d` to recreate the API container. Redundant on a correct customer build; on a mis-built one it is the difference between enforced and not.

## 4.5 What to tell the client, accurately

**True:** Ed25519-signed claim, so editing the readable payload invalidates the signature; the private key never leaves the vendor; the build carries only the public half and can verify but never sign; the licence is bound to the organisation slug; installation and replacement are audited.

**Must not be claimed:**

> A licence cannot stop a technically capable administrator with root access on the server. They control the operating system, the container runtime and the files on disk, and can modify the application. The design raises the effort from a configuration change to a deliberate modification of a delivered binary artefact — which makes a bypass an evidenced act rather than a plausible accident. It does not make the software uncrackable, and no on-premise licensing scheme can.

On a cloud server the client controls, put that in the contract. The commercial protections — support and upgrades conditional on a valid licence, the audit trail, the agreement — carry the rest.

---

# 5. Domain and HTTPS

The application **does not terminate TLS**. Put a reverse proxy in front. Caddy is the right choice: automatic Let's Encrypt certificates and renewal, no certbot cron to forget.

## 5.1 DNS

A record: `360.client.com` → the server's public IPv4. Confirm it resolves before installing Caddy — the certificate request fails otherwise.

```bash
dig +short 360.client.com
```

## 5.2 Install

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

## 5.3 Configure

```bash
sudo nano /etc/caddy/Caddyfile
```

```caddyfile
360.client.com {
    encode zstd gzip

    # The web container publishes WEB_PORT (8080) on the host; nginx inside it serves
    # the SPA and proxies /api/v1 and the short-link paths to api:3000.
    reverse_proxy 127.0.0.1:8080

    # The application emits HSTS only when it can see an https request, and the web
    # container's nginx overwrites X-Forwarded-Proto with its own $scheme (http).
    # So set it here, at the edge, where it is true.
    header Strict-Transport-Security "max-age=31536000; includeSubDomains"

    log {
        output file /var/log/caddy/e360.log
        format json
    }
}
```

```bash
sudo systemctl reload caddy && sudo systemctl status caddy
curl -I https://360.client.com
```

Caddy redirects HTTP to HTTPS and renews on its own.

## 5.4 Three proxy facts worth knowing

**HSTS from the application will not fire.** `main.ts` emits `Strict-Transport-Security` only when `req.secure` or `x-forwarded-proto === 'https'`. The web container's nginx sets `X-Forwarded-Proto $scheme`, and `$scheme` there is `http`, so the API always sees http behind the proxy. Setting it in Caddy, as above, covers it. The other headers — `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` — are unconditional and unaffected.

**Audit logs will record the proxy's IP, not the client's.** Express `trust proxy` is not set, so `request.ip` — which `current-user.ts` writes into the audit trail — resolves to the Docker bridge address. If per-user source IPs matter for the client's compliance story, say so now, not after an incident. Caddy's own access log has the real addresses.

**Rate limiting is not in this config, and standard Caddy cannot do it.** The interactive API is unthrottled — `ThrottlerModule` is registered only on the external API-key surface. Account lockout covers password guessing against a known account (default 5 attempts / 15 minutes, per-organisation, configurable with a floor of 3). If you want edge throttling on `/api/v1/auth`, it needs either a Caddy build with the `caddy-ratelimit` plugin or nginx instead of Caddy. Decide deliberately; do not assume it is there.

---

# 6. Security

## 6.1 Firewall

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from <your-admin-ip> to any port 22 proto tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable && sudo ufw status verbose
```

> ### ⚠ Docker bypasses ufw, and a ufw rule will not fix it
> Docker publishes ports by writing iptables rules whose `DOCKER-USER`/`DOCKER` jumps sit in `FORWARD` **before** `ufw-user-forward`. A published `8080:80` binds `0.0.0.0` and answers from the internet with ufw denying it — and `ufw route deny 8080` does **not** reliably stop it. This is the most common self-hosting mistake.
>
> Three real defences:
> 1. **Use the production overlay, always.** Only `web` publishes anything.
> 2. **Bind web to loopback.** Change `compose.prod.yaml` line 34 from `'${WEB_PORT:-80}:80'` to `'127.0.0.1:${WEB_PORT:-8080}:80'`. Caddy reaches it; the internet cannot. `WEB_PORT` alone cannot express an interface, so this is a file edit — worth making, but it is a change to a release-managed file, so do it deliberately and note it.
> 3. **Or a `DOCKER-USER` rule**, which is the layer Docker actually consults:
>    ```bash
>    sudo iptables -I DOCKER-USER -p tcp --dport 8080 ! -s 127.0.0.1 -j DROP
>    ```
>    (persist with `iptables-persistent`).
>
> **Then verify from off the box, which is the only honest test:**
> ```bash
> nmap -Pn <server-ip>        # expect 22, 80, 443 and nothing else
> ```

## 6.2 Do not expose PostgreSQL or Redis

- **PostgreSQL** — `compose.prod.yaml` does `ports: !reset []`. The API reaches it as `postgres:5432` on the internal bridge. Verify with the `published:` count in §2.2.
- **Redis** — not published by `compose.yaml`. **But note `docker-compose.yml` at the repo root does publish `6379`** — that is the two-service *development* file, used by `npm run db:up`. It is not part of this deployment and is not in the release package, but on Option B it is sitting in the clone. Never run it on this server.
- **Mock SIS** — `replicas: 0`. Its `/admin` page is **deliberately unauthenticated**; it is a vendor simulator, not a product feature.
- **WAHA** — `replicas: 0`. If you enable it, do not publish 3001 to the world; its dashboard is behind basic auth only.

## 6.3 Server hardening

```bash
# SSH: keys only, no root
sudo nano /etc/ssh/sshd_config
#   PermitRootLogin no
#   PasswordAuthentication no
sudo systemctl restart ssh

sudo apt install -y unattended-upgrades fail2ban
sudo dpkg-reconfigure --priority=low unattended-upgrades
sudo systemctl enable --now fail2ban
```

**Cap Docker's logs before they cap your disk.** Container JSON logs grow without limit, and a full disk takes the database down with it.

```bash
sudo nano /etc/docker/daemon.json
```

```json
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "50m", "max-file": "5" }
}
```

```bash
sudo systemctl restart docker
```

## 6.4 Application-level

- **Change every default before first start:** `POSTGRES_PASSWORD`, `ADMIN_PASSWORD`, `SIS_API_KEY`, `WAHA_API_KEY`, and both generated secrets. Fresh per deployment; never carry a development key into a client's server.
- **Change the admin password at first sign-in** and create individual named accounts. Do not let a team share the bootstrap administrator.
- **Confirm account lockout is enabled** — per-organisation, default 5 attempts in 15 minutes, configurable down to a floor of 3.
- **`.env` is the most sensitive file on the server.** `chmod 600`, never to a git remote.

---

# 7. Backup

## 7.1 Four separate things

| # | What | Where | Restored by an image rollback? |
|---|---|---|---|
| 1 | **Database** — organisations, employees, cycles, responses, scores, **and the installed licence** | `pgdata` volume | **No** |
| 2 | **`.env`** — including `MFA_ENCRYPTION_KEY` | `/opt/e360/app/.env` | **No** |
| 3 | **Volumes** — `waha_sessions`, `waha_media`, `redisdata` | Docker volumes | **No** |
| 4 | **Images** | Docker image store | **Yes** — that is what a rollback restores |

Losing `redisdata` costs at most in-flight notifications. Losing `waha_sessions` means re-scanning the WhatsApp QR. **Losing `pgdata` or `.env` is unrecoverable.**

## 7.2 Use the container method, not `ops/backup.sh`

`ops/backup.sh` exists and works — **but it calls `pg_dump` on the host and reads `apps/api/.env`**, the from-source layout. A Docker-only cloud server has neither. Use the container:

```bash
sudo mkdir -p /var/backups/e360 && sudo chown e360:e360 /var/backups/e360
nano /opt/e360/backup.sh
```

```bash
#!/usr/bin/env bash
# Enterprise 360 — nightly backup, container method. No host psql required.
set -euo pipefail

APP=/opt/e360/app
OUT=/var/backups/e360
STAMP=$(date -u +%Y%m%d-%H%M%S)
RETAIN_DAYS=30
COMPOSE="docker compose -f compose.yaml -f compose.prod.yaml"

cd "$APP"

# 1. database
$COMPOSE exec -T postgres pg_dump -Fc -U postgres -d enterprise360 > "$OUT/db-$STAMP.dump"

# 2. the key that makes the dump readable — same archive, same fate
cp .env "$OUT/env-$STAMP.backup"

# 3. one tarball so the pair can never be separated
tar -czf "$OUT/e360-$STAMP.tar.gz" -C "$OUT" "db-$STAMP.dump" "env-$STAMP.backup"
rm -f "$OUT/db-$STAMP.dump" "$OUT/env-$STAMP.backup"
chmod 600 "$OUT/e360-$STAMP.tar.gz"

# 4. retention
find "$OUT" -name 'e360-*.tar.gz' -type f -mtime +$RETAIN_DAYS -delete

echo "backup: $OUT/e360-$STAMP.tar.gz ($(du -h "$OUT/e360-$STAMP.tar.gz" | cut -f1))"
```

```bash
chmod +x /opt/e360/backup.sh
crontab -e
```

```cron
0 2 * * *  /opt/e360/backup.sh >> /var/log/e360-backup.log 2>&1
```

**Get the archives off the server.** A backup on the same disk as the database is not a backup. Provider object storage, `rclone`, or a nightly `rsync` to a second machine — any of them, but do one.

**Take the provider's snapshot option too.** It recovers the whole machine, not just the data.

## 7.3 Restoring

```bash
APP=/opt/e360/app
COMPOSE="docker compose -f compose.yaml -f compose.prod.yaml"
cd "$APP"

tar -xzf /var/backups/e360/e360-20260907-020000.tar.gz -C /tmp

# Stop the API first. pg_restore --clean drops objects, and it will block or fail
# on locks held by live connections.
$COMPOSE stop api

$COMPOSE cp /tmp/db-20260907-020000.dump postgres:/tmp/restore.dump
$COMPOSE exec -T postgres \
  pg_restore -U postgres -d enterprise360 --clean --if-exists /tmp/restore.dump
$COMPOSE exec -T postgres rm -f /tmp/restore.dump

$COMPOSE up -d --no-build api
```

> **Restoring discards everything written since the dump. There is no merge.** Restore only when the data itself is wrong — never as a routine part of a rollback.

If the archive's `MFA_ENCRYPTION_KEY` differs from the current `.env`, restore the key from the archive too, or HR/SIS provider secrets and MFA seeds will not decrypt.

**Rehearse this once, into a scratch database, before you need it.** A backup you have never restored is a hypothesis.

---

# 8. Updates and Rollback

## 8.1 The Windows scripts do not run here

`ops/init-env.sh`, `ops/backup.sh` and `ops/restore.sh` have Linux twins. **`ops/deploy-release.ps1` and `ops/rollback.ps1` do not** — they are PowerShell, written for a Windows customer server. Below is the same procedure by hand, in the same order, and the order *is* the safety property:

> pre-flight → nothing has changed, every failure is free
> backup → must succeed, or do not proceed
> load/build → does not touch running containers; a failure leaves the app serving
> up → the only genuinely destructive step
> verify → and roll back if it does not pass

## 8.2 Deploying a new version

```bash
APP=/opt/e360/app
COMPOSE="docker compose -f compose.yaml -f compose.prod.yaml"
cd "$APP"

# --- 1. pre-flight ---
$COMPOSE ps
$COMPOSE exec api node -e "require('http').get('http://localhost:3000/ready',r=>r.pipe(process.stdout))"

# --- 2. backup, and check it is non-trivial ---
/opt/e360/backup.sh && ls -lh /var/backups/e360 | tail -3

# --- 3. tag the CURRENT images as the rollback point ---
PREV=$(date -u +%Y%m%d-%H%M%S)
for img in e360-api e360-web e360-api-tools; do
  docker image inspect "$img:latest" >/dev/null 2>&1 && docker tag "$img:latest" "$img:rollback-$PREV"
done
echo "rollback point: $PREV" | tee -a /opt/e360/releases.log

# --- 4. bring in the new images ---
#   Option A:  unzip -d /opt/e360/new <new>.zip
#              for t in /opt/e360/new/images/*.tar; do docker load -i "$t"; done
#              then sync the new compose/database/ops files over $APP, keeping .env
#   Option B:  git pull && $COMPOSE build \
#                --build-arg BUILD_CHANNEL=customer \
#                --build-arg LICENSE_PUBLIC_KEY_B64="$KEY_B64" \
#                --build-arg BUILD_ID=<version> api web

# --- 5. the destructive step ---
$COMPOSE up -d --no-build          # drop --no-build only on Option B

# --- 6. verify ---
$COMPOSE ps
$COMPOSE exec api node -e "require('http').get('http://localhost:3000/ready',r=>r.pipe(process.stdout))"
curl -I https://360.client.com
#   then sign in and open a dashboard.
```

Three images, not four — `e360-mock-sis` is not in the release package and runs at `replicas: 0`.

`db-init` reapplies `001_reconcile.sql` on every start, so a schema change lands automatically. **If `/ready` reports a schema mismatch after an upgrade, run `$COMPOSE run --rm db-init` and read its output.** Do not ignore a degraded readiness.

Keep the last 2–3 rollback tags. **Do not run `docker image prune -a`** — it will delete the rollback point you are relying on.

## 8.3 Rolling back

```bash
APP=/opt/e360/app
COMPOSE="docker compose -f compose.yaml -f compose.prod.yaml"
PREV=20260907-143000      # from releases.log
cd "$APP"

for img in e360-api e360-web e360-api-tools; do
  docker image inspect "$img:rollback-$PREV" >/dev/null 2>&1 && docker tag "$img:rollback-$PREV" "$img:latest"
done

$COMPOSE up -d --no-build
$COMPOSE ps
```

**Roll back as a complete set.** A new API against an old web bundle is worse than either version.

**An image rollback does not restore the database.** If the new version applied a schema change, the old code runs against the new schema. `001_reconcile.sql` is additive only — no `DROP`, no `DELETE`, no `SET NOT NULL` — so this is normally survivable, and it is why rollback is usually image-only. Restore the database (§7.3) only if the data itself is wrong, accepting the loss of everything since the dump.

> `ops/UPGRADE.md` line 95 says restoring the backup is the supported rollback; `DEPLOYMENT.md` Part 3 documents image rollback. **They contradict each other, and `DEPLOYMENT.md` is the accurate one.** Worth resolving before this goes to a client.

---

# 9. Things not to miss

**9.1 `BUILD_CHANNEL` — re-read §3.2.** Build on the server without the build arg and licensing is silently off. Highest-consequence item here.

**9.2 Do not scale the API.** Four `@Cron` jobs run in-process — reminders, HR sync and SIS sync hourly, report schedules daily at 07:00 — with no leader election. A second replica duplicates every one: duplicate reminder messages to real people. One replica; the measurements say one is enough.

**9.3 `MAX_UPLOAD_MB` is not wired into `compose.yaml`.** It defaults to 10 MB in `http-exception.filter.ts`, and setting it in `.env` has **no effect** on the Docker deployment because compose does not pass it to the `api` service. Imports post the spreadsheet as base64 inside the JSON body, inflating it by a third. An 8,000-student roster should sit under 10 MB — but if a large import fails with payload-too-large, this is why, and fixing it needs a `compose.yaml` edit.

**9.4 Never run `docker compose down -v`.** It deletes `pgdata` — every organisation, employee, response, score, and the installed licence. `down` alone is safe.

**9.5 Email deliverability is not a Docker problem.** SMTP is configured per tenant in the application (Communication → Email), not in `.env`. Sending from the client's own domain needs SPF and DKIM records or invitations land in spam — and a parent evaluation in spam is a response you never get. With email disabled (the default), sends are recorded as `skipped` with a reason; that is audited, correct behaviour.

**9.6 WhatsApp needs a decision, not a default.** WAHA's free WEBJS engine drives a real WhatsApp Web session tied to a real phone number — a different commitment from the Meta Cloud API, worth reviewing against WhatsApp's terms before a client depends on it. If you enable it: `--scale waha=1`, keep 3001 closed to the internet, pin `WAHA_IMAGE`, add 2 GB RAM.

**9.7 Monitor `/ready`, not `/health`.** `/health` is liveness — 200 whenever the process is up. `/ready` reports database, Redis and schema version. Since it is not exposed through nginx under the overlay, monitor it with a cron running the `docker compose exec` check and alert on non-`ok`.

**9.8 Pin your image tags.** `postgres:16-alpine` and `redis:7-alpine` float. Pin to patch versions once the deployment is stable, so a rebuild in six months gives the same stack.

**9.9 Deploy from the current source, not the 2026-08-28 folder.** That package predates the SIS snapshot cache added on 2026-09-05, which took SIS requests from ~480 ms to ~4 ms and API peak CPU from 88% to 47%. Everything else in this runbook assumes current source. (The cache is process-local and re-validates against `sis_datasets.updated_at` on every read, so it is safe as deployed and needs no configuration — but a raw-SQL write straight to that table would not bump `updated_at` and would not be picked up. Do not write to it by hand.)

**9.10 Decide who holds `MFA_ENCRYPTION_KEY`.** Not "it is in the backup" — a named person, and a second copy somewhere the server's disappearance does not reach. It is the one piece of this deployment that cannot be reconstructed from anything else.

---

## Quick reference

```bash
APP=/opt/e360/app
COMPOSE="docker compose -f compose.yaml -f compose.prod.yaml"

cd $APP && $COMPOSE ps                    # status
$COMPOSE logs -f api                      # follow the API log
$COMPOSE restart api                      # restart one service
$COMPOSE up -d --no-build                 # apply .env changes (recreates containers)
$COMPOSE down                             # stop, KEEP data
$COMPOSE exec api node -e "require('http').get('http://localhost:3000/ready',r=>r.pipe(process.stdout))"
/opt/e360/backup.sh                       # on-demand backup
```

**Never:** `$COMPOSE down -v` · `docker image prune -a` · `docker compose build` without `BUILD_CHANNEL=customer` · plain `docker compose up -d` without the prod overlay · leaving `WEB_PORT` unset.

---

## Deployment checklist

**Before you start**

- [ ] Server provisioned: 8 vCPU / 16 GB / 160 GB, region near the users, Ubuntu 24.04
- [ ] Domain A record created and resolving
- [ ] Release built from **current** source with `make-release.ps1` (all ten allow-listed files present)
- [ ] Licence issued with `--slug` = the client's `ORG_SLUG`, and `verify` passes
- [ ] `license-private.pem` is on your machine only

**On the server**

- [ ] Docker Engine + Compose v2 from Docker's repo; `published:` count is exactly 1
- [ ] Non-root `e360` user; `unzip -d` used; images loaded (three of them)
- [ ] `bash ops/init-env.sh`; `chmod 600 .env`
- [ ] `WEB_PORT=8080` explicitly set
- [ ] `PUBLIC_APP_URL` = the exact https origin; `TZ` = the client's timezone
- [ ] `POSTGRES_PASSWORD` and `ADMIN_PASSWORD` changed from the template
- [ ] `ORG_SLUG` matches the licence
- [ ] Stack up with `--no-build`; `db-init` exited 0; `/ready` = ok, schema `2026.08.21-01`
- [ ] `NEW_CLIENT` provisioner run (dry-run first) so the client has competencies and questionnaires
- [ ] Unlicensed behaviour confirmed to be refusal; licence installed; `LICENSE_REQUIRE=true`
- [ ] Caddy serving HTTPS; certificate issued; HSTS header present
- [ ] ufw: 22 (admin IP), 80, 443 only — and `nmap` from off-box agrees
- [ ] Docker log rotation configured
- [ ] Backup script installed, cron scheduled, **one restore rehearsed**, archives copied off-box
- [ ] Communication providers left empty until the client configures them deliberately
- [ ] `MFA_ENCRYPTION_KEY` held by a named person, second copy off-server
