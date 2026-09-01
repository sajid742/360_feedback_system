# 10 — Architecture Decision Records

Short records of the decisions that shaped this system, in the classic
**Context · Decision · Consequences · Status** form.

These were reconstructed from the source tree, from `docs/architecture/01`–`06` and `11`,
and from `claude/CHANGELOG.md` and `PROJECT_HANDOFF_SUMMARY.md` in the project docs.
Where the original reasoning is genuinely recorded, it is repeated. Where it is not, the
record says **reasoning inferred from code** — the decision is real, the motive is a
reading of the implementation.

**Sibling documents:** `01-system-architecture.md` · `02-database-erd.md` ·
`03-table-reference.md` · `04-business-workflows.md` · `05-module-architecture.md` ·
`06-api-integration-map.md` · `07-business-rules.md` · `08-codebase-navigation.md` ·
`09-security-model.md` ·
`11-configuration-reference.md`.

**Status legend:** **Accepted** = decided and in force · **Accepted, partial** = in force
with a known incomplete slice · **Superseded** = replaced by a later record.

---

## ADR-001 — Shared-schema multi-tenancy

**Context.** The product serves multiple organisations, including multi-campus groups. The
alternatives were a schema per tenant, a database per tenant, or one shared schema with a
tenant discriminator.

**Decision.** One PostgreSQL schema for every tenant. `organization_id` on every
tenant-owned table, with composite tenant-scoped indexes
(`(organization_id, …)`). Isolation is enforced **at the service layer** — every query
filters on the `organizationId` carried by the request principal. Postgres row-level
security is explicitly **not** used.

**Consequences.** Migrations, seeding and operations stay single-track; cross-tenant
reporting is trivial; connection pooling is simple. The cost is that isolation is a coding
discipline with no backstop: one query that forgets the filter is a cross-tenant leak. The
API integration suite tests tenant isolation because nothing structural does. Adding RLS
later is possible but would require a per-request session variable and a review of every
raw-SQL path.

**Status.** Accepted. Recorded in `PROJECT_HANDOFF_SUMMARY.md`; see also
`09-security-model.md` §10.4.

---

## ADR-002 — Hand-maintained SQL instead of Prisma Migrate

**Context.** Prisma is the ORM (`DECISIONS.md` 002, "AI friendly"), and Prisma Migrate is
its default schema tool. The deployment target includes Windows hosts and Docker Postgres
containers, where the migration engine and shadow database are awkward.

**Decision.** The schema is owned by two hand-written SQL files —
`database/000_initial_schema.sql` (canonical DDL for a fresh database) and
`database/001_reconcile.sql` (idempotent, purely additive `IF NOT EXISTS` reconcile that
also builds a fresh database on its own). `apps/api/prisma/schema.prisma` is kept 1:1 with
them and is used **only** to generate the client. There is no `prisma/migrations/`
directory and no `migrate` script.

**Consequences.** Upgrades are a single re-runnable script that is safe on populated
tables, which is what `deploy.ps1` and CI both do. Partial soft-delete unique indexes,
trigger functions and enum guards — none of which Prisma models well — can be expressed
directly. The cost is real and recurring: **three files must be edited together**, and
nothing mechanically detects drift. A column added to `schema.prisma` alone works locally
and breaks every deployed database. Prisma is also pinned (`npx prisma@5.22.0 generate`)
because a bare invocation pulls an incompatible major version.

**Status.** Accepted. Reasoning partly inferred from code; the Windows/`psql` constraint
and the version pin are recorded in `PROJECT_HANDOFF_SUMMARY.md`.

---

## ADR-003 — Permissions are data, not role checks

**Context.** The obvious shortcut in an RBAC system is `if (user.role === 'HR')`. It does
not survive the first customer who wants a slightly different HR role.

**Decision.** Permission codes are rows in the `permissions` table, resolved per user
through `role_permissions` → `user_roles`. Routes declare
`@RequirePermissions('module.action')`; `PermissionsGuard` checks membership. **No code
anywhere branches on a role name.** Each module owns its codes in
`<module>.permissions.ts` with its own seeder, and `apps/api/prisma/seed.ts` upserts the
whole catalogue.

**Consequences.** New capabilities are additive — declare a code, seed it, grant it. Roles
become pure containers, so `rbac/system-roles.ts` can define the five system roles as
fixed permission *sets* that administrators assign rather than author. The permission
catalogue must be re-seeded after any deployment that introduces codes, or the new routes
answer 403 for everyone. Permission strings are also reused verbatim as partner-API key
scopes (ADR-013), which keeps one authorisation mechanism instead of two.

**Status.** Accepted. Recorded in `PROJECT_HANDOFF_SUMMARY.md` and restated in
`common/auth/require-permissions.decorator.ts`.

---

## ADR-004 — Opaque refresh tokens; permissions embedded in the access token

**Context.** The system needed stateless, cheap authorisation for a chatty SPA plus a
revocable, auditable session concept.

**Decision.** Two different token types. The **access token** is a short-lived JWT
(default 15 minutes) carrying `sub`, `organizationId`, `email`, the full `permissions`
array, `scope`, `employeeId`, `mustChangePassword` and `mustEnrollMfa` — so
`PermissionsGuard` needs no database hit. The **refresh token** is 32 random bytes, not a
JWT: only its SHA-256 hash is stored, and `refresh_tokens` doubles as the session table —
one row is one session, with IP, user agent and device hash. Refresh rotates on every use
with `replacedTokenId` chaining, and presenting a rotated or expired token revokes every
active session for that user.

**Consequences.** Authorisation costs nothing per request; sessions are listable and
individually revocable; token reuse is detectable. The price is **revocation lag** —
removing a role or a grant has no effect until the access token expires and is refreshed.
There is no blacklist and no permission-version claim. Existing sessions are likewise not
retroactively subject to a newly enabled MFA policy; only new logins and refreshes carry
the claim.

**Status.** Accepted, with the lag documented as a known weakness in
`09-security-model.md` §10.1.

---

## ADR-005 — Anonymity by minimum-response threshold, not by data redaction

**Context.** 360 feedback is only honest if reviewers believe they cannot be identified.
The heavy-handed approach is to redact or discard reviewer-linked data.

**Decision.** Nothing is redacted or discarded. Reviewer identity is simply never placed
in a report payload, and a rater-source breakdown is **withheld** until at least
`reports/min_responses_to_show` distinct reviewers (default 3, configurable per tenant)
have submitted. The `self` source is exempt — it is the employee's own rating. The rule
lives in one place, `ReportsService.suppressed()`, and is applied to `individual().bySource`,
radar series, the competency × quadrant matrix, pooled written comments and AI sentiment,
including on the partner Reports API.

**Consequences.** The underlying data stays intact and auditable, so an administrator can
lower the threshold and see more without any migration or recomputation. Scores are
unaffected — suppression is a presentation rule, not a scoring rule. Two consequences bite
in practice: a Line Manager quadrant has one reviewer by definition and is therefore
permanently suppressed at the default threshold (see ADR-016), and a threshold of 1
effectively disables anonymity, which the UI has to make clear.

**Status.** Accepted. Recorded in `claude/CHANGELOG.md` under MH-2.

---

## ADR-006 — A calibrated score is authoritative

**Context.** HR calibration lets a reviewer of the whole cohort override a computed
weighted average. But feedback keeps arriving after calibration, and every submission
triggers a recompute.

**Decision.** `appraisal_participants.calibrated_at` marks an override.
`ScoringService.compute()` checks it first: for a calibrated participant it refreshes
`computed_score` (so the underlying average stays visible) but leaves `final_score` and the
`completed` status untouched. Only approved reviewers' submitted assignments feed the
computation in the first place.

**Consequences.** A late submission can no longer silently revert an approved score and
push the participant back out of `completed` — a bug that also left the audit trail
describing a calibration that no longer matched the stored data (F-C6). The raw average
remains inspectable alongside the override. The trade-off is that after calibration the
displayed score stops tracking new feedback, so the calibration decision needs to be made
at a sensible point in the cycle. Downstream, the trend chart reads the stored
`final_score`, so overrides propagate rather than being recomputed.

**Status.** Accepted. Recorded in `claude/CHANGELOG.md` (F-C6).

---

## ADR-007 — Campuses are rows in `organizations`

**Context.** Multi-campus groups need per-campus reporting, but a campus is not a separate
tenant — people, cycles and competencies are shared across the group.

**Decision.** A campus is an `organizations` row with `org_type = 'campus'` and
`parent_org_id` pointing at the tenant root. Every other tenant-scoped table keys off the
**root** organisation id. `departments.campus_id` and `employees.campus_id` are separate,
optional attribution links.

**Consequences.** No second hierarchy table, and campus roll-ups are a plain join. The
subtlety is that "organization" now means two things in the schema — the tenant boundary
and a campus node — so `organization_id` on any other table must always be the root, never
a campus. Getting this wrong is silent: `db:sample` once modelled campuses as departments
and never set `employee.campus_id`, so the campus dashboard had nothing to group by.

**Status.** Accepted. Recorded in `PROJECT_HANDOFF_SUMMARY.md`; the seeding bug is in
`claude/CHANGELOG.md`.

---

## ADR-008 — A generic `configurations` key/value store instead of per-feature tables

**Context.** `DECISIONS.md` 007 states the product principle: "everything configurable,
avoid hardcoding." Taken literally that implies a settings table per feature.

**Decision.** One table, `configurations(organization_id, module, key, value JSONB)`, with
a partial unique index on `(organization_id, module, key) WHERE deleted_at IS NULL`.
Modules read and write their own namespace: `reports/min_responses_to_show`,
`reports/aggregate_visibility`, `auth/*` (password, lockout, MFA, SSO, CAPTCHA),
`hr_integration/settings`, `reminders/*`, `dashboards/*`, `appraisal/cycle_templates`,
`template:*`. `feature_flags` and `system_settings` are separate small tables for the
boolean-flag and platform cases.

**Consequences.** A new setting costs no DDL and no migration, which is what made
cycle templates (F31) and reminder cadence (F6) additive features. The costs are the usual
ones for a JSON store: no type safety and no referential integrity, so every reader must
validate and default — `minResponses()` checks `typeof value === 'number' && value >= 1`,
`dashboard-layout.service.ts` runs a full allow-list sanitiser, and `auth.settings.ts`
clamps every numeric policy. Reads can also multiply: `template.service.list()` once
issued ~60 sequential config reads and had to be collapsed into one prefix query. The
partial unique index rules out `upsert`, so writes go through a shared read-then-write
helper. The generic CRUD surface over this store is API-only.

**Status.** Accepted, partial. See `11-configuration-reference.md`.

---

## ADR-009 — Provider registries for HR, SIS and communication

**Context.** Customers arrive with different HR systems, different student information
systems, and different email/SMS/WhatsApp gateways. None of those can be a compile-time
dependency of the domain.

**Decision.** Three pluggable registries behind narrow interfaces:
`hr-integration/hr-provider.registry.ts` (`bamboohr`, `zoho_people`, `generic-hr`,
`mock-hr`), `sis-integration/sis-provider.registry.ts` (`oneroster`, `generic-sis`,
`mock-sis-snapshot`, plus the stored-snapshot provider) and
`communication/providers/provider.factory.ts` (email / SMS / WhatsApp). Connection
credentials live in `configurations` and are encrypted at rest for HR and SIS. Each
registry also publishes a maturity flag — `stable` or `beta` — with `BETA_PROVIDERS` as the
single source of truth; promoting a connector means validating it against a vendor sandbox
and deleting its entry from that map.

**Consequences.** A new vendor is one adapter file plus a registry entry, with no change to
sync logic, and the mock providers make the whole integration path testable without vendor
credentials — which is also why `apps/mock-sis` exists as a separate app. The honest cost
is that the beta connectors (`bamboohr`, `zoho_people`, `oneroster`) have **not** been
validated against live vendor sandboxes; the label exists precisely to say so.

**Status.** Accepted, partial (F7 live-vendor validation remains open).

---

## ADR-010 — Redis is optional, with inline delivery as the fallback

**Context.** Notification delivery ran through a BullMQ queue backed by Redis. Requiring
Redis raises the deployment floor for small single-server installs.

**Decision.** `DeliveryQueue.onModuleInit()` probes Redis reachability at boot — a
short-lived client with `lazyConnect`, a 1.5 s connect timeout, no retry, errors swallowed,
`ping` in `try/finally`. If `REDIS_HOST` is unset **or** the host is unreachable, delivery
falls back to inline sending in the request path. `/ready` reports Redis as `skipped` when
unconfigured, `down` (overall `degraded`, still ready) when configured but unreachable; the
**database is the only hard readiness gate**.

**Consequences.** The product runs on one box with Postgres alone. The failure mode this
closed was severe: a set-but-unreachable `REDIS_HOST` previously left every message stuck
in `queued`, so reminders, cycle-start mail, OTPs and digests silently never sent (F4).
The trade is that inline delivery happens in the request path, so a slow provider slows the
caller, and there is no retry/backoff without Redis. Reachability is probed once at boot,
not continuously.

**Status.** Accepted. Recorded in `claude/CHANGELOG.md` (F4, F18).

---

## ADR-011 — PDF via the browser's print dialog, not server-side rendering

**Context.** Users want a PDF of an individual 360 report. The standard answer is a
headless browser (Puppeteer/Playwright) or a PDF library in the backend.

**Decision.** No PDF is generated on the server. CSV and XLSX exports are produced by
`report-export.service.ts` (hand-rolled CSV, ExcelJS for XLSX, streamed with `@Res()` to
bypass the response envelope). PDF is a **client-side** concern: `/reports/individual/:id`
is a standalone route with no application chrome, print-specific CSS
(`@media print` hides the action bar, `@page { margin: 16mm }`) and a
"Print / Save as PDF" button calling `window.print()`.

**Consequences.** No headless Chromium in the API image, no font packaging, no rendering
queue, no memory spikes — and the printed output is guaranteed to match what the user sees.
The costs: no server-side scheduled PDF (the scheduled digests are text), no PDF over the
API, and pagination is at the mercy of the browser. The standalone route also forced a
small auth change — `api-client.ts` reads the persisted token directly so the page
authenticates before the auth provider's effect runs.

**Status.** Accepted. Explicitly recorded in `claude/CHANGELOG.md` under MH-1.

---

## ADR-012 — Dashboard composition is client-side; only the layout is persisted

**Context.** Executives and HR want different dashboards, and want to rearrange them.

**Decision.** The widget catalogue is a **frontend registry**
(`features/reports/dashboard/executive-widgets.tsx`, `hr-widgets.tsx`) — a widget is a
React component that renders from an already-scoped data bundle the dashboard has already
fetched. Only the *arrangement* is persisted: `{ widgets: [{ key, span, config }], theme }`
stored as a `configurations` row under module `dashboards`, via
`dashboard-layout.service.ts`. The server does not know what a widget is; it validates the
layout against an allow-list (spans 3/4/6/8/12, six themes, six tones, four chart types, a
fixed icon set, hex colours, clamped `topN`) and drops anything unrecognised.

**Consequences.** Adding a widget is a frontend-only change. Because widgets read the same
pre-scoped bundles, **layout can never widen data access** — the sanitiser is stated in the
code as cosmetic-only for exactly that reason. The mirrored allow-lists are the maintenance
cost: a new theme or chart type must be added on both sides or it is silently dropped on
save. Layouts are also not portable across tenants, and a removed widget key simply stops
rendering.

**Status.** Accepted. Reasoning inferred from code.

---

## ADR-013 — A separate, scope-limited partner Reports API

**Context.** Customers want their own BI dashboards to read 360 results. Handing them a
user account, or JWTs, would put human credentials into scripts.

**Decision.** A read-only API surface at `/api/v1/integration/v1/reports`, authenticated
**only** by `X-Api-Key` (never JWT), rate-limited per key via `ThrottlerGuard`
(`API_RATE_LIMIT`, default 120), ETag'd for conditional caching. Keys are
`prefix.secret`; only the SHA-256 hash is stored and the plaintext is shown once.
`integration/reports-api.scopes.ts` is the **single source of truth** — the controller
decorators, the admin docs endpoint and the admin UI's scope picker all derive from it.
Scopes (`reports.api.*`) are ordinary permission strings checked by the same
`PermissionsGuard`, but are **API-only** and never assignable to an RBAC role.

**Consequences.** One authorisation mechanism serves both humans and machines, and a key
can never widen a person's access. Adding an endpoint is an entry in the scopes file plus a
handler that calls the existing `ReportsService` — no new reporting logic and no new
suppression rule, so anonymity behaves identically to the in-app dashboards. Keys are
tenant-bound and cannot be scoped below organisation level: this surface returns aggregates,
not per-person records.

**Status.** Accepted.

---

## ADR-014 — Append-only feedback audit enforced by a database trigger

**Context.** The administrative audit log (`audit_logs`, written by `AuditService`) covers
mutations generally. Feedback-domain events — who submitted, who viewed whose results, what
was released — need a stronger guarantee than "the application promises not to update them".

**Decision.** A separate table, `feedback_audit_events`, written by
`feedback-audit/feedback-audit.service.ts`, with append-only enforced **in Postgres**: a
`BEFORE UPDATE OR DELETE ... FOR EACH ROW` trigger calling
`feedback_audit_events_no_mutate()`, which raises an exception naming the operation. Defined
in `database/001_reconcile.sql`. Each `results.viewed` entry records the report type, the
appraisee, the cycle, and whether the caller saw sub-threshold quadrants.

**Consequences.** No application bug, ORM cascade or careless script can rewrite feedback
history — the guarantee holds below the service layer, which is exactly where ADR-001's
tenancy guarantee does not. The costs are operational: the table only grows (there is no
retention or archival policy, which intersects with the still-open GDPR item F24), and
`pg_restore --clean` and similar maintenance must recreate the trigger, which the reconcile
script does idempotently.

**Status.** Accepted.

---

## ADR-015 — A minimum-practical test suite, not broad coverage

**Context.** The repository had **zero** tests at the 2026-08-12 readiness review, which
identified operability rather than correctness as the weakness.

**Decision.** One black-box API integration suite (`apps/api/test/api.e2e.test.mjs`, run by
`node --test`) covering the business invariants that would be catastrophic to break —
auth/RBAC, scoring, anonymity suppression, release gating, tenant isolation, the external
Reports API, delivery fallback — plus a single Playwright UI smoke test
(`apps/web/test/ui.smoke.test.mjs`). No unit-test layer, no mocking framework, no coverage
target. CI runs typecheck → schema apply → the full seed chain → build → boot → both
suites. The stated policy is: run the existing suites and test the feature you changed; do
not expand the suite without a clear critical functional reason.

**Consequences.** The suite is fast, has no mock drift, and tests the system as deployed —
it is the regression net every later remediation pass relied on. It also demands a real
Postgres and the complete seed chain, so it cannot run in isolation, and diagnosis is
coarse: a failure says the invariant broke, not which unit broke it. Whole modules
(workflow, competency, communication) have no direct coverage. The suite itself had to be
fixed once when its repeated logins tripped account lockout — it now uses a per-run
throwaway address.

**Status.** Accepted. Recorded in `claude/CHANGELOG.md` (F16, F23).

---

## ADR-016 — Quadrant anonymity protects the evaluator, not the appraisee

**Context.** The minimum-response threshold (ADR-005) was applied to **every** caller.
Because a Line Manager quadrant has exactly one reviewer by definition, that quadrant was
permanently "Confidential" to everyone — including HR, who run the programme, and the
employee's own manager, who are the people expected to audit whether a cycle ran properly.
A closely related bug had the same root confusion: `myReviews()` returned the literal string
`'Confidential'` in place of the **appraisee's** name whenever the source was anonymous, so
roughly two thirds of review tasks were titled "Confidential" with no indication of whose
performance was being rated — while the invitation e-mail for the same assignment named
them anyway.

**Decision.** State the principle explicitly and implement to it. `feedback_sources.is_anonymous`
and the response threshold both protect **the evaluator's** identity from the appraisee.
Neither has ever meant "hide the person being reviewed". Concretely: `myReviews()` and
`form()` always return the appraisee plus an `anonymousToAppraisee` flag carrying the
quadrant's real meaning; and a new permission, **`reports.confidential.view`**, lifts
sub-threshold suppression **for that caller only**, granted by default to HR/Admin and to
Manager — whose `reporting` scope already confines it to their own line.

**Consequences.** HR can audit a cycle; managers can see single-reviewer quadrants inside
their own reporting line; reviewers can tell whose feedback they are writing. Nothing else
moves: stored data, the threshold, the score calculation and what every other caller sees
are unchanged, and **no reviewer identity is returned in either case**. Elevated views are
distinguishable in the audit trail — `results.viewed` records `confidential: true`. The
residual risk is stated rather than engineered away: an organisation whose policy is that
managers must not see single-reviewer quadrants revokes the permission in Access Control.

**Status.** Accepted (2026-08-15). Recorded in `claude/CHANGELOG.md` and in
`reports/reports.permissions.ts`.

---

## ADR-017 — Feature flags are enforced on the server and return 404

**Context.** The `ai_insights` flag was honoured only by the frontend menu. Turning it off
hid the nav item while the route and every AI endpoint kept answering anyone who typed the
URL.

**Decision.** `AiEnabledGuard` checks the flag server-side on every AI endpoint, and a
`FeatureRoute` wrapper keeps the UI honest. A disabled module responds **404, not 403** —
the same as a route that does not exist. An unset flag keeps the supplied default, so
existing organisations are unaffected.

**Consequences.** A flag a user can walk around is not a flag; this makes it one. The 404
choice is deliberate: 403 would confirm the feature exists but is withheld. The flag key and
its default are duplicated between `ai/ai-enabled.guard.ts` and the frontend's recognised
list, which must be kept in step. Only `ai_insights` is enforced this way today; other flags
remain presentational.

**Status.** Accepted, partial. Recorded in `claude/CHANGELOG.md` (F27).

---

## ADR-018 — Tenant provisioning sits outside JWT and RBAC

**Context.** Creating an organisation is not an action *within* an organisation. Modelling
it as a permission would mean a Super Admin of org A could create org B.

**Decision.** Provisioning is gated by an operator credential, not a permission:
`PLATFORM_PROVISIONING_KEY` presented as `X-Provisioning-Key` and compared with
`timingSafeEqual`. Creating the **first** organisation is open, because there is nothing to
protect yet. Everything after requires the key. If the key is unset once organisations
exist, provisioning is **refused** rather than falling back to something weaker. A tenant
Super Admin JWT is explicitly insufficient. The in-app `/setup` wizard and the
`bootstrap.cli` both reuse `provisionTenant()` verbatim.

**Consequences.** Multi-tenant boundaries hold even against a compromised tenant admin, and
a single-tenant install can permanently disable further provisioning by leaving the key
unset. The window between deployment and first-run completion is genuinely open — anyone who
can reach `/setup` becomes the first Super Admin — so setup should be completed immediately
or the key set before exposing the instance.

**Status.** Accepted. Recorded in `claude/CHANGELOG.md` (F22).

---

## ADR-019 — Delivery webhooks fail closed and answer uniformly

**Context.** `POST /communication/webhooks/:provider` must be public — providers call it —
and was originally unauthenticated with a stubbed HMAC.

**Decision.** The API is created with `rawBody: true` so the HMAC is computed over the exact
bytes the provider signed, not a re-serialised DTO. `applyWebhook()` resolves the
notification by `providerMessageId` (that row identifies the tenant), reads that tenant's
secret (channel-specific for WhatsApp) and does a timing-safe `sha256=<hex>` comparison —
the same scheme as outbound webhooks. Two rules bind: **fail closed** (a tenant with no
secret cannot accept callbacks — allowing unsigned updates "when no secret is set" would
leave exactly the hole this closes) and **uniform 401** (every rejection returns the same
message, so the response is not an oracle for which message ids or tenants exist; the reason
goes to the log).

**Consequences.** Delivery status can be trusted. This was a breaking change for existing
callback consumers, documented in `ops/UPGRADE.md`, and it requires each tenant to configure
a secret before status callbacks work at all. A first implementation returned 404 for
unknown ids and was corrected precisely because it leaked existence.

**Status.** Accepted. Recorded in `claude/CHANGELOG.md` (F5).

---

## ADR-020 — Reuse existing tables and services before adding new ones

**Context.** A recurring pressure across every feature increment: the obvious
implementation of each new capability is a new table and a new query.

**Decision.** Prefer composition. Cycle templates are a JSON blob in `configurations`, not a
`cycle_templates` table (F31). The individual-report heatmap reuses `radar()`, which already
returns the competency × quadrant matrix with suppression applied — no new query, no schema
change, no second suppression rule. The dashboard drill-down added exactly **one** endpoint
(`/reports/employee-360/:id`) returning only the two things nothing else returned, and every
other change was additive columns on existing payloads. The demo generator never hand-writes
a score: it inserts responses and calls the real `ScoringService.compute()`, so weighted
averages, calibration override and participant status all come from product code.

**Consequences.** The schema stayed small, the reporting semantics stayed single-sourced,
and features shipped without migrations. Two costs are visible: `configurations` accumulates
structural data that a typed table would validate (ADR-008), and composed payloads carry
fields some callers ignore. The demo-generator rule is load-bearing — it is how five real
product defects were found while building the dataset, and any future seed work must keep
it.

**Status.** Accepted. Recorded across `claude/CHANGELOG.md`.

---

## ADR-021 — Deliberate non-goals

**Context.** The 2026-08-12 readiness review produced an F1–F33 backlog. Several items were
closed by explicit decision **not** to build them yet, and it is worth recording those as
decisions rather than as omissions.

**Decision.** Deferred by scope decision, with the stated reasoning:

| Item | Reasoning as recorded |
| --- | --- |
| F9 general rate limiting | Account lockout already covers credential attacks; only the partner API is throttled |
| F20 metrics / APM | `/health`, `/ready` and structured JSON logs cover day-to-day operation |
| F24 GDPR export / erasure / retention | Not scoped; intersects with the append-only audit table (ADR-014) |
| F17 accessibility | Open; roughly 40% of labels carry `htmlFor`, 28 `aria-*` attributes in total |
| F30 comment moderation, F32 SCIM, F33 goals/OKR, pulse, succession, LMS | Roadmap, not readiness |
| F7 live vendor validation | Needs vendor sandbox credentials; the `beta` maturity label exists to say so |
| Cross-module event wiring | A `domain_events` transactional outbox was planned in `PROJECT_HANDOFF_SUMMARY.md`; **no such table exists** in `database/*.sql` or `schema.prisma` today, and the wiring was never completed. Modules call each other's services directly |
| `packages/shared-types` | Declared as a workspace but still an empty barrel |

**Consequences.** These are the honest edges of the system. Anyone planning work should
treat them as known-open rather than undiscovered, and `09-security-model.md` §10 states the
security-relevant ones plainly.

**Status.** Accepted (as deferrals). Recorded in `claude/CHANGELOG.md`.

---

## ADR-022 — Per-quadrant questionnaires, with comparability derived and never stored

**Context.** A cycle carried exactly one questionnaire, served identically to every quadrant.
That is wrong for a school: parents cannot sensibly answer the questions a peer answers, and
"peers rate collaboration, the line manager rates delivery" had no expression at all — the
nearest lever was running a second cycle. The obvious fix invites a second, worse decision:
once quadrants can ask different questions, something has to say which competencies two
quadrants have in common, and the tempting answer is a `quadrant_competencies` mapping table
or a `shared` flag on `competencies`.

**Decision.** Two halves, and the second matters more than the first.

1. **`feedback_sources.template_id`, nullable.** A quadrant may carry its own questionnaire.
   NULL — the default, and the value of every row that predates the column — means "use the
   cycle's". Resolution is one function,
   `appraisal/questionnaire-resolution.ts:resolveTemplateId`
   (`source?.templateId ?? cycle?.templateId ?? null`), called from exactly three places: the
   form a reviewer is shown, the allow-list `assertValidResponses` accepts on submit, and the
   coverage matrix. One rule, three call sites, no fourth interpretation.
2. **No quadrant → competency relationship is stored, because none is needed.** The chain is
   *quadrant → questionnaire → questions → competencies*. A competency is **shared** — and
   therefore comparable between groups — when two or more quadrant questionnaires contain a
   question linked to it. That is computed at read time
   (`shared: entry.quadrants.length >= 2`), never persisted. There is no `shared` column, no
   mapping table, and no screen for one.

**Consequences.** Coverage cannot drift away from the questions people actually answer:
editing a questionnaire or repointing a quadrant changes comparability in the same instant,
with nothing to re-synchronise and no second source of truth to contradict the first. The
cost is that comparability is **not** historical — it describes the questionnaires as
configured now, while the scores beside it came from answers given earlier, so a report can
legitimately show a score for a quadrant the current configuration says is not assessed. The
resolution deliberately favours the score in that case rather than relabelling real data.

The second consequence is the one that justified the work: because coverage is known from
configuration, a blank report cell can finally be labelled. *Not assessed* (that
questionnaire never asked) is now distinguishable from *withheld* (it asked, too few people
answered — ADR-005) and from *no replies*. Before this, all three looked identical, so a
question that was simply never put to peers read as suppressed peer feedback.

Backward compatibility was treated as a requirement, not a hope: a cycle configured before
the column existed behaves identically, and an e2e test asserts exactly that
(*"backward compatibility: a cycle with no quadrant questionnaire behaves exactly as
before"*).

**Status.** Accepted (2026-08-20). Recorded in `database/001_reconcile.sql`
(migration `2026.08.20-01`) and in the header comment of
`apps/api/src/appraisal/questionnaire-resolution.ts`. Supersedes the earlier statement in
`04-business-workflows.md` §5 and `07-business-rules.md` §7 that no quadrant→competency
relationship could exist; see BR-6.5, BR-7.2 and BR-7.5.
