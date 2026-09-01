# 08 — Codebase Navigation

**Where is what?** A practical map of the repository for someone who has been handed a
change request and needs to know which file to open. Every path below was checked against
the working tree.

**Sibling documents:** `01-system-architecture.md` · `02-database-erd.md` ·
`03-table-reference.md` · `04-business-workflows.md` · `05-module-architecture.md` ·
`06-api-integration-map.md` · `07-business-rules.md` · `09-security-model.md` ·
`10-adr-summary.md` · `11-configuration-reference.md`.

> This document answers *where*. For *why a rule behaves as it does*, see
> `07-business-rules.md`; for *who may see what*, see `09-security-model.md`; for
> *why the system is shaped this way*, see `10-adr-summary.md`.

**Status legend:** **Implemented** = code and UI wired · **Partial** = working with a
documented gap · **API-only** = endpoints, no UI · **Planned** = not built.

---

## 1. Top-level folder map

| Path | What lives there |
| --- | --- |
| `apps/api/` | The entire backend. NestJS 10, global prefix `/api/v1`, port 3000. |
| `apps/web/` | The single-page admin and reviewer app. React 18 + Vite, port 5173. |
| `apps/mock-sis/` | A vendor-shaped Student Information System used for integration testing. Port 3100. Not part of the product. |
| `packages/shared-types/` | Declared barrel for cross-app types. Currently a stub. |
| `database/` | The two hand-maintained SQL files that are the real schema. |
| `docs/` | This architecture set plus `docs/DEMO_DATA.md`. |
| `ops/` | Backup/restore scripts and runbooks, upgrade notes, and `DOCKER.md` — the full Docker guide. |
| `claude/` | `MENU_NAVIGATION.md` — the navigation/menu reference. |
| `.github/workflows/` | `ci.yml` — the only CI pipeline. |
| Root | `package.json` (npm workspaces + every `db:*` script), `compose.yaml` (the full Docker ecosystem), `compose.prod.yaml`, `docker-compose.yml` (dev datastores only), `.env.docker.example`, `deploy.ps1`, `start-dev.ps1`, `README.md`, `DEPLOYMENT.md`, `WINDOWS_DEPLOY.md`, `COMMUNICATION_SETUP.md`. |

## 2. Entry points

| File | Role |
| --- | --- |
| `apps/api/src/main.ts` | API bootstrap. Sets the `api/v1` global prefix (with `/health`, `/ready`, `/r/:code` excluded), security headers, CORS, the strict `ValidationPipe`, the response-envelope interceptor, the HTTP exception filter, structured logging, `rawBody: true` (needed for webhook HMAC) and the `MAX_UPLOAD_MB` body limit. |
| `apps/api/src/app.module.ts` | Root module. Imports the 25 feature modules, `PrismaModule`, `AuditModule`, Passport, `ScheduleModule.forRoot()`, and registers `RequestContextInterceptor` as a global interceptor. **A new module is not live until it is listed here.** |
| `apps/web/src/main.tsx` | React root. Mounts `<App />`. |
| `apps/web/src/App.tsx` | The router. Public routes (`/login`, `/setup`, `/forgot-password`, `/reset-password`, `/set-password`, `/enroll-mfa`, `/evaluate/:token`, `/reports/individual/:employeeId`), then everything else behind `RequireAuth` + `AppShell`. All feature screens are `React.lazy` chunks. **Add a screen here or it has no URL.** |
| `apps/mock-sis/src/main.ts` | Mock SIS bootstrap, port 3100, admin UI at `/admin`. |

## 3. Frontend layout (`apps/web/src/`)

**Feature-folder convention.** One folder per product area under `features/`, each holding
its screens plus a single `api.ts` that wraps every call that feature makes. Larger
features add `components/`, `pages/`, `panels/`, `dashboard/`, `hooks.ts`, `types.ts`.
Cross-feature imports are the exception; shared things move to `components/` or `lib/`.

| Path | Contents |
| --- | --- |
| `app/` | Application chrome: `AppShell.tsx` (nav, RBAC-filtered, responsive drawer), `RequireAuth.tsx`, `ErrorBoundary.tsx`, `PageHelpButton.tsx`, `page-help.ts` (route → help registry, longest-prefix match). |
| `components/ui/` | Hand-written primitives over Radix: `button`, `card`, `dialog`, `input`, `tabs`, `toast`, `switch`, `badge`, `skeleton`, `empty-state`, `help-hint`, `label`, `textarea`. |
| `components/shared/` | `DataGridModal.tsx` (the drill-down grid), `StatCard.tsx`. |
| `lib/api-client.ts` | The only fetch wrapper. Unwraps the `{ success, message, data, errors }` envelope, throws `ApiError`, injects the bearer token through an injectable getter. Base URL `/api/v1`. |
| `lib/echart.tsx` | The ECharts wrapper every chart uses. |
| `lib/utils.ts` | `cn()` and small helpers. |
| `features/auth/AuthContext.tsx` | Session state, login/logout, silent refresh, `localStorage` keys `e360.accessToken` / `e360.refreshToken` / user blob. Wires `setAccessTokenGetter`. |
| `features/*/api.ts` | Per-feature API surface — 21 of them. |
| `pages/DashboardPage.tsx` | The landing dashboard (the only screen outside `features/`). |
| `apps/web/docs/screenshots/` | 30 product screenshots used by the manuals. |

Aliases: `@/…` maps to `apps/web/src/…` (`vite.config.ts` + `tsconfig.json` paths).

## 4. Backend layout (`apps/api/src/`)

26 folders: 25 feature modules plus `common/`. The per-module shape is consistent:

```
<module>/
  <module>.module.ts          Nest module
  <module>.controller.ts      routes; @UseGuards + @RequirePermissions here
  <module>.dto.ts | dto/      class-validator DTOs
  <module>.permissions.ts     permission-code constants + their seeder
  services/                   the business logic
  providers/                  pluggable vendor adapters (hr, sis, communication)
```

Feature modules: `ai`, `appraisal`, `auth`, `bulk-generation`, `communication`,
`competency`, `config`, `development`, `external-evaluation`, `feedback-audit`, `health`,
`hr-integration`, `identity`, `integration`, `org-import`, `organization`, `provisioning`,
`questionnaire`, `rbac`, `report-schedule`, `reports`, `sis`, `sis-integration`,
`user-notifications`, `workflow`.

`common/` is the shared foundation, not a feature module:

| Path | Contents |
| --- | --- |
| `common/auth/` | `jwt.strategy.ts`, `jwt-auth.guard.ts`, `permissions.guard.ts`, `require-permissions.decorator.ts`, `must-change-password.guard.ts`, `org-writable.guard.ts`, `current-user.ts` (`AuthUser`, `@CurrentUser()`, `@ReqContext()`). |
| `common/prisma/` | `prisma.service.ts`, `prisma.module.ts` (global). |
| `common/audit/` | `audit.service.ts` — the administrative audit log. |
| `common/context/` | `request-context.ts` (AsyncLocalStorage, `requestCached()`), `request-context.interceptor.ts`. |
| `common/interceptors/` | `response.interceptor.ts` — the response envelope. |
| `common/filters/` | `http-exception.filter.ts` — error shape, 413 mapping, `maxUploadMb()`. |
| `common/logging/` | `structured-logger.ts`, `request-logging.ts` (`X-Request-Id`). |
| `common/dto/` | `pagination.dto.ts`. |

## 5. Database schema locations

There are **three** files and they must stay in step. There is **no Prisma Migrate** —
`apps/api/prisma/` contains no `migrations/` directory, and no `prisma migrate` script
exists in `apps/api/package.json`.

| File | Role |
| --- | --- |
| `database/000_initial_schema.sql` | The canonical DDL for a fresh database. Enum types, ~62 tables, indexes, soft-delete partial uniques. |
| `database/001_reconcile.sql` | Idempotent, **additive** reconcile that lifts an older database to the current shape (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`). It also builds a fresh database on its own. Applied automatically by `deploy.ps1`. Holds the newer tables — e.g. `feedback_audit_events` and its append-only trigger. |
| `apps/api/prisma/schema.prisma` | The Prisma model layer, `@map`/`@@map`'d onto the same snake_case tables. Read by the generated client; **never** used to push or migrate. |

Applying: `npm run db:apply` (copies both SQL files into the Postgres container and runs
them), or `npm run db:reconcile` alone. `npm run db:generate` regenerates the Prisma
client and **must** stay pinned — `npx prisma@5.22.0 generate`.

## 6. Seed and demo data

| Script | npm script | What it does |
| --- | --- | --- |
| `apps/api/prisma/seed.ts` | `db:seed` | Seeds the global `permissions` catalogue from every module's `*.permissions.ts`. |
| `apps/api/scripts/seed-roles.ts` | `db:seed-roles` | Creates/refreshes the five system roles and their grants (`src/rbac/system-roles.ts`). |
| `apps/api/scripts/bootstrap-tenant.ts` | `db:bootstrap-tenant` | Creates an organisation + Super Admin. Flags: `--org`, `--slug`, `--email`, `--password`, `--no-starter-content`. |
| `apps/api/scripts/sample-data.ts` | `db:sample` | Org chart, competencies, a published questionnaire, 50 employees. |
| `apps/api/scripts/demo-data.ts` | `db:demo` | The full demo dataset — cycles, assignments, responses, and the RBAC role assignments for the sample employees. Deterministic and idempotent. |

**Required order** (`docs/DEMO_DATA.md`, and the same order in `.github/workflows/ci.yml`):

```
npm run db:apply
npm run db:seed
npm run db:seed-roles
npm run -w apps/api db:bootstrap-tenant -- --no-starter-content --slug care \
  --email you@example.com --password 'Password123!'
npm run db:sample
npm run db:demo
```

Two traps live in that block:

- **The `npm run -w apps/api` flag-forwarding trap.** The *root* `db:bootstrap-tenant`
  script is itself an `npm run`, and the second npm hop swallows everything after `--` as
  npm config. Invoke the workspace script directly (`npm run -w apps/api db:bootstrap-tenant -- …`)
  or the admin is silently created with the default password and every login fails. The
  root-level form still appears in `README.md`, `DEPLOYMENT.md` and `ops/README-docker.md`.
- **`--no-starter-content`.** Without it the tenant gets a second published
  "Standard 360 Review" questionnaire, because `db:sample` brings its own.

`db:demo` is not optional if you need role-bearing test accounts — it is what assigns
roles to the 50 sample employees.

## 7. Tests and CI

| Path | Contents |
| --- | --- |
| `apps/api/test/api.e2e.test.mjs` | Black-box API integration suite over the business invariants: auth/RBAC, scoring, anonymity suppression, release gating, tenant isolation, the external Reports API, delivery fallback. Run with `npm test` (→ `node --test test/*.test.mjs`). |
| `apps/api/test/helpers.mjs` | Login/fixture helpers for the suite. |
| `apps/web/test/ui.smoke.test.mjs` | Playwright smoke test. Run with `npm run test:ui`. Needs the **Vite dev server** (it relies on the `/api/v1` proxy; `vite preview` does not carry it). |
| `.github/workflows/ci.yml` | Postgres 16 + Redis 7 services → typecheck → `db:generate` → apply both SQL files → the full seed chain → build api + web → boot both → run both suites. A second job builds the three Docker images. |

Testing policy on this project: run the existing suites and test the feature you changed;
do not expand the suite without a clear functional reason.

## 8. Configuration and environment

| File | Role |
| --- | --- |
| `apps/api/.env.example` | The documented API environment: `DATABASE_URL`, `JWT_ACCESS_SECRET`, `JWT_ACCESS_TTL`, `MFA_ENCRYPTION_KEY`, `REDIS_HOST`/`REDIS_PORT`, `PUBLIC_APP_URL`, `CORS_ORIGIN`, `PORT`, `LOG_LEVEL`, `LOG_FORMAT`, `SIS_PROVIDER`/`SIS_BASE_URL`/`SIS_API_KEY`, `PLATFORM_PROVISIONING_KEY`, `MAX_UPLOAD_MB`, `INVITE_TTL_HOURS`. |
| `.env.example` (root) | Only the docker-compose Postgres/Redis knobs. |
| `compose.yaml` / `compose.prod.yaml` | The full containerised ecosystem (web, api, postgres, redis, mock-sis, waha, plus the one-shot `db-init`) and its production overlay. Compose prefers `compose.yaml`, so plain `docker compose up -d` uses it. See `ops/DOCKER.md`. |
| `docker-compose.yml` | Postgres 16 + Redis 7 **only** — the two dependencies of the from-source workflow. Pinned with `-f` by `npm run db:up`/`db:down`, `npm run db:apply`/`db:reconcile` and `deploy.ps1`, so the development path is unaffected by the file above. |
| `ops/docker-init.sh` | What the `db-init` service runs: create databases → apply 000+001 SQL → `db:seed` → `db:seed-roles` → `db:bootstrap-tenant` → optional `db:sample`/`db:demo` → mock-sis `db:push`/`db:seed`. Every step idempotent. |
| `apps/web/vite.config.ts` | Dev proxy: `/api/v1`, `^/r/`, `^/qr` to port 3000. The path-boundary regexes are deliberate so SPA routes like `/reports` are not proxied. `server.host: true` binds `0.0.0.0`, so the dev server is reachable from other devices on the LAN as well as on `localhost`; the proxy targets stay `localhost` on purpose, because they are resolved by the Vite process, not by the visiting browser. See `11-configuration-reference.md` §1.7. |
| `start-dev.ps1`, `deploy.ps1` | Windows dev/deploy helpers; `start-dev.ps1` prints the detected LAN URL alongside the localhost one. Both are **unsigned**, so PowerShell may refuse them — run `powershell -ExecutionPolicy Bypass -File .\deploy.ps1` or `Unblock-File` first. |
| `apps/web/nginx.conf` | Production SPA serving + the same proxy boundary. |
| `apps/api/tsconfig.json`, `apps/web/tsconfig.json` | `strict`, `noUnusedLocals`, `noUnusedParameters` on both. The API tsconfig includes `scripts/**` — seed scripts are typechecked even though they run under `--transpile-only`. |
| `apps/web/tailwind.config.ts`, `postcss.config.js` | Tailwind 3, pinned. |

Runtime (per-tenant) configuration does **not** live in these files — see
`11-configuration-reference.md` and the `configurations` / `feature_flags` /
`system_settings` tables.

## 9. Documentation locations

| Where | What |
| --- | --- |
| `docs/architecture/` | This set (01–06, 08–11). |
| `docs/DEMO_DATA.md` | Demo tenant, sign-in accounts, deliberate gaps. |
| `README.md`, `DEPLOYMENT.md`, `WINDOWS_DEPLOY.md`, `COMMUNICATION_SETUP.md` | Setup and operations. |
| `ops/README-docker.md`, `ops/UPGRADE.md`, `ops/BACKUP_RESTORE.md` | Container, upgrade and backup runbooks. |
| `claude/MENU_NAVIGATION.md` | Menu and navigation reference. |
| `apps/web/docs/screenshots/` | Screenshots consumed by the HTML manuals. |
| Claude Project docs | `PROJECT_CONTEXT.md`, `MODULES.md`, `API_CONTRACT.md`, `DATABASE.md`, `CODING_STANDARDS.md`, `CONFIGURATION.md`, `UI_REFERENCE.md`, `DECISIONS.md`, `ROADMAP.md`, `claude/PROJECT_STATE.md`, `claude/CHANGELOG.md`, and the Administrator / User / Deployment manuals. |

---

## 10. "If you want to change… start looking here"

Backend paths are relative to `apps/api/src/`; frontend paths to `apps/web/src/`.

| If you want to change… | Start here (backend) | And here (frontend) | Status |
| --- | --- | --- | --- |
| Scoring: weighted averages, which assignments count | `appraisal/services/scoring.service.ts` (`compute`) | — | Implemented |
| Calibration / manual score override | `appraisal/services/scoring.service.ts` (`calibrate`), `appraisal/appraisal.controller.ts` | `features/appraisal/CycleDetail.tsx` | Implemented |
| Evaluator assignment, review queue, draft/submit | `appraisal/services/assignment.service.ts` | `features/appraisal/AppraisalPage.tsx`, `CycleDetail.tsx` | Implemented |
| Nomination and nomination approval | `appraisal/services/assignment.service.ts` (`propose`, `nominationStatus`) | `features/appraisal/CycleDetail.tsx` — Nominations tab | Implemented |
| Cycle creation, cloning, participation tracking | `appraisal/services/cycle.service.ts`, `setup.service.ts`, `cycle-template.service.ts` | `features/appraisal/CycleDetail.tsx` | Implemented |
| Which questionnaire a quadrant serves (the fallback rule) | `appraisal/questionnaire-resolution.ts` (`resolveTemplateId`), `appraisal/services/setup.service.ts` (`setSourceTemplate`, `assertTemplate`) | `features/appraisal/CycleDetail.tsx` — Sources tab, `SourcesTab` Questionnaire dropdown | Implemented |
| Competency × quadrant coverage matrix (who is asked what) | `appraisal/questionnaire-resolution.ts` (`cycleCoverage`, `coverageForCycles`), `setup.service.ts` (`coverage`) | `features/appraisal/CycleDetail.tsx` — `CoverageMatrix` | Implemented |
| Whether a competency counts as "shared" / comparable | `appraisal/questionnaire-resolution.ts` (`shared: quadrants.length >= 2`) — derived, **never stored** | `CycleDetail.tsx` Comparable? column; `features/reports/IndividualPerformance.tsx` | Implemented |
| Bulk generation of participants and assignments | `bulk-generation/services/bulk-generation.service.ts`, `plan.service.ts` | `features/bulk-generation/BulkGenerationPage.tsx` | Implemented |
| Executive / HR dashboards and their widgets | `reports/services/reports.service.ts` (`executive`, `hr`) | `features/reports/dashboard/executive-widgets.tsx`, `hr-widgets.tsx`, `shared.tsx` | Implemented |
| Dashboard layout persistence and widget config | `reports/services/dashboard-layout.service.ts` (`configurations`, module `dashboards`; server-side allow-list sanitiser) | `features/reports/dashboard/ConfigurableDashboard.tsx`, `WidgetSettings.tsx` | Implemented |
| Dashboard drill-down (widget → grid → person) | `reports/services/reports.service.ts` (`drilldownParticipants`, `drilldownPending`, `drilldownCompetency`, `employeeDrilldown`) | `features/reports/useDrilldown.ts`, `EmployeeDrilldown.tsx`, `components/shared/DataGridModal.tsx` | Implemented |
| Individual 360 report content | `reports/services/reports.service.ts` (`individual`, `radar`, `gap`), `reports/reports.controller.ts` | `features/reports/IndividualPerformance.tsx` | Implemented |
| Shared-competency comparison (blind spot, spread, consensus) | `reports/services/reports.service.ts` (`sharedCompetencies`, `comparisonRules`) | `features/reports/IndividualPerformance.tsx` — the three panels from "Shared competencies…" onward | Implemented |
| Comparison thresholds (worth noting / acting on, agreement spread, groups needed) | `reports/services/reports.service.ts` (`comparisonRules`, `setFeedbackRules`); config keys `reports/gap_moderate`, `gap_pronounced`, `consensus_sd_low`, `consensus_sd_high`, `comparison_min_quadrants` | Settings → Feedback Rules (`features/config/SettingsPage.tsx` — `COMPARISON_FIELDS`) | Implemented |
| What a blank report cell means (*withheld* vs *not assessed* vs *no replies*) | `reports/services/reports.service.ts` (`radar().assessedBy` / `withheldSources`, `sharedCompetencies().quadrants[].state`) | `features/reports/IndividualPerformance.tsx` (`cellState`) | Implemented |
| Printable / Save-as-PDF report | `reports/services/reports.service.ts` (same payloads) | `features/reports/IndividualReportPage.tsx` — standalone route, `@media print`, `window.print()` | Implemented |
| Competency × department heatmap | `reports/services/reports.service.ts` (`heatmap`) | `features/reports/ExecutiveDashboard.tsx`, `IndividualPerformance.tsx` | Implemented |
| Anonymity threshold and suppression | `reports/services/reports.service.ts` (`minResponses`, `suppressed`, `sourceCounts`); config key `reports/min_responses_to_show` | Settings → Feedback Rules (`features/config/SettingsPage.tsx`) | Implemented |
| Who may see sub-threshold quadrants | `reports/reports.permissions.ts` (`reports.confidential.view`), `reports/reports.controller.ts` (`canSeeConfidential`) | `features/rbac/AccessControlPage.tsx` | Implemented |
| Who may see org-wide aggregates | `reports/services/reports.service.ts` (`aggregateVisibility`, `assertAggregateVisible`) | Settings → Feedback Rules | Implemented |
| Results release / retraction gate | `appraisal/services/setup.service.ts` (`setRelease`), `reports/reports.controller.ts` (`assertReleasedForNonPrivileged`) | `features/appraisal/CycleDetail.tsx` | Implemented |
| Report exports (CSV / XLSX) | `reports/services/report-export.service.ts` | `features/reports/ReportsPage.tsx` | Implemented |
| Scheduled emailed report digests | `report-schedule/report-schedule.service.ts` | — | API-only |
| Communication templates | `communication/services/template.service.ts`, `communication.settings.ts` | `features/communication/CommunicationPage.tsx` | Implemented |
| Communication providers (email / SMS / WhatsApp) | `communication/providers/provider.factory.ts`, `types.ts`, `communication.settings.ts` | `features/communication/CommunicationPage.tsx` | Implemented |
| Message dispatch, queue and Redis fallback | `communication/services/dispatch.service.ts`, `delivery-queue.service.ts`, `notification.service.ts` | — | Implemented |
| Inbound provider delivery webhooks | `communication/communication.controller.ts` (`POST webhooks/:provider`), `communication/services/notification.service.ts` (`applyWebhook`) | — | Implemented |
| Outbound tenant webhooks | `integration/services/webhook.service.ts` | `features/integration/WebhooksTab.tsx` | Implemented |
| Short links and QR codes | `communication/services/short-link.service.ts`, `qr.service.ts`, `communication/redirect.controller.ts` (`/r/:code`) | `features/communication/CommunicationPage.tsx` | Partial — QR is API-only |
| In-app notifications | `user-notifications/user-notification.service.ts` | `features/notifications/NotificationBell.tsx` | Implemented |
| Reviewer reminders (cadence, send hour) | `appraisal/services/reminder.service.ts` | Settings → Reminders | Implemented |
| HR system integration | `hr-integration/hr-sync.service.ts`, `hr-provider.registry.ts`, `hr-connection.service.ts`, `providers/` | `features/hr-integration/HrIntegrationPage.tsx` | Implemented |
| SIS integration and roster snapshots | `sis-integration/sis-sync.service.ts`, `sis-provider.registry.ts`, `providers/`, `sis/providers/tenant-sis.provider.ts` | `features/sis-integration/SisIntegrationPage.tsx` | Implemented |
| Identity mapping (SIS teacher ↔ employee) | `identity/identity-map.service.ts` | `features/external-evaluation/TeacherMappingPanel.tsx` | Implemented |
| Parent / external evaluation links | `external-evaluation/services/evaluation-link.service.ts`, `public-evaluation.controller.ts`, `default-questionnaire.ts` | `features/external-evaluation/SisEvaluationPage.tsx`, `PublicEvaluationPage.tsx` | Implemented |
| Spreadsheet imports (org / employees) | `org-import/services/import.service.ts`, `parse.service.ts`, `validation.service.ts`, `resolver.service.ts`, `template.service.ts` | `features/org-import/ImportPage.tsx` | Implemented |
| Spreadsheet exports of org data | `org-import/services/export.service.ts` | `features/org-import/ImportPage.tsx` | Implemented |
| RBAC roles and their fixed permission sets | `rbac/system-roles.ts`, `rbac/rbac.service.ts` | `features/rbac/AccessControlPage.tsx` | Implemented |
| Adding a new permission code | the module's `<module>.permissions.ts`, then `apps/api/prisma/seed.ts` picks it up; grant it in `rbac/system-roles.ts` | `features/rbac/AccessControlPage.tsx` | Implemented |
| Data scope (organization / reporting / own) | `rbac/scope.service.ts` | — | Implemented |
| Multi-factor authentication | `auth/services/mfa.service.ts`, `auth/crypto/totp.ts`, `auth/crypto/secret-crypto.ts` | `features/auth/SecurityPage.tsx`, `PasswordPages.tsx` (`EnrollMfaPage`) | Implemented |
| Password policy, lockout, history | `auth/auth.settings.ts`, `auth/services/password.service.ts`, `login.service.ts` | `features/auth/SecurityPage.tsx` | Implemented |
| SSO (OIDC/OAuth2) and LDAP sign-in | `auth/services/sso.service.ts`, `ldap.service.ts`, `auth/auth.controller.ts` | — | API-only |
| Sessions, refresh rotation, token claims | `auth/services/token.service.ts`, `session.service.ts` | `features/auth/AuthContext.tsx`, `SecurityPage.tsx` | Implemented |
| Feature flags | `config/services/feature-flag.service.ts`, `ai/ai-enabled.guard.ts` | `features/config/useFeatureFlags.ts`, `FeatureRoute.tsx` | Implemented |
| Generic per-tenant configuration store | `config/services/configuration.service.ts` | Settings screens read/write via module-specific endpoints | Partial — the generic store is API-only |
| Rating scales | `config/services/rating-scale.service.ts` | `features/config/SettingsPage.tsx` | Implemented |
| Partner Reports API and its scopes | `integration/reports-api.scopes.ts` (single source of truth), `reports-api.controller.ts`, `api-key.guard.ts`, `services/api-key.service.ts`, `etag.interceptor.ts` | `features/integration/ApiKeysTab.tsx`, `ExternalApiDocsTab.tsx` | Implemented |
| Administrative audit log | `common/audit/audit.service.ts` | — | Implemented |
| Append-only feedback audit trail | `feedback-audit/feedback-audit.service.ts`; table + trigger in `database/001_reconcile.sql` | `features/feedback-audit/AuditTrailPage.tsx` | Implemented |
| AI insights | `ai/services/insights.service.ts`, `ai-provider.service.ts`, `ai-enabled.guard.ts` | `features/ai/AiPage.tsx` | Implemented |
| Health and readiness probes | `health/health.service.ts`, `health.controller.ts` (root-mounted `/health`, `/ready`) | — | Implemented, no UI by design |
| Org chart | `organization/services/employee.service.ts` (`orgChart`), `organization.controller.ts` | `features/organization/OrgChart.tsx`, `DepartmentOrgChart.tsx` | Implemented |
| Departments / designations / campuses / employees | `organization/services/*.service.ts`, `organization/cycle-guard.ts`, `common/auth/org-writable.guard.ts` | `features/organization/panels/`, `DepartmentDrawer.tsx` | Implemented |
| Employee placement fields (designation, department, campus, reporting to, join date) and the Edit dialog | `organization/services/employee.service.ts` (`create`, `update`), `organization/dto/organization.dto.ts` (`CreateEmployeeDto`, `UpdateEmployeeDto`) | `features/organization/panels/EmployeesPanel.tsx` — `PlacementFields`, `CreateEmployeeDialog`, `EditEmployeeDialog` | Implemented |
| Self-management and reporting-loop rejection | `organization/services/employee.service.ts` (`update`), `organization/cycle-guard.ts` (`wouldCreateCycle`) | `EmployeesPanel.tsx` — the "Reporting to" picker surfaces the server's message | Implemented — `create` deliberately skips the loop walk |
| Competency versioning (draft → active → retired) | `competency/services/version.service.ts` (`cloneDraft`, `activate`), `competency/controllers/competency.controller.ts` | `features/competency/components/CompetencyLibrary.tsx` (**Activate**, **New version**, confirmation dialog), `CompetencyCard.tsx` (`pendingDraft`, draft-pending badge), `pages/CompetencyPage.tsx` (Indicators deep-link prefers the draft) | Implemented |
| Competencies, categories, behaviour indicators | `competency/services/competency.service.ts`, `category.service.ts`, `indicator.service.ts`, `proficiency-scale.service.ts` | `features/competency/components/` | Partial — mappings/levels lack full CRUD |
| Proficiency levels on a new competency | `competency/services/proficiency-scale.service.ts` (`resolveDefault`); config key `competency/default_proficiency_scale` | — | ⚠️ **Known gap** — the key is read but **nothing writes it**, so a UI-created competency gets zero levels (`11-configuration-reference.md` §2.10) |
| Questionnaire builder, question bank, rubrics | `questionnaire/services/template.service.ts`, `question.service.ts`, `rubric.service.ts` | `features/questionnaire/QuestionnairePage.tsx`, `TemplatesPanel.tsx`, `QuestionBankPanel.tsx` | Partial — rubrics API-only |
| Approval workflows | `workflow/services/definition.service.ts`, `engine.service.ts` | `features/workflow/WorkflowPage.tsx` | Partial — instances API-only |
| Development action plans | `development/development.service.ts` | `features/development/DevelopmentPage.tsx` | Implemented |
| Tenant provisioning / first-run setup | `provisioning/provisioning.service.ts`, `tenant-provisioning.ts`, `starter-content.ts`, `bootstrap.cli.ts` | `features/provisioning/SetupPage.tsx` | Implemented |
| Seed / demo data | `apps/api/prisma/seed.ts`, `apps/api/scripts/*.ts` | — | Implemented |
| Navigation, menus, page help | — | `app/AppShell.tsx`, `app/page-help.ts`, `claude/MENU_NAVIGATION.md` | Implemented |
| Screenshots and the HTML manuals | — | `apps/web/docs/screenshots/`; manuals live in the Claude Project docs | Implemented |
| The database schema itself | `database/000_initial_schema.sql` **and** `database/001_reconcile.sql` **and** `apps/api/prisma/schema.prisma` | — | Implemented |

---

## 11. Conventions to follow

- **Permission codes are data.** They are rows in `permissions`, resolved per user through
  `role_permissions`. Guard a route with `@RequirePermissions('module.action')` — never
  branch on a role name. New codes go in the module's `*.permissions.ts`, are seeded by
  `prisma/seed.ts`, and are granted to roles in `rbac/system-roles.ts`.
- **The response envelope is global.** Controllers return raw data;
  `ResponseInterceptor` wraps it as `{ success, message, data, errors }` and
  `api-client.ts` unwraps it. Bypass it only with `@Res()` for byte streams
  (`/reports/export`) and the health probes.
- **snake_case in the database, camelCase in Prisma.** Every model uses `@map`/`@@map`.
  Raw SQL (`$queryRaw`) speaks snake_case; TypeScript speaks camelCase. Do not rename one
  side alone.
- **Both schema files must be edited together.** A column added to
  `schema.prisma` without a matching `ALTER TABLE … ADD COLUMN IF NOT EXISTS` in
  `database/001_reconcile.sql` (and the `CREATE TABLE` in `000_initial_schema.sql` for a
  fresh build) will work locally and break on every deployed database. There is no
  migration tool to catch it for you.
- **Prisma is pinned.** Always `npx prisma@5.22.0 generate`; a bare `npx prisma generate`
  pulls a major version that fails against this schema.
- **No `any`.** Both workspaces compile with `strict`, `noUnusedLocals` and
  `noUnusedParameters`. `npm run typecheck` covers the API `src/`, `prisma/` **and**
  `scripts/` — seed scripts run under `--transpile-only` but are still typechecked in CI.
- **Every mutation is audited.** `AuditService.record()` with previous/new value, reason,
  IP and device; feedback-domain events additionally go to the append-only
  `feedback_audit_events`.
- **Tenant scoping is a service-layer discipline.** Every query filters on
  `organizationId` from the token. There is no row-level security to fall back on — see
  `09-security-model.md`.
