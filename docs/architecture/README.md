# Architecture documentation — Enterprise 360° Feedback System

Technical design documentation for developers and architects. Written from the code as it
stands on **2026-08-21**, not from earlier design intent. Where the code and the older
planning documents disagree, these documents follow the code and say so.

All 48 diagrams are Mermaid and parse against Mermaid 10.

## What is here

| # | Document | What it is for | Read it when |
|---|---|---|---|
| 01 | [System Architecture](01-system-architecture.md) | Frontend, backend, database approach, auth, module map, integrations, request flows. 3 diagrams. | First day. Orientation. |
| 02 | [Database ERD](02-database-erd.md) | High-level ERD per domain plus a master diagram. 12 `erDiagram` blocks, conventions, the soft-delete list. | Understanding the data model. |
| 03 | [Table Reference](03-table-reference.md) | All 62 tables: purpose, PK, columns, FKs, real indexes/constraints, data classification. | Writing a query or a migration. |
| 04 | [Business Workflows](04-business-workflows.md) | 19 workflows as Trigger → Steps → Rules → Data → Output, with entry points. 25 diagrams including 3 state diagrams and 4 sequence diagrams. | Tracing how a feature actually runs. |
| 05 | [Module Architecture](05-module-architecture.md) | Per module: purpose, screens, controllers/services, tables, APIs, dependencies, status. | Deciding where a change belongs. |
| 06 | [API & Integration Map](06-api-integration-map.md) | API groups, auth surfaces, envelope, versioning, HR/SIS/comms provider models, webhooks. 2 diagrams. | Integrating with or extending the API. |
| 07 | [Key Business Rules](07-business-rules.md) | **The most important document.** 78 rules with location, pseudocode and "what breaks if you change it". 4 decision diagrams. | Before changing scoring, anonymity, access or cycles. |
| 08 | [Codebase Navigation](08-codebase-navigation.md) | "Where is what", entry points, seed chain, and a 68-row *if you want to change X, look here* table. | Every day, until you know the tree. |
| 09 | [Security & Data Visibility Model](09-security-model.md) | Roles, scopes, guard chain, auth surfaces, secret handling, role capability matrix, known weaknesses. 1 diagram. | Touching anything permission-related. |
| 10 | [ADR Summary](10-adr-summary.md) | 22 architecture decision records: context, decision, consequences, status. | Asking "why is it built this way?" |
| 11 | [Configuration Reference](11-configuration-reference.md) | Env vars, `configurations` module/key catalogue, feature flags; which have a UI and which do not. | Changing behaviour without changing code. |

## Reading order for a new developer

1. **01 System Architecture** — the shape of the system.
2. **08 Codebase Navigation** — so you can find things while reading everything else.
3. **02 Database ERD** — the domain model. Skip 03 until you need a column.
4. **04 Business Workflows** — read the cycle lifecycle, feedback submission and scoring sections; the rest on demand.
5. **07 Business Rules** — read completely before your first change to scoring, anonymity, visibility or cycle state.
6. **05 Module Architecture** — as a lookup when you know which feature you are touching.
7. **09, 06, 11, 10** — when the task calls for them.

Then run the system. `docs/DEMO_DATA.md` has the seed chain; sign in to the demo tenant as
`sajidq@carepvtltd.com` on organisation `care` and click through Appraisals → My Reviews,
Reports → Individual and the Executive Dashboard drill-down. Thirty minutes in the running
app is worth more than another hour of reading.

## Related documentation, not duplicated here

- **User, Administrator and Deployment manuals**, the **Dashboard & KPI Guide** and the
  **Integration & API Guide** — generated HTML, delivered separately, built from
  `/root/e360/docs/content/*.html`. They are written for administrators and end users; these
  architecture documents are for developers.
- `docs/DEMO_DATA.md` — the demo dataset and its sign-in accounts.
- `ops/BACKUP_RESTORE.md`, `ops/UPGRADE.md`, `ops/README-docker.md` — operational runbooks.
- `README.md`, `DEPLOYMENT.md`, `WINDOWS_DEPLOY.md` — install and run.

## Change log for these documents

**2026-08-21 — per-quadrant questionnaires, shared-competency analysis, employee placement,
competency activation, LAN access.** All eleven documents brought back in line with the code.

- **Per-quadrant questionnaires.** `feedback_sources.template_id` (nullable) lets one quadrant
  carry its own questionnaire; NULL keeps the previous inherit-from-cycle behaviour, and a
  regression test asserts a pre-existing cycle is unaffected. The relationship
  quadrant → questionnaire → questions → competencies replaces the earlier claim in **04 §5**
  and **07 §7** that a cycle has exactly one questionnaire shared by every quadrant and that no
  quadrant→competency relationship exists. A competency is *shared*, and therefore comparable,
  when two or more quadrant questionnaires reference it — derived at read time, never a stored
  flag. **04 §5** rewritten around the fallback rule, the coverage matrix and a worked example;
  **07** gained **BR-6.5** (the fallback rule, quoting `resolveTemplateId`), **BR-7.5**
  (derived-not-stored comparability), and a rewritten **BR-7.2**; **02**, **03**, **05**, **06**
  and **08** updated for the column, the endpoints and the new surfaces; **10** gained
  **ADR-022** recording the "derive comparability, never store it" decision.
- **New endpoints, all additive:** `PUT /appraisal/cycles/:id/sources/:sourceId/template`,
  `GET /appraisal/cycles/:id/coverage`, `GET /reports/shared-competencies/:employeeId`.
  `GET /appraisal/cycles/:id/sources` gained `templateId` / `templateName` /
  `effectiveTemplateId` / `effectiveTemplateName` / `inheritsCycleTemplate`;
  `GET /reports/radar/:employeeId` gained `assessedBy` / `withheldSources` / `minResponses` /
  `confidentialUnlocked`. Nothing was removed or renamed — **06 §2.1**.
- **Four cell states.** A blank competency × quadrant cell is now one of *scored*, *withheld*,
  *no replies* or *not assessed*, and *withheld* ≠ *not assessed* — **07 BR-10.7** with a new
  decision diagram, **04 §11** and **§13**.
- **`reports.confidential.view`.** Held by Super Admin, HR/Admin and Manager (never Employee or
  Viewer); interacts with, but does not widen, data scope; audited as
  `results.viewed { confidential: true }`; and explicitly does **not** reveal reviewer
  identity — **07 BR-10.4** repaired, **09 §8** expanded.
- **My Reviews names the appraisee.** `is_anonymous` governs the *evaluator's* attribution only
  — **04 §7**.
- **Employee placement and Edit.** Add employee now collects designation, department, campus,
  reporting line and join date; a per-row Edit dialog changes placement and status; the
  reporting-loop rejection is now reachable from the UI — **04 §1**, **§2**, **05**, **07
  BR-2.2**.
- **Competency version activation from the UI.** Activate / New version / draft-pending badge,
  gated on `competency.version.manage` — **04 §4**, **05**, **07 BR-7.3**. Recorded honestly
  alongside it: the default proficiency scale is read from
  `competency/default_proficiency_scale`, which **nothing writes**, so a UI-created competency
  has zero proficiency levels — **07 BR-7.6**, **11 §2.10**, **05**, **08**.
- **Comparison thresholds and LAN access** — **11 §1.7** (`CORS_ORIGIN` / `PUBLIC_APP_URL`,
  `server.host: true`, the unsigned-PowerShell note) and **11 §2.1** (the five threshold keys).

## Conventions used in these documents

- **Implemented** — working and reachable from the UI. **Partial** — works but incomplete or
  unenforced. **API-only** — implemented server-side with no user interface. **Planned** —
  does not exist; named only where its absence is surprising.
- Code references are `path/file.ts:line` or `path/file.ts:function`. Line numbers drift;
  the function name is the durable anchor.
- Findings that look like defects are recorded where they are relevant, marked as such, and
  collected in the "rules most likely to be broken by accident" table in document 07. They
  are observations, not change requests — nothing in the application was modified to produce
  this documentation.
