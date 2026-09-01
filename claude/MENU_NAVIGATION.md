# Application Menu & Navigation Reference

*Authoritative map of the left sidebar in the Enterprise 360 web app. Updated after the menu reorganization (flat menu, natural-workflow order).*

The sidebar is a **single flat list** — no groups, parent menus, or submenus. Items are ordered to follow the natural 360° workflow rather than alphabetically: you start at the dashboard, build the foundation, run the evaluations, follow up, communicate, analyse, and finally administer & configure.

Source of truth in code: `apps/web/src/app/AppShell.tsx` (the `NAV` array). Routes are declared in `apps/web/src/App.tsx`. Visibility is controlled entirely by RBAC — each item declares an optional `perm`; a user sees the item only if their assigned role grants that permission (`nav = NAV.filter(item => !item.perm || has(item.perm))`). Order is identical for every role; lower-privilege roles simply see a subset.

## Menu order

| # | Label | Route | Required permission | Purpose |
|---|-------|-------|---------------------|---------|
| 1 | Dashboard | `/` | *(none — always visible)* | Executive/HR landing page: KPIs, cycle progress, and analytics at a glance. |
| 2 | Organization | `/organization` | `organization.read` | People, departments, campuses, designations — the structural foundation. Four tabs: Employees, Departments, Designations, Campuses. |
| 2b | Org Chart | `/org-chart` | `organization.read` | Interactive chart of the organisation — Units and People views, search, expand/collapse, full screen. Formerly a fifth tab on Organization; now its own screen. |
| 3 | Competencies | `/competency` | `competency.read` | The competency framework (categories, competencies, indicators, versions) that everything is measured against. |
| 4 | Questionnaires | `/questionnaire` | `questionnaire.read` | Questionnaire templates, questions, and rubrics used to collect feedback. |
| 5 | Appraisals | `/appraisal` | `appraisal.read` | Feedback cycles: create, configure, add participants, assign reviewers, calibrate, release. |
| 6 | Bulk Generation | `/bulk-generation` | `appraisal.cycle.manage` | Bulk-create a feedback cycle + reviewer/parent assignments across the org, an institute/campus, or a department. |
| 7 | Parent Evaluations | `/sis-evaluations` | `external.evaluation.manage` | External/parent (SIS-sourced) evaluations and secure-link management. |
| 8 | Development | `/development` | `development.read` | Development actions and plans that follow from feedback results. |
| 9 | Workflows | `/workflow` | `workflow.read` | Approval workflows and the actions awaiting sign-off. |
| 10 | Communication | `/communication` | `communication.read` | Email/SMS/WhatsApp campaigns and notifications to participants and evaluators. |
| 11 | Reports | `/reports` | `reports.read` | Analytical reports — individual, radar, gap, and roll-ups. |
| 12 | AI Insights | `/ai` | `ai.read` | AI-generated summaries and insights over feedback data. |
| 13 | Integration | `/integration` | `integration.read` | SIS/external system integration configuration and identity mapping. |
| 14 | Access Control | `/access-control` | `security.rbac.manage` | RBAC administration: assign roles to users, view the role/permission matrix. |
| 15 | Audit Trail | `/audit-trail` | `feedback.audit.read` | Append-only 360 Feedback Audit Trail: search/filter/export every feedback lifecycle activity (Super Admin only). |
| 16 | Security | `/security` | `auth.security.admin` | Security administration (MFA, sessions, security policy). |
| 17 | Data Import | `/data-import` | `organization.import.manage` | Organization Data Import & Onboarding: bulk-load campuses, departments, designations, employees + reporting lines from CSV/Excel (Super Admin, HR/Admin). |
| 18 | HR Integration | `/hr-integration` | `organization.hr.manage` | Choose the org data source (Internal / External HR) and run/monitor HR synchronization (Super Admin, HR/Admin). |
| 19 | Settings | `/settings` | `configuration.read` | System configuration: rating scales, feature flags, and other settings. |

## What each predefined role sees

Because visibility is permission-driven, the list a user actually sees depends on their role. The order is always the one above; only the subset differs.

- **Super Admin** — all 19 items.
- **HR/Admin** — 16 items: Dashboard, Organization, Org Chart, Competencies, Questionnaires, Appraisals, Bulk Generation, Parent Evaluations, Development, Workflows, Communication, Reports, AI Insights, Data Import, HR Integration, Settings. (Not Integration, Access Control, Audit Trail, or Security.)
- **Manager** — 9 items: Dashboard, Organization, Org Chart, Competencies, Questionnaires, Appraisals, Development, Workflows, Reports.
- **Employee** — 6 items: Dashboard, Organization, Org Chart, Appraisals, Development, Reports.
- **Viewer** — 13 items: Dashboard, Organization, Org Chart, Competencies, Questionnaires, Appraisals, Development, Workflows, Communication, Reports, AI Insights, Integration, Settings. (Read-only; not Bulk Generation, Parent Evaluations, Access Control, Audit Trail, Security, or Data Import.)

## Notes

- **Audit Trail** is the dedicated 360 Feedback Audit Trail (`feedback.audit.read`, Super Admin only). It is append-only — records cannot be edited or deleted, enforced by a database trigger. The generic per-entity audit that backs other modules still exists in the `audit_logs` table; the Audit Trail screen surfaces the feedback-specific `feedback_audit_events` stream.
- **Dashboard** (item 1) hosts the Executive and HR dashboards, which are **configurable and customizable**: admins with `reports.dashboard.configure` (Super Admin + HR/Admin) use a **Customize** button to add/remove/reorder/resize the existing widgets and to tune each one (per-widget settings gear: title, colour/icon, conditional thresholds, chart-type switch, legend/data labels, sort + Top-N, empty-state), pick a dashboard colour theme, and export/import the layout as JSON. All of it is presentation-only over the existing widgets/data/drilldowns. Layouts (with per-widget config + theme) are per-organization, stored in the `configurations` table (`module='dashboards'`, `key='executive'|'hr'`); there is no separate menu item.
- Adding a new menu item means: add an entry to `NAV` in `AppShell.tsx` (with its `perm`), add the matching `<Route>` in `App.tsx`, and grant the permission to the appropriate roles in `system-roles.ts`. Keep this table in sync.
