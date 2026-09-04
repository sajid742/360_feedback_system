# Licensing

The application is licensed per organisation. A licence is a short signed string that
states who it is for, until when, how many employees it covers and which modules are
included. It is verified **entirely locally** — there is no licensing server and no
network call — because this product is deployed on-premise.

---

## 1. For the administrator

**Licence** in the main menu (permission `configuration.read`). It shows status, the
licence details, usage against the employee limit, and the included modules.

Installing or renewing needs `configuration.manage` — Super Admin by default. Paste the
licence you were sent, or choose the file, and press **Install licence**. It is verified
before anything is stored, so a mistyped or wrong licence can never displace a working one.

### Statuses

| Status | What it means | What still works |
|---|---|---|
| **Active** | Everything normal | Everything |
| **Expiring soon** | Within 30 days of expiry | Everything. A banner appears |
| **Grace period** | Past expiry, inside the grace window (7 days by default) | Everything. A banner appears |
| **Expired** | Past the grace window | Reading, reporting, exporting and renewing. **Adding employees is blocked** |
| **Not yet active** | Installed ahead of its start date | Nothing new until the start date |
| **Suspended** | Withdrawn by the supplier | Reading and renewing |
| **Invalid** | Signature, format or organisation mismatch | Reading and renewing |
| **Not licensed** | Nothing installed | Reading and renewing |

**Expiry never destroys anything.** No data is deleted, hidden or altered; the database
stays fully accessible; administrators can always reach this page and install a renewal.
An expired licence stops *new* records being created — that is all.

### The employee limit

The limit counts **active** employees. People who have left and been deactivated keep
their feedback history and stop counting, so the number reflects who you are actually
running feedback for.

At the limit, adding a person is refused with a message that names the numbers:

> This licence covers 100 active employees. You currently have 100, so there is room for
> 0 more, but 1 was requested. Nothing has been added. Deactivate employees who have
> left, or upgrade the licence.

A bulk import is checked **as a whole, before anything is written**. An import that would
exceed the limit is rejected entirely — never partially applied.

### Licence vs permissions

Two different questions, both of which must be answered yes:

- **The licence** asks *did this organisation buy this module?*
- **RBAC** asks *is this user allowed to use it?*

A user with every SIS permission sees nothing if the licence excludes SIS. An unlicensed
module answers `404`, the same as a route that does not exist.

---

## 2. For the vendor — issuing licences

> **These tools need nothing but Node.** They are plain JavaScript with no
> dependencies, so they work in any copy of the folder — including a Docker deployment
> where `node_modules` was never installed. You do **not** need `npm install`, and you
> must **never** run them inside a customer's container: the private key belongs on your
> machine and nowhere else.

### Once, ever: create the signing keys

```bash
npm run license:keygen
```

Or, from anywhere, without npm at all:

```bash
node tools/license.cjs keygen
```

Writes `license-public.pem` and `license-private.pem` to `../e360-license-keys`
(outside the repository, deliberately).

- **`license-private.pem`** — the only thing that can mint a licence. Keep it off every
  server, back it up, never commit it. Losing it means re-issuing every licence;
  leaking it means anyone can mint their own.
- **`license-public.pem`** — **compiled into the release build** by `ops/make-release.ps1`.
  It is no longer pasted into a customer `.env`: a key read from a file the customer owns
  could simply be replaced with their own. The
  command prints the exact one-line value to paste into `.env`.

`--force` regenerates and **invalidates every licence already issued**. There is a guard.

### Per customer: issue a licence

```bash
npm run license:create -- \
  --org "ABC University" --slug abc \
  --edition professional --employees 500 \
  --expires 2026-12-31 \
  --license-id "ABC-360-2026-0001" \
  --out abc-license.txt
```

`--slug` must match the organisation slug of the installation — the value users type at
sign-in.

> **If flags seem to vanish**, you are on a build before 2026-08-28, where the root
> `license:*` scripts hopped through `npm run -w apps/api`. Two npm argument parsers in
> series eat `--org value` pairs as if they were npm's own config, and the tool sees only
> the values. The scripts now call the tool directly in one hop. On any build, this always
> works and bypasses npm entirely:
>
> ```bash
> node tools/license.cjs create --org "ABC University" --slug abc --out abc-license.txt
> ```

| Option | Default |
|---|---|
| `--edition` | `professional` |
| `--employees` | from the edition |
| `--days` / `--expires` | from the edition (365) |
| `--starts` | today |
| `--modules` | from the edition, comma-separated |
| `--grace-days` | 7 |
| `--users`, `--notes`, `--org-id` | not set |
| `--out` | prints to the terminal |

Edition presets — starting points only, every value is overridable:

| Edition | Days | Employees | Modules |
|---|---|---|---|
| `trial` | 30 | 50 | feedback, organization, reports |
| `demo` | 60 | 100 | all |
| `standard` | 365 | 100 | + communication |
| `professional` | 365 | 500 | + parent feedback, SIS, HR |
| `enterprise` | 365 | unlimited | all |

### Checking a licence

```bash
npm run license:inspect -- --file abc-license.txt   # read it, no signature check
npm run license:verify  -- --file abc-license.txt   # check the signature and dates
```

---

## 3. Technical

### Algorithm and keys

**Ed25519**, via Node's built-in `crypto` — no dependency added. Chosen because keys and
signatures are small enough to keep a licence paste-able, and because there is no
algorithm-negotiation step and therefore no "alg: none" class of mistake.

Format: `E360-<base64url(payload)>.<base64url(signature)>`. The payload is deliberately
readable — a licence is a signed claim, not a secret. Editing the readable part breaks
the signature, which is the whole point.

The deployed application holds only the public key and can therefore only verify.

### Storage — no migration

The licence lives in the existing `configurations` table as
`module='license', key='current'`. That table is already tenant-scoped, already JSONB,
already carries `created_by`/`updated_by`, and is already in PostgreSQL — so licensing
needed **no schema change at all**, and the licence is covered by your existing database
backup and survives any container restart.

Only the licence string and who installed it are stored. Status and usage are recomputed
on every read, because a stored status goes stale the moment a date passes.

### Tenant binding

Bound to the organisation **slug**, not its UUID.

The slug is what the customer types to sign in and what the vendor knows them by, and it
survives a database restore. A UUID does not — restoring into a freshly bootstrapped
database produces a new one, and binding to it would invalidate a legitimate licence at
the worst possible moment. The organisation id is recorded and cross-checked, but a
mismatch only writes a log line; a slug mismatch is what rejects.

Moving a licence to a different customer's installation therefore fails.

### Enforcement points

| Where | What |
|---|---|
| `EmployeeService.create` | Employee limit, before any other validation |
| `ImportService.run` | Employee limit for the whole file, before the transaction |
| `LicensedFeatureGuard` | Module entitlement, on the SIS, HR, parent-feedback, communication, AI and integration controllers |
| `LicenseService` | Every check, in one place |

`LicenseService` caches the resolved state for 30 seconds per organisation, so
verification does not run on every request.

### Adding a new licensed module

1. Add the key to `LICENSED_MODULES` and a label to `MODULE_LABELS`
   (`apps/api/src/license/license.types.ts`).
2. Put `@RequiresLicensedModule('your_module')` and `LicensedFeatureGuard` on the controller.
3. Add the route to `ROUTE_MODULE` in `apps/web/src/features/license/useLicense.ts` so the
   menu item hides too.

---

## 4. Development, demo and production

Licensing behaviour is fixed at BUILD time, by the build channel compiled into
`apps/api/src/license/build-config.ts`. It is **not** an environment variable, because on
an on-premise install the customer owns the environment.

| Channel | Development licence | Trusted key | Source maps | Used for |
|---|---|---|---|---|
| `internal` | Available when no licence is installed — all modules, unlimited employees, labelled "Development" | `LICENSE_PUBLIC_KEY` honoured | Yes | `npm run dev`, `db:demo`, `start-dev.ps1` |
| `test` | **Off** | `LICENSE_PUBLIC_KEY` honoured | Yes | CI, so tests exercise real licence behaviour |
| `customer` | **Compiled out** | Compiled in; the environment is ignored | **No** | Every artefact that leaves the building |

The committed default is `internal`, so a fresh clone and `npm run dev` work with no key
at all. `ops/make-release.ps1` builds with `BUILD_CHANNEL=customer` and stamps in the
public key; `write-build-config.cjs` **refuses** to produce a customer build without one,
so a build that would reject every issued licence cannot be shipped by accident.

**Demo:** issue a real `demo` licence (`--edition demo`) so a demonstration shows genuine
licence behaviour.

`LICENSE_REQUIRE=true` still switches the development licence off on an internal build —
it can only ever tighten, never loosen.

The development licence is not a hidden bypass: on an internal build it is reported as
`isDevelopment: true` and stated plainly on the licence page, and on a customer build it
does not exist in the compiled output at all. **`NODE_ENV` no longer affects licensing**,
so a mistyped compose file cannot disable it.

### Running the test suite

The API regression suite assumes every module is available, which is true on a
development installation (the development licence includes all of them). **If you install
a restricted production licence into a development database, two tests will fail** — the
AI Insights and external-API tests — because those modules are correctly returning 404.
That is the licence working, not a defect. Remove the licence row, or run the suite
against a development installation:

```sql
DELETE FROM configurations WHERE module = 'license';
```

## 5. Existing installations

Nothing locks out on upgrade:

- **Development and demo installations** pick up the development licence automatically.
- **Production installations** show status *Not licensed* with a clear message. Reading,
  reporting and administration continue; adding employees is blocked until a licence is
  installed. No data is touched.

There is no migration to run and no one-time activation step.

## 6. Docker — end to end

### The verification key needs no setup

A release build already carries the trusted public key, compiled in. There is nothing to
paste into `.env` and nothing to restart before installing a licence — sign in and install
it.

If the Install button ever reports that there is no verification key, the **build** is
faulty, not the configuration; no environment change can fix it, so contact the supplier.

A release build has the development licence compiled out, so a licence is always
required.

### Step 1 — create `.env` (once per deployment)

```powershell
cd "C:\path\to\Enterprise360_App"
.\start-docker.ps1
```

`start-docker.ps1` calls `ops\init-env.ps1`, which copies `.env.docker.example` to
`.env` and generates the three values Compose refuses to start without:

| Generated for you | Why it cannot have a default |
|---|---|
| `JWT_ACCESS_SECRET` | Signs sessions. A published default would let anyone mint a token |
| `MFA_ENCRYPTION_KEY` | 64 hex chars. Also encrypts HR/SIS provider secrets — **back it up with your database**, they are unrecoverable without it |
| `WAHA_DASHBOARD_PASSWORD` | Unset, WAHA randomises it on every start and prints it only to its own log |

Re-running never overwrites a secret you already have, so it is safe on a working install.

Every other variable has a working default. The ones worth setting per client:

```env
ORG_NAME=ABC University          # first-run tenant (used once by db-init)
ORG_SLUG=abc                     # what users type at sign-in
ADMIN_EMAIL=admin@abc.edu
DEFAULT_ORG_SLUG=abc             # which tenant the sign-in page belongs to
PUBLIC_APP_URL=https://360.abc.edu   # every outgoing link is built from this
```

### Step 2 — nothing to do

The verification key is compiled into the release. `LICENSE_PUBLIC_KEY` in
`.env.docker.example` is inert on a customer build and is kept only so an internal build
can point at a throwaway key pair.

If you are running an **internal** build and want it to check real licences, set the key
and restart, since environment variables are read at process start:

```powershell
docker compose -f compose.yaml up -d
```

Compose recreates the `api` container because its configuration changed. No rebuild,
no data loss.

### Step 3 — install the licence

Sign in as Super Admin, open **Licence** in the menu, paste the licence (or **Choose
file**), press **Install licence**.

Or check it first from the command line, without installing:

```powershell
npm run license:verify -- --file abc-license.txt
```

The licence is written to PostgreSQL, so it survives `docker compose down` and `up`, and
is covered by your normal database backup. Only `docker compose down -v` destroys it,
along with everything else.

`db-init` never touches the licence — it seeds tenants and demo content only — so a demo
re-seed cannot overwrite an installed production licence.

### If it is refused

| Message | Cause |
|---|---|
| *no licence verification key* | The build was produced without a trusted key. Not fixable by configuration — rebuild the release with `ops/make-release.ps1` |
| *issued for the organisation "x", but this installation is "y"* | The licence `--slug` must equal `ORG_SLUG` in `.env` |
| *could not be verified* | Truncated paste, or signed with a different key pair |

## 7. Lifecycle, renewal and offline operation

```
   vendor issues a licence          node tools/license.cjs create ...
              |
              v
   customer receives one text file  abc-license.txt  (email, USB, printed)
              |
              v
   administrator installs it        Licence page -> paste -> Install licence
              |
              v
   application verifies it          Ed25519 against the COMPILED-IN public key
              |                     slug must match this installation
              v
   edition and modules enabled      stored in configurations, survives restarts
              |
              v
   status monitored                 Licence page + banner from 30 days out
              |
              v
   renewal issued before expiry     install over the top; no downtime, no restart
```

### Renewal and replacement

A renewal is installed exactly like a first licence: paste it, press **Install licence**.
The new one replaces the old one in place. No restart, no downtime, and nothing is deleted.

| Situation | What to do | Notes |
|---|---|---|
| **Approaching expiry** | Install the renewal any time | `--starts` lets a renewal be issued ahead of its start date |
| **Already expired** | Install the renewal | Reading, reporting and installing all still work while expired; only *new* records are blocked |
| **Changing edition** | Issue a new licence with the new `--edition` and install it | Modules change on the next status read (30-second cache) |
| **Changing employee limit** | Issue with a new `--employees` and install it | Takes effect immediately |
| **Wrong organisation** | Re-issue with the correct `--slug` | A slug mismatch is refused; it must equal `ORG_SLUG` in `.env` |

Verification is checked **before** anything is stored, so a mistyped or wrong licence can
never displace a working one.

> **WARNING — replacing a licence is recorded but not reversible.** The previous licence
> string is not retained. Keep the file you were sent.

### Offline and air-gapped deployments

**Licensing needs no network at any point.** There is no licence server, no activation
call, no heartbeat and no phone-home. Verification is a local Ed25519 signature check
against a public key compiled into the build.

For a site with no internet, no Wi-Fi and no external access:

1. The vendor mints the licence on their own machine.
2. It travels as a text file — email to a connected machine, then USB; or printed and
   retyped, since the payload is plain text.
3. The administrator pastes it into the Licence page. Done.

> **Set the server clock from an internal NTP source.** Expiry, the grace period and the
> "expiring soon" banner are all computed against the server clock, and an air-gapped
> machine has no public NTP to correct drift. A clock that runs fast will report a valid
> licence as expired.

### Security — what this does and does not do

**What is true:**

- The licence is an **Ed25519-signed claim**. Editing the readable payload invalidates the
  signature.
- The **private signing key never leaves the vendor's machine.** It is not in the
  repository, not in any Docker image, and not in any customer package.
- A release build carries only the **public** key, compiled into `dist`, so it can verify
  and never sign.
- A licence is **bound to the organisation slug**, so it cannot be moved to another
  customer's installation.
- Installation and replacement are recorded in the audit trail.

**What is NOT true, and must not be claimed:**

> A licence cannot stop a technically capable administrator with root or Administrator
> access on the server. They control the operating system, the container runtime and the
> files on disk, and can modify the application. The design raises the effort from a
> configuration change to a deliberate modification of a delivered binary artefact — which
> makes a bypass an evidenced act rather than a plausible accident. It does not make the
> software uncrackable, and no on-premise licensing scheme can.

The commercial protections carry the rest: support and upgrades conditional on a valid
licence, the audit trail, and the contract.

---

## 8. Audit

Licence installation and replacement are recorded in the existing audit trail
(`entity_type = 'license'`) with the licence id, edition, expiry and limit — never the
licence string itself. Visible under **Audit Trail**.
