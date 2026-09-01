# Upgrading Enterprise 360 (F-H7)

The database schema is applied by two SQL files rather than a migration tool:

- `database/000_initial_schema.sql` — full schema for a **new** database.
- `database/001_reconcile.sql` — **idempotent, additive** reconcile that brings an
  existing database up to the current schema. Safe to run repeatedly and safe on
  populated tables.

Every release stamps a version into the `schema_migrations` table, so an upgrade can
be **verified** rather than assumed.

## Before you start

1. **Take a backup and confirm it restores** — see `ops/BACKUP_RESTORE.md`.
   The backup includes `MFA_ENCRYPTION_KEY`, without which stored provider
   credentials cannot be decrypted.
2. Note the current version:
   ```bash
   psql "$DATABASE_URL" -tc "SELECT version, applied_at FROM schema_migrations ORDER BY applied_at DESC LIMIT 1;"
   ```
   (No such table means the database predates version tracking — that is expected and fine.)

## Upgrade procedure

```bash
# 1. Stop the API (leave PostgreSQL running)
#    systemd:  sudo systemctl stop e360-api
#    docker:   docker compose stop api        (see ops/DOCKER.md)

# 2. Deploy the new application files, then install + build
npm ci
npm run db:generate
npm run build:api
npm run build:web

# 3. Apply the schema reconcile (idempotent — safe to re-run)
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/001_reconcile.sql

# 4. Re-seed permissions and system roles.
#    REQUIRED whenever a release adds permissions or changes a role's grants.
npm run db:seed
npm run db:seed-roles

# 5. Start the API
#    systemd:  sudo systemctl start e360-api
#    docker:   docker compose start api
```

## Verify the upgrade

```bash
curl -s http://localhost:3000/ready | jq '.status, .checks.schema'
```

Expected:

```json
"ok"
{ "status": "ok", "expected": "2026.08.20-01", "applied": "2026.08.20-01" }
```

The version string above is whatever this build expects — the authoritative value is
`EXPECTED_SCHEMA_VERSION` in `apps/api/src/health/health.service.ts`, which must match
the last `INSERT INTO schema_migrations` at the bottom of `database/001_reconcile.sql`.
What matters is that `expected` and `applied` are **equal**, not the literal string.

- `"status": "outdated"` → step 3 did not run (or failed). Re-run it.
- `"status": "unknown"` → the database predates version tracking; running step 3 fixes it.
- The overall readiness status is `degraded` (not `error`) on a schema mismatch, so the
  service keeps serving while you correct it.

Then sanity-check the application itself:

```bash
# API regression suite (requires the seeded sample org)
npm test
```

## After upgrading

- **Users must sign in again to pick up new permissions.** Permissions are carried in
  the access token, so an existing session keeps its old set until it is refreshed.
- If a release note says a role gained or lost a permission, confirm with
  Access Control → Roles that the matrix looks as expected.

## Rolling back

1. Stop the API.
2. Restore the pre-upgrade backup (`ops/restore.sh`) — this restores both the data and
   the schema as they were.
3. Redeploy the previous application build.

Because `001_reconcile.sql` is additive, a newer schema is generally compatible with
an older application build; restoring the backup is still the supported rollback.

## Breaking change — provider delivery webhooks now require a signature

**Applies from the release that introduced `X-Webhook-Signature`.**

`POST /api/v1/communication/webhooks/:provider` used to accept unsigned callbacks. It
now verifies an HMAC-SHA256 of the raw request body against the organisation's webhook
secret and rejects everything else with `401`. This closes an unauthenticated,
state-changing endpoint, but it means delivery-status callbacks **stop applying** until
both sides are configured.

For each organisation that receives provider callbacks:

1. Sign in as a communication administrator → **Communication → Providers → Delivery
   webhooks**.
2. Click **Generate** (or paste your own value) and **Save provider settings**.
3. Configure the same secret at the provider, and have it send the signature as
   `X-Webhook-Signature: sha256=<hex>` over the raw request body.
   `X-Hub-Signature-256` (Meta) and `X-Twilio-Signature` are accepted as aliases.

Until a secret is set, callbacks are refused — this is deliberate. Message *sending* is
unaffected; only inbound delivery-status updates are gated.

## New — organisation provisioning without the CLI

Creating a tenant no longer requires shelling into the server to run
`dist/provisioning/bootstrap.cli.js` (the CLI still works and is unchanged).

- **Fresh installation:** browse to `/setup`. While no organisation exists the wizard is
  open, creates the organisation, its five system roles, the first Super Admin and
  optional starter content.
- **Adding tenants later:** set `PLATFORM_PROVISIONING_KEY` to a long random string in
  the API environment and restart. `/setup` then asks for that key. Leave the variable
  unset to permanently disable further provisioning on a single-tenant install.

The key is an operator credential and is deliberately **not** an RBAC permission — no
signed-in user of one organisation can create another.

## New — optional per-quadrant questionnaires (no action required)

A quadrant (feedback source) may now carry its own questionnaire template instead of
the cycle's. **This needs no migration action beyond the normal reconcile.**

`001_reconcile.sql` adds `feedback_sources.template_id` as a **nullable** column with
no backfill. NULL is the default and means "inherit the cycle questionnaire", which is
exactly what every existing cycle already did — the resolution is
`source.templateId ?? cycle.templateId`. Every cycle configured before this upgrade
therefore behaves identically afterwards, scored cycles included; there is a regression
test asserting it. Nothing needs to be set, and nothing changes until an administrator
deliberately picks a questionnaire on a quadrant at Appraisals → Cycles → open a cycle →
**Sources** (permission `appraisal.cycle.manage`).

The schema version stamped by this change is `2026.08.20-01`.

## New settings an administrator should review after upgrading

None of these change behaviour on upgrade — each keeps its previous default — but they
are the knobs an organisation will want to set once.

| Where | Setting | Default | Why you might change it |
|---|---|---|---|
| Settings → Reminders | Automatic reminders, days between reminders, send hour | on, 3 days, 08:00 server time | Response rate depends on nudges landing when people read email. |
| Settings → Feedback Rules | Organisation-wide reports | Anyone who can view reports | Restrict department/campus scorecards, trends and heatmaps to executive and HR users. |
| Security | Password & lockout policy | 8 chars, mixed case + number, 5 remembered; 5 attempts / 15 min | Match your organisation's policy without a developer. |
| Communication → Providers | Delivery webhook secret | not set | Required for provider delivery-status callbacks (see the breaking change above). |
| Settings → Feature Flags | AI Insights | on | Turning it off now closes the module's API too, not just the menu item. |
| Access Control → Roles | `reports.confidential.view` | held by Super Admin, HR/Admin and Manager | Lifts the small-sample suppression, so a holder sees per-quadrant scores even when fewer than `min_responses_to_show` (default 3) reviewers replied. It never reveals *who* said what — reviewer identity is in no report payload at any permission level — and every use is written to the feedback audit trail with `confidential: true`. A Manager's data scope is `reporting`, so it only ever applies inside their own line; revoke it there if your policy is that managers must not see single-reviewer quadrants. **Requires `npm run db:seed` (new permission code) and `npm run db:seed-roles`, then users must sign in again** — permissions ride in the access token. |
| Settings → Feedback Rules | Difference worth noting (`gap_moderate`) | 0.5 | How far apart two evaluator groups must score the same competency before the report points it out. Raise it on a coarse scale, lower it if you want smaller differences surfaced. |
| Settings → Feedback Rules | Difference worth acting on (`gap_pronounced`) | 1.0 | The bigger gap reported as pronounced; also the threshold for "perspectives differ sharply" and for a pronounced blind spot. |
| Settings → Feedback Rules | Reviewers agree / disagree below-above this spread (`consensus_sd_low` / `consensus_sd_high`) | 0.3 / 0.75 | How tightly the reviewers **within one group** must agree before their feedback is called consistent, or divided. |
| Settings → Feedback Rules | Groups needed to compare (`comparison_min_quadrants`) | 2 | How many evaluator groups must ask about a competency before their scores are compared at all. Floored at 2 — a comparison needs two sides. |

## Import size

Organisation, HR and SIS imports post the file as base64 inside the JSON body. The
request ceiling is `MAX_UPLOAD_MB` (default **10 MB**), which covers the documented
**5,000 employee rows per file**. Both limits now produce a clear message — a row count
over the cap is reported during validation, before the administrator clicks Import, and
an oversized upload returns `413` naming the limit instead of a bare `500`. Raise
`MAX_UPLOAD_MB` if you genuinely need larger files; splitting the file is usually better.

## Onboarding by invitation

Creating a person can now email them a single-use link to choose their own password
(`INVITE_TTL_HOURS`, default 72) instead of handing over a temporary password. Email must
be configured under **Communication → Providers**; if it isn't, or delivery fails, the
temporary password is shown as before so onboarding never dead-ends. Existing users can
be (re)invited from **Access Control → Users → Invite**.

## For maintainers — adding a schema change

1. Update `apps/api/prisma/schema.prisma`.
2. Add the equivalent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT
   EXISTS` to `database/001_reconcile.sql` **and** to `000_initial_schema.sql` for fresh
   installs.
3. Bump the version in **both** places:
   - the `INSERT INTO schema_migrations` at the bottom of `001_reconcile.sql`
   - `EXPECTED_SCHEMA_VERSION` in `apps/api/src/health/health.service.ts`
4. Note the change in the release notes, including whether `db:seed-roles` is required.
