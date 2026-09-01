# 11 — Configuration Reference

**Enterprise 360° Feedback & Performance Management System**

Audience: the engineer or operator asking **"where does this setting live?"** This is the
single place that answers it. Everything below was verified against the source tree.

Settings live in exactly **three layers**, and which layer a setting is in tells you who can
change it and when it takes effect:

| Layer | Scope | Who changes it | Takes effect |
| --- | --- | --- | --- |
| **1. Environment variables** | Whole installation | Operator, at deploy time | Process restart |
| **2. `configurations` rows** | One tenant | Administrator, at runtime | Next read — usually immediately |
| **3. `feature_flags` rows** | One tenant | Administrator, at runtime | Next read |

There is **no** `@nestjs/config` module, no config service abstraction and no schema
validation of the environment. Every variable is read with a bare `process.env.X ?? default`
at its point of use, so a missing variable silently takes its default rather than failing
fast at boot.

**Sibling documents:** `01-system-architecture.md` · `05-module-architecture.md` ·
`06-api-integration-map.md` · `07-business-rules.md`. Operator procedure lives in
`DEPLOYMENT.md`, `WINDOWS_DEPLOY.md` and `ops/`.

---

## 1. Environment variables

Verified with `grep -rn "process.env\." apps/api/src apps/api/scripts apps/mock-sis/src`,
plus a second pass for **dynamic** access (`process.env[key]`), which the first grep misses —
the four `BOOTSTRAP_*` variables are only reachable that way.

### 1.1 Core runtime — `apps/api`

| Variable | Required | Default | Effect |
| --- | --- | --- | --- |
| `DATABASE_URL` | **Yes** | none | Postgres connection string. Read by Prisma via `env("DATABASE_URL")` in `schema.prisma`, never by application code. Absent means the client fails to initialise. |
| `PORT` | No | `3000` | HTTP listen port. |
| `NODE_ENV` | No | unset | Only affects the default log format — `json` when `production`, `pretty` otherwise. Nothing else branches on it. |
| `CORS_ORIGIN` | No | **development:** unset reflects the caller's origin · **production:** `http://localhost:5173` | Single allowed CORS origin, credentials enabled (`main.ts:66-80`). An explicit value always wins. A **blank** string counts as "not set" — left as `""` it would be handed to the CORS layer verbatim, match no origin at all, and make every preflight fail with a 404 that looks like a routing bug. Also the second fallback for password-reset link building. See §1.7 for LAN access. |
| `JWT_ACCESS_SECRET` | **Yes in production** | `change-me` | HMAC secret for access tokens. Read in two places — `auth.module.ts` for signing and `common/auth/jwt.strategy.ts` for verification. **The default is a working value**, so a misconfigured install boots and issues forgeable tokens rather than refusing to start. |
| `JWT_ACCESS_TTL` | No | `15m` | Access-token lifetime. Because permissions are baked into the token, this is also the maximum staleness window for a role change. |
| `REFRESH_TTL_DAYS` | No | `7` | Refresh-token lifetime in days. Refresh tokens are stored as SHA-256 hashes in `refresh_tokens`. |
| `MFA_ENCRYPTION_KEY` | **Yes if MFA or any provider secret is used** | empty | AES-256-GCM key for secrets at rest. Must be **exactly 64 hex characters**; anything else throws at first use. Encrypts TOTP secrets *and* every HR/SIS provider secret. |
| `PASSWORD_RESET_TTL_MIN` | No | `30` | Minutes a password-reset link stays valid. |
| `INVITE_TTL_HOURS` | No | `72` | Hours an emailed "set your password" invitation stays valid. |
| `PUBLIC_APP_URL` | No | `http://localhost:5173` | Base URL used to build secure links in outbound messages — password-reset links, invitations, and parent evaluation links and QR codes. **Fallback only** — a tenant's `communication/general.publicBaseUrl` wins when set. Left at its default, recipients get `localhost` links that only work on the server. See §1.7. |
| `REDIS_HOST` | No | unset | Enables the BullMQ delivery queue. Unset, or set-but-unreachable, degrades to inline delivery; the reachability probe runs at module init. |
| `REDIS_PORT` | No | `6379` | Redis port. |
| `MAX_UPLOAD_MB` | No | `10` | Request-body ceiling for JSON and urlencoded bodies. Imports post spreadsheets as base64 in the JSON body, so this is the effective import size limit; exceeding it yields a 413 naming this variable. |
| `LOG_LEVEL` | No | `log` | One of `error`, `warn`, `log`, `debug`, `verbose`. |
| `LOG_FORMAT` | No | `json` in production, `pretty` otherwise | Structured-logger output format. |
| `API_RATE_LIMIT` | No | `120` | Partner Reports API requests per window, per API key. Floor of 1. |
| `API_RATE_TTL_MS` | No | `60000` | Rate-limit window in ms. Floor of 1000. |
| `API_CACHE_MAX_AGE` | No | `60` | `Cache-Control: private, max-age` seconds on partner Reports API responses. `0` disables caching but ETags are still emitted. |
| `PLATFORM_PROVISIONING_KEY` | No | empty | Operator credential for `X-Provisioning-Key`. **Leaving it unset permanently disables tenant creation once the first organisation exists** — that is the documented single-tenant posture, not a misconfiguration. |
| `SIS_BASE_URL` | No | `http://localhost:3100/api/v1` | Base URL of the legacy Mock SIS, used only by `MockSisProvider`. |
| `SIS_API_KEY` | No | `mock-sis-dev-key-change-me` | Shared key for the Mock SIS. Read by both the API's `MockSisProvider` and the Mock SIS's own guard. |

### 1.2 Seed and bootstrap scripts

Read only by `npm run db:bootstrap-tenant`, `db:sample` and `db:demo`, never by the running
server. `BOOTSTRAP_*` are accessed dynamically and each is also settable as a CLI flag, which
takes precedence.

| Variable | Default | Effect |
| --- | --- | --- |
| `BOOTSTRAP_ORG` | `CARE Pvt. Ltd.` | Organisation name for the bootstrapped tenant. CLI: `--org`. |
| `BOOTSTRAP_SLUG` | `care` | Sign-in slug. CLI: `--slug`. |
| `BOOTSTRAP_EMAIL` | `sajidq@carepvtltd.com` | Super Admin email. CLI: `--email`. Also read directly by `demo-data.ts`. |
| `BOOTSTRAP_PASSWORD` | `ChangeMe123!` | Super Admin password. CLI: `--password`. |
| `SAMPLE_ORG_SLUG` | `care` | Which tenant `db:sample` and `db:demo` target. |
| `SAMPLE_PASSWORD` | `Password123!` | Shared password for the 50 generated sample users. |

### 1.3 Other workspaces

| Variable | Workspace | Default | Effect |
| --- | --- | --- | --- |
| `MOCK_SIS_DATABASE_URL` | `apps/mock-sis` | none, required | Mock SIS Postgres URL. **Note the name** — the Mock SIS does *not* read `DATABASE_URL`. |
| `PORT` | `apps/mock-sis` | `3100` | Mock SIS listen port. |
| `SIS_API_KEY` | `apps/mock-sis` | `mock-sis-dev-key-change-me` | Key its `ApiKeyGuard` expects. Must match the API's value. |
| `VITE_API_BASE_URL` | `apps/web` | `/api/v1` | Build-time API base. Baked into the bundle; changing it requires a rebuild. |
| `VITE_DEFAULT_ORG_SLUG` | `apps/web` | `care` | Pre-filled organisation slug on the login form. |

### 1.4 Compose-only variables

These appear in `docker-compose.yml` / `compose.yaml` / `compose.prod.yaml` and shape the
containers, but no application code reads them: `POSTGRES_USER`, `POSTGRES_PASSWORD`,
`POSTGRES_DB`, `POSTGRES_PORT`, `MOCK_SIS_DB`, `API_PORT`, `WEB_PORT`, `MOCK_SIS_PORT`,
`WAHA_PORT`, `WAHA_IMAGE`, `WAHA_ENGINE`, `WAHA_API_KEY`, `SEED_DEMO_DATA`, `ORG_NAME`,
`ORG_SLUG`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`.

The last five are read by `ops/docker-init.sh`, not by the application. `WAHA_API_KEY`
configures the WAHA container; the key the API sends is the per-tenant one stored in
`configurations`. The full annotated list is `.env.docker.example`; the guide is
`ops/DOCKER.md`.

### 1.5 Declared but never read

| Variable | Declared in | Reality |
| --- | --- | --- |
| `JWT_REFRESH_SECRET` | `.github/workflows/ci.yml` | **Read by no code.** Refresh tokens are opaque random strings stored as SHA-256 hashes in `refresh_tokens` — they are not JWTs, so there is nothing to sign. Setting it does nothing; omitting it breaks nothing. Already flagged in `ops/README-docker.md`. |
| `SIS_PROVIDER` | `.env.example`, `apps/mock-sis/README.md` | **Read by no code.** The SIS provider is a *per-tenant* choice stored in `configurations` (`sis_integration/settings.provider`) and resolved at request time by `TenantSisProvider`. The env var is a leftover from when the provider was selected once at boot. The `SIS_PROVIDER` symbol in the source is an unrelated DI token. |

### 1.6 `.env.example` is incomplete

`apps/api/.env.example` names 18 variables — 15 active assignments plus 3 commented-out
optionals (`PLATFORM_PROVISIONING_KEY`, `MAX_UPLOAD_MB`, `INVITE_TTL_HOURS`).
**Eleven variables that the code reads are absent from it**, so an operator working from the
example alone silently takes their defaults:

| Absent | Why it matters |
| --- | --- |
| `REFRESH_TTL_DAYS` | Session length is not tunable without knowing the name exists |
| `PASSWORD_RESET_TTL_MIN` | Same, for reset-link validity |
| `API_RATE_LIMIT`, `API_RATE_TTL_MS` | Partner API throughput is not tunable |
| `API_CACHE_MAX_AGE` | Partner cache window is not tunable |
| `BOOTSTRAP_ORG`, `BOOTSTRAP_SLUG`, `BOOTSTRAP_EMAIL`, `BOOTSTRAP_PASSWORD` | The bootstrapped tenant silently gets the hardcoded CARE defaults, **including the well-known password `ChangeMe123!`** |
| `SAMPLE_ORG_SLUG`, `SAMPLE_PASSWORD` | Sample users all get `Password123!` |

None of the six bootstrap/seed variables is documented in `docs/DEMO_DATA.md` either; the CLI
flags are the only discoverable route to them.

Conversely, `.env.example` lists `SIS_PROVIDER`, which nothing reads (§1.5). The root
`.env.example` covers only the compose variables, not the API's.

### 1.7 Reaching the app from another device on the LAN

The Vite dev server used to bind loopback only, so the application worked on `localhost` and
was silently unreachable from a phone or laptop on the same Wi-Fi — the connection was simply
refused, with no error anywhere. `apps/web/vite.config.ts` now sets `server.host: true`,
binding `0.0.0.0`; `http://localhost:5173` keeps working exactly as before and
`http://<LAN-IP>:5173` additionally serves. It is deliberately `true` rather than a
hard-coded address, so a changed DHCP lease needs no code change, and HMR needs no extra
configuration because the client derives its websocket URL from the page's own host.
`start-dev.ps1` detects the current non-loopback, non-APIPA IPv4 address and prints the LAN
URL alongside the localhost one.

Three things must agree before another device works end to end:

| Setting | What to set it to |
| --- | --- |
| `CORS_ORIGIN` | The URL the **browser** actually uses, e.g. `http://192.168.1.20:5173`. In development an unset value reflects the request origin, so this matters mainly in production, or when a LAN device calls the API **directly** on :3000 — the normal path goes through the Vite dev proxy, where the browser sees a single origin and performs no CORS check at all. |
| `PUBLIC_APP_URL` | The same base URL. It is what goes into outgoing email, password-reset links and parent evaluation QR codes; left at its default, recipients receive `localhost` links that only work on the server. A tenant's `communication/general.publicBaseUrl` overrides it. |
| The API host | The API must be reachable at the same host name the browser used. The Vite proxy targets stay `localhost` on purpose — they are resolved by the Vite process on the dev machine, not by the visiting browser, which only ever requests a relative `/api/v1` path. |

> **Windows note.** `deploy.ps1` and `start-dev.ps1` are unsigned, so PowerShell may refuse
> them with *"…is not digitally signed."* Run
> `powershell -ExecutionPolicy Bypass -File .\deploy.ps1`, or `Unblock-File .\deploy.ps1`
> first. That is Windows' execution policy, not a fault in the script.

---

## 2. Database configuration rows

Table `configurations`, keyed `(organization_id, module, key)` with a **partial unique index**
(`WHERE deleted_at IS NULL`). Postgres will not accept `ON CONFLICT` against a partial index,
so **every writer in the codebase does a manual find-then-update-or-create instead of
`prisma.upsert()`**. If you add a writer, follow that pattern — a plain upsert fails at
runtime with error 42P10.

The `value` column is JSON of an arbitrary shape: some keys store an object, some a bare
number, some a bare boolean, some a string.

**Ten modules are referenced by code** — nine of them written by the application, plus
`competency`, which is read but never written (§2.10). Everything else is reachable only because the generic
store accepts any `(module, key)` pair a caller invents.

### 2.1 `reports` — feedback rules and thresholds

| Key | Shape | Default | Written by | Read by |
| --- | --- | --- | --- | --- |
| `target_score` | bare number | `4` | `PUT /reports/feedback-rules` | `ReportsService.targetScore`, `InsightsService` |
| `min_responses_to_show` | bare number | `3` | `PUT /reports/feedback-rules` | `ReportsService.minResponses`, `InsightsService` |
| `aggregate_visibility` | string, `all_report_viewers` or `executives_only` | `all_report_viewers` | `PUT /reports/feedback-rules` | `ReportsService.assertAggregateVisible` |
| `gap_moderate` | bare number | `0.5` | `PUT /reports/feedback-rules`, clamped to 0.05–3 | `ReportsService.comparisonRules` |
| `gap_pronounced` | bare number | `1.0` | `PUT /reports/feedback-rules`, clamped to 0.1–4 | `ReportsService.comparisonRules` |
| `consensus_sd_low` | bare number | `0.3` | `PUT /reports/feedback-rules`, clamped to 0.01–2 | `ReportsService.comparisonRules` |
| `consensus_sd_high` | bare number | `0.75` | `PUT /reports/feedback-rules`, clamped to 0.05–3 | `ReportsService.comparisonRules` |
| `comparison_min_quadrants` | bare integer | `2` | `PUT /reports/feedback-rules`, clamped to 2–6 | `ReportsService.comparisonRules` (floored at 2 on read as well) |

The first three are the numbers that define a 360 programme. `min_responses_to_show` is the
anonymity threshold — the minimum distinct reviewers before a rater-source breakdown is
shown. The `self` source is exempt, since it is the employee's own rating. Holders of
`reports.confidential.view` see suppressed values anyway.

`aggregate_visibility` set to `executives_only` restricts department and campus scorecards,
trends and heatmaps to holders of `reports.executive`. The default deliberately preserves
pre-existing behaviour so no one's dashboards change on upgrade.

The last five are the **comparison thresholds** used by the individual report's
shared-competency analysis (`ReportsService.sharedCompetencies`). They decide when a
difference between two evaluator groups is worth reporting, and how tightly a group has to
agree before its feedback is called consistent. Any value that is missing, non-numeric or
negative falls back to its default, so a partially configured tenant still behaves sensibly.

| Key | On screen ("Feedback Rules") | Drives |
| --- | --- | --- |
| `gap_moderate` | Difference worth noting | **Blind spot** / **Hidden strength**: self differs from the mean of the other groups by at least this much |
| `gap_pronounced` | Difference worth acting on | The *(pronounced)* variants, and **Perspectives differ sharply** when highest − lowest reaches it |
| `consensus_sd_low` | Reviewers agree below this spread | **Groups agree**, or **Consistent strength** when every group is also at or above `target_score` |
| `consensus_sd_high` | Reviewers disagree above this spread | **Divergent perception** |
| `comparison_min_quadrants` | Groups needed to compare | Minimum non-self groups with a visible score before any verdict is drawn; below it, scores are shown with no comparison |

**UI:** Settings → Feedback Rules — all eight keys.

### 2.2 `dashboards` — dashboard layouts

| Key | Shape | Default | Written by | Read by |
| --- | --- | --- | --- | --- |
| `executive` | `{ widgets: [{ key, span, config? }], theme? }` | absent → code default | `PUT /reports/dashboard-layout/executive` | `DashboardLayoutService.get` |
| `hr` | same | absent → code default | `PUT /reports/dashboard-layout/hr` | `DashboardLayoutService.get` |

Only these two keys are accepted; anything else is a 400. A **missing row means "use the code
default"**, which is why Reset is implemented as `deleteMany` — one of the few **hard
deletes** against `configurations` in the whole codebase.

The server sanitises defensively and is the security boundary: `span` must be one of
3/4/6/8/12 (else 6), themes and per-widget `tone`, `icon`, `chartType`, `sort` are
allow-listed, `color` must match `#rrggbb`, `topN` is clamped to 1–100, widget keys are capped
at 64 characters and de-duplicated, and a layout is capped at 50 widgets. Everything stored
here is **presentation-only** — it can never widen data access, because the widgets read the
same already-scoped report bundles regardless.

**UI:** Reports → dashboard customiser, gated on `reports.dashboard.configure`.

### 2.3 `appraisal` — cycle templates

| Key | Shape | Default | Written by | Read by |
| --- | --- | --- | --- | --- |
| `cycle_templates` | `{ templates: CycleTemplate[] }` | `{ templates: [] }` | `POST`/`DELETE /appraisal/cycle-templates` | `GET /appraisal/cycle-templates`, `POST /appraisal/cycle-templates/:id/apply` |

**One row holds the entire template collection** as a JSON array, rather than one row per
template. Adding or deleting a template rewrites the whole array.

**UI:** Appraisal → cycle templates.

### 2.4 `reminders` — reminder scheduler

Unlike every other module here, `reminders` stores **one row per setting**, each holding a
bare scalar.

| Key | Shape | Default | Written by | Read by |
| --- | --- | --- | --- | --- |
| `enabled` | bare boolean | `true` | `PUT /appraisal/reminder-settings` | `ReminderService.reminderSettings` |
| `cadence_days` | bare number, clamped 1–14 | `3` | `PUT /appraisal/reminder-settings` | same |
| `send_hour` | bare number, clamped 0–23 | `8` | `PUT /appraisal/reminder-settings` | same |

`HrSyncService` and `SisSyncService` use the *presence* of a settings row per org to decide
which tenants their crons should visit; `ReminderService` instead reads all `reminders` rows
for the org in one query.

**UI:** Settings → Reminders.

### 2.5 `communication` — branding, channels, templates

| Key | Shape | Default | Written by | Read by |
| --- | --- | --- | --- | --- |
| `email` | `EmailConfig` — host, port, secure, auth, user, pass, senderName, from, connectionTimeout | absent → channel unconfigured | `POST /communication/settings/providers` | `ProviderFactory`, `isChannelEnabled` |
| `sms` | `SmsConfig` — provider, senderId, Twilio credentials, or full generic-gateway spec plus retry policy | absent → unconfigured | same | same |
| `whatsapp` | `WhatsAppConfig` — provider `meta`/`twilio`/`waha`/`mock`, baseUrl, credentials, session, webhookUrl, webhookSecret | absent → unconfigured | same | same |
| `general` | `{ publicBaseUrl, webhookSecret? }` | `publicBaseUrl` falls back to `PUBLIC_APP_URL` | `POST /communication/settings/defaults` | link building, inbound webhook verification |
| `branding` | `{ organizationName, logoUrl, primaryColor, supportEmail, footer }` | org name, `#2563eb`, empty strings | `POST /communication/settings/branding`, and `db:demo` | `TemplateService.branding` |
| `defaults` | `{ channels: Channel[] }` | `['email','whatsapp']` | `POST /communication/settings/defaults` | notification fan-out |
| `template:{event}:{channel}` | `{ subject, body, isActive }` | absent → built-in default | `POST /communication/templates`, removed by `POST /communication/templates/reset` | `TemplateService.resolve` and `list` |

Template keys expand to **6 events × 3 channels = 18 possible override rows** per tenant:
events `cycle_started`, `feedback_reminder`, `final_reminder`, `feedback_submitted`,
`cycle_closed`, `admin_message`; channels `email`, `sms`, `whatsapp`. A missing row means the
built-in default is used, which is why "Reset to default" is a soft delete of the override
rather than a write. `TemplateService.list` fetches all overrides in **one** query with a
`startsWith: 'template:'` filter.

Secrets in `email.pass`, `sms.*`, `whatsapp.*` and `general.webhookSecret` are **never**
returned to the client — the settings snapshot exposes only `hasWebhookSecret`,
`hasAccessToken`, `hasAuthToken` style booleans, and a write that omits a secret preserves the
stored one.

**UI:** Communication → Settings, Templates, Branding tabs.

### 2.6 `auth` — security policies

| Key | Shape | Default | Written by | Read by |
| --- | --- | --- | --- | --- |
| `password_policy` | `{ minLength, requireUpper, requireLower, requireNumber, requireSymbol, historyCount }` | `8, true, true, true, false, 5` | `PUT /auth/security-policy/password` | `PasswordService` on every set or change |
| `lockout` | `{ maxAttempts, windowMinutes }` | `{ 5, 15 }` | `PUT /auth/security-policy/lockout` | login attempt tracking |
| `mfa_policy` | `{ mode: 'optional' \| 'required_admins' \| 'required_all' }` | `optional` | `PUT /auth/mfa/policy` | `TokenService.computeMustEnrollMfa` at token issue |
| `sso` | `{ providers: SsoProvider[] }` — id, type `oidc`/`oauth2`, clientId, clientSecret, authorizationUrl, tokenUrl, userInfoUrl, scopes, redirectUri, emailClaim | `null` → SSO unavailable | **nothing** — `POST /configuration` only | `AuthSettingsService.ssoProvider` |
| `ldap` | `{ enabled, url, bindDn, bindPassword, searchBase, searchFilter, emailAttribute }` | `null` → LDAP unavailable | **nothing** — `POST /configuration` only | `AuthSettingsService.ldap` |
| `captcha` | `{ enabled, provider: 'recaptcha' \| 'hcaptcha', secret }` | `null` → disabled | **nothing** — `POST /configuration` only | `AuthSettingsService.captcha` |

Writes are clamped so a policy cannot lock everyone out: `minLength` 6–64, `historyCount`
0–24, `maxAttempts` 3–20 (floor of 3 so a single typo cannot lock a user out),
`windowMinutes` 1–1440.

`mfa_policy` is enforced through a **token claim**, so raising it to `required_all` affects a
signed-in user only at their next token issue or refresh.

**UI:** `/security` covers `password_policy`, `lockout` and `mfa_policy`.
**`sso`, `ldap` and `captcha` have no screen anywhere** — configuring SSO or LDAP requires a
raw `POST /configuration` call or direct SQL. The reader code is complete; only the writer is
missing. See `05-module-architecture.md`, which marks `auth` as *Partial — SSO and LDAP
API-only*.

### 2.7 `hr_integration`

| Key | Shape | Default | Written by | Read by |
| --- | --- | --- | --- | --- |
| `settings` | `{ mode: 'internal' \| 'external_hr', provider, autoSync, intervalHours, mockScenario, lastSyncAt }` | `internal`, `mock`, `false`, `24`, `full`, `null` | `PUT /hr-integration/config`, and after each sync | `HrConfigService`, the sync cron, and **`OrgWritableGuard`** |
| `connection` | `{ [providerKey]: { …fields } }`, secret fields AES-256-GCM encrypted | `{}` | `PUT /hr-integration/connection` | `HrConnectionService.get`, provider code only |

`settings.mode` is the highest-leverage row in the whole table: `external_hr` makes
**employees, departments, designations and campuses read-only across the entire application**.
`OrgWritableGuard` reads this row directly — bypassing the HR module to avoid coupling — and
refuses every mutating verb on `organization` and `org-import` with an explanatory 403.

`connection` stores one sub-object per provider key, so switching providers does not discard
the previous provider's credentials. The redacted read path blanks every secret and returns a
`secretSet` map instead.

**UI:** `/hr-integration`.

### 2.8 `sis_integration`

| Key | Shape | Default | Written by | Read by |
| --- | --- | --- | --- | --- |
| `settings` | `{ provider, autoSync, intervalHours, mockScenario, lastSyncAt }` | `internal`, `false`, `24`, `full`, `null` | `PUT /sis-integration/config`, and after each sync/import | `SisConfigService`, sync cron |
| `connection` | `{ [providerKey]: { …fields } }`, secret fields encrypted | `{}` | `PUT /sis-integration/connection` | `SisConnectionService.get` |

`settings.provider` is one of `internal`, `mock`, `csv`, `generic`, `oneroster`. Only
`generic` and `oneroster` have connection fields; `internal` and `csv` are populated by the
upload wizard, which carries the file and mapping at upload time.

**UI:** `/student-integration`.

### 2.9 `ai` — provider configuration

| Key | Shape | Default | Written by | Read by |
| --- | --- | --- | --- | --- |
| `provider` | `{ enabled, baseUrl, apiKey, model }` | absent → heuristic engine only | **nothing** — `POST /configuration` only | `AiProviderService.getConfig` |

Any OpenAI-compatible `/chat/completions` endpoint works — OpenAI, Azure, OpenRouter, a local
Ollama or LM-Studio gateway. `model` defaults to `gpt-4o-mini` when blank. The config is
treated as absent unless `enabled` is not `false` **and** both `baseUrl` and `apiKey` are
non-empty; when absent, or when a live call fails or exceeds its 20-second timeout, the AI
module falls back to the deterministic heuristic engine and remains fully functional.

**No UI.** Enabling a live AI provider currently requires a raw `POST /configuration` call.
Listed as a known gap in `01-system-architecture.md`.

### 2.10 `competency` — the default proficiency scale (**read by code, written by nothing**)

| Key | Shape | Default | Written by | Read by |
| --- | --- | --- | --- | --- |
| `default_proficiency_scale` | array of `{ level: number, name: string, description?: string \| null }` (a JSON string is also parsed) | absent → **empty list** | **nothing anywhere in the application** | `ProficiencyScaleService.resolveDefault`, called by `CompetencyService.create` |

> ⚠️ **Known gap, recorded as such.** `CompetencyService.create` seeds a new competency's v1
> draft with the proficiency levels this key describes. `ProficiencyScaleService.resolveDefault`
> (`apps/api/src/competency/services/proficiency-scale.service.ts:31-46`) reads it with a raw
> query and returns `[]` when the row is absent, malformed, or the query fails. **No code path
> in the application ever writes it** — `grep -rn default_proficiency_scale apps/api/src`
> returns two hits, both reads in that one file. The practical consequence: **a competency
> created through the UI is created with zero proficiency levels.** Seeded competencies have
> five only because `provisioning/starter-content.ts` inserts them directly.
>
> There is no settings screen for it and no CRUD API for `proficiency_levels` either, so the
> only ways to populate it today are the generic `POST /configuration` store or direct SQL.
> Do not describe a UI for this — there is none.

### 2.11 Summary — every module/key pair in use

| Module | Keys | Count | Has a UI screen |
| --- | --- | --- | --- |
| `reports` | `target_score`, `min_responses_to_show`, `aggregate_visibility`, `gap_moderate`, `gap_pronounced`, `consensus_sd_low`, `consensus_sd_high`, `comparison_min_quadrants` | 8 | Yes |
| `dashboards` | `executive`, `hr` | 2 | Yes |
| `appraisal` | `cycle_templates` | 1 | Yes |
| `reminders` | `enabled`, `cadence_days`, `send_hour` | 3 | Yes |
| `communication` | `email`, `sms`, `whatsapp`, `general`, `branding`, `defaults`, `template:{event}:{channel}` | 6 + up to 18 | Yes |
| `auth` | `password_policy`, `lockout`, `mfa_policy`, `sso`, `ldap`, `captcha` | 6 | 3 of 6 |
| `hr_integration` | `settings`, `connection` | 2 | Yes |
| `sis_integration` | `settings`, `connection` | 2 | Yes |
| `ai` | `provider` | 1 | **No** |
| `competency` | `default_proficiency_scale` | 1 | **No — and nothing writes it** |
| | **Total distinct keys** | **32 fixed + up to 18 template keys** | |

**Ten modules are actually referenced by code.** `competency` is the odd one: it is *read*
but never *written*, so unless an operator has inserted the row by hand it does not exist in
any tenant.

**Reachable only by raw API or direct SQL:** `auth/sso`, `auth/ldap`, `auth/captcha`,
`ai/provider`, `competency/default_proficiency_scale`. Five settings, all of them
consequential — the two enterprise sign-in methods, bot protection on login, the live AI
provider, and whether a newly created competency has any proficiency levels at all.

The generic store itself is API-only: `GET`, `POST` and `DELETE /configuration` exist and
accept any `(module, key)` pair with `module` ≤ 60 and `key` ≤ 120 characters and a JSON value
of any shape, but **no screen in `apps/web` renders it**. That is simultaneously the escape
hatch for the four settings above and the reason they were easy to leave without a UI.

> **Correction to `01-system-architecture.md` §9.** That document lists the `configurations`
> modules as `ai, appraisal, auth, communication, competency, configuration, development,
> external_evaluation, hr_integration, identity, integration, organization, questionnaire,
> reminders, reports, sis, sis_integration, system, workflow`. That is the **`module` column
> of the `permissions` table**, not of `configurations`. The nine modules enumerated above are
> the ones any code actually reads or writes, and `dashboards` — absent from that list — is
> one of them.

---

## 3. Feature flags

Table `feature_flags`, columns `(organization_id, key, is_enabled, description)`, managed
under `configuration/feature-flags` and gated on
`configuration.feature_flag.read` / `configuration.feature_flag.manage`.

`FeatureFlagService.isEnabled(orgId, key, defaultEnabled)` returns the stored value when a row
exists and the supplied default otherwise, so **a flag that has never been created keeps the
default** and existing organisations are unaffected by a new flag being introduced.

### 3.1 The one flag that is enforced

| Key | Default | Enforced where | Effect when off |
| --- | --- | --- | --- |
| `ai_insights` | `true` | `AiEnabledGuard` on the `ai` controller, **and** `FeatureRoute` + the nav filter in `apps/web` | Every AI endpoint answers **404**; the `/ai` route and the menu item disappear |

The 404 is deliberate. A disabled module should look like a route that does not exist rather
than a 403, which would confirm the feature is present but withheld.

This flag is declared in exactly two places that must stay in step:
`apps/api/src/ai/ai-enabled.guard.ts` (`AI_INSIGHTS_FLAG`, default `true`) and
`apps/web/src/features/config/useFeatureFlags.ts` (`RECOGNISED_FLAGS`, default `true`). The
Settings screen renders its documentation from the frontend list.

`RECOGNISED_FLAGS` contains **one** entry. Any other flag an administrator creates is stored,
listed and toggleable — and read by nothing.

### 3.2 Duplicate and dead rows in the seed

`apps/api/scripts/sample-data.ts` seeds two flags, and **neither of them is the enforced key**:

| Seeded key | `is_enabled` | Status |
| --- | --- | --- |
| `ai.insights` | `false` | **Duplicate and dead.** Dot-separated, whereas the guard checks the underscore form `ai_insights`. Nothing reads it. Because it is the wrong key, seeding it `false` does *not* disable AI Insights — the real flag is absent, so the `true` default applies and AI Insights stays on. |
| `appraisal.calibration` | `true` | **Dead.** No code path anywhere in `apps/api` or `apps/web` reads this key. Calibration is gated by the `appraisal.calibrate` permission, not by a flag. |

The practical consequence for anyone using the sample data: the Settings → Feature Flags
screen shows two switches whose descriptions imply they control something, plus a documented
`ai_insights` switch that has no stored row. Toggling the first two changes nothing. Toggling
`ai_insights` creates the row and does work.

**UI:** Settings → Feature Flags. It renders both the `RECOGNISED_FLAGS` documentation and
free-form create/edit/delete of arbitrary keys, so a stored-but-unread flag is
indistinguishable from a working one.

---

## 4. Where to look — quick index

| I want to change… | Layer | Where |
| --- | --- | --- |
| Port, database, Redis, log level | 1 | `apps/api/.env` |
| Token lifetimes, upload ceiling, partner rate limit | 1 | `apps/api/.env` |
| Ability to create more tenants | 1 | `PLATFORM_PROVISIONING_KEY` |
| Anonymity threshold, target score, aggregate visibility | 2 | Settings → Feedback Rules |
| Comparison thresholds (worth noting / worth acting on, agreement spread, groups needed to compare) | 2 | Settings → Feedback Rules |
| Reminder cadence and send hour | 2 | Settings → Reminders |
| Executive or HR dashboard layout | 2 | Reports → customiser |
| Email, SMS or WhatsApp provider, branding, message templates | 2 | Communication → Settings |
| Password, lockout or MFA policy | 2 | `/security` |
| SSO, LDAP or CAPTCHA | 2 | **Raw `POST /configuration` — no screen** |
| HR data source and credentials | 2 | `/hr-integration` |
| Student data source and credentials | 2 | `/student-integration` |
| Live AI provider | 2 | **Raw `POST /configuration` — no screen** |
| Default proficiency scale for new competencies | 2 | **Raw `POST /configuration` — no screen, and nothing else writes it (§2.10)** |
| Show or hide AI Insights | 3 | Settings → Feature Flags |
| Reaching the app from a phone or another laptop | 1 | `CORS_ORIGIN` + `PUBLIC_APP_URL` — see §1.7 |

---

*Verified against the repository on 2026-08-21: 28 environment variables read by `apps/api`
(22 runtime + 6 bootstrap/seed), 3 by `apps/mock-sis`, 2 by `apps/web`; 2 declared but unread; 10
`configurations` modules holding 32 fixed keys plus up to 18 per-tenant template keys — one of
those modules (`competency`) is read but never written; 1 enforced feature flag and 2 dead
seeded ones.*
