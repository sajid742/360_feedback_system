# 03 — Table Reference

Column-level reference for all **62 tables** in the Enterprise 360 database, grouped by
domain. Use this when you are writing a query, adding a column, or trying to work out
which table owns a fact.

For the shape of the model rather than its columns, start at
[02-database-erd.md](./02-database-erd.md). For runtime layering see
[01-system-architecture.md](./01-system-architecture.md); for the processes that write
these tables see [04-business-workflows.md](./04-business-workflows.md) and
[07-business-rules.md](./07-business-rules.md).

**Verified against** a live `enterprise360` Postgres 16 database via `information_schema`,
`pg_indexes`, `pg_constraint` and `information_schema.triggers`, cross-checked against
`apps/api/prisma/schema.prisma` (61 models), `database/000_initial_schema.sql` and
`database/001_reconcile.sql`. Only constraints and indexes that actually exist are listed.

---

## How to read this document

**Primary keys.** Every table is `id UUID PRIMARY KEY DEFAULT gen_random_uuid()` unless the
row says otherwise. The two exceptions are `permissions` (PK `code VARCHAR(100)`) and
`schema_migrations` (PK `version VARCHAR`).

**Implicit columns.** `created_at TIMESTAMPTZ NOT NULL DEFAULT now()` is on almost every
table; `updated_at`, `created_by`, `updated_by` and `deleted_at` are listed only where they
exist. `created_by` / `updated_by` are **always unconstrained UUIDs** — there is no FK to
`users` anywhere in the schema.

**Indexes.** Every listed index was read from `pg_indexes`. Indexes that merely back a PK or
a UNIQUE constraint are not repeated. `ix_*_org` indexes on `organization_id` exist on most
tenant-scoped tables and are noted per table.

**Data classification.**

| Class | Meaning |
|---|---|
| **Configuration** | Tenant setup and policy. Low volume, changed by admins, safe to cache. |
| **Master** | Reference/library data referenced by transactions. Medium volume, versioned or soft-deleted. |
| **Transactional** | Produced by the running business process. High volume, grows with each cycle. |
| **Audit** | Immutable evidence. Never updated by application logic. |
| **Integration** | Written by or for an external system. Snapshot-shaped, replaceable. |

---

## 1. Organization & Employees

### `organizations`

Root organizations **and campuses**. There is no campus table.

| | |
|---|---|
| **Purpose** | Tenant root and its campus children. `org_type='root'` is the tenant; `org_type='campus'` rows hang off it via `parent_org_id`. Every `campus_id` column elsewhere in the schema is an FK to this table. |
| **PK** | `id` |
| **Key columns** | `parent_org_id` self-FK, NULL for a root and set for a campus · `name` · `slug` globally UNIQUE · `org_type` enum `root \| campus` default `root` · `status` VARCHAR(20) default `active` · `deleted_at` |
| **FKs** | `parent_org_id → organizations.id` |
| **Referenced by** | 45 tables via `organization_id`; plus `employees.campus_id` and `departments.campus_id` |
| **Indexes** | `organizations_slug_key` UNIQUE(slug) · `ix_organizations_parent(parent_org_id)` |
| **Class** | Configuration |

> **`campuses` are rows in `organizations`.** Filtering campuses means
> `WHERE org_type='campus' AND parent_org_id = :root`. A query joining `employees.campus_id`
> lands back on `organizations`. Nothing prevents a campus from having its own children —
> the hierarchy is unbounded in the schema even though the product treats it as two levels.

### `departments`

| | |
|---|---|
| **Purpose** | Organisational units, self-nesting, optionally pinned to a campus. |
| **PK** | `id` |
| **Key columns** | `parent_id` self-FK for sub-units · `campus_id` → `organizations.id` · `unit_type` VARCHAR(40) NOT NULL · `deleted_at` |
| **FKs** | `organization_id → organizations.id` · `parent_id → departments.id` · `campus_id → organizations.id` |
| **Indexes** | `ix_departments_org` · `ix_departments_parent` |
| **Class** | Master |

### `designations`

| | |
|---|---|
| **Purpose** | Job titles with a numeric seniority `level` and an optional promotion path. |
| **PK** | `id` |
| **Key columns** | `level` INT NOT NULL — used for peer/manager grouping in bulk generation · `promotion_to_id` self-FK · `deleted_at` |
| **FKs** | `organization_id → organizations.id` · `promotion_to_id → designations.id` |
| **Indexes** | `ix_designations_org` |
| **Class** | Master |

### `employees`

| | |
|---|---|
| **Purpose** | The evaluatee/evaluator identity. One row per person in the org chart. |
| **PK** | `id` |
| **Key columns** | `user_id` **NOT NULL and UNIQUE** — every employee has a login · `employee_code` unique per org among non-deleted rows · `department_id` · `designation_id` · `campus_id` → `organizations.id` · `line_manager_id` self-FK · `join_date` · `status` VARCHAR(20) default `active` · `deleted_at` |
| **FKs** | `organization_id`, `campus_id` → `organizations.id` · `user_id → users.id` · `department_id → departments.id` · `designation_id → designations.id` · `line_manager_id → employees.id` |
| **Constraints** | `employees_user_id_key` UNIQUE(user_id) · `uq_employees_org_code` UNIQUE(organization_id, employee_code) **WHERE deleted_at IS NULL** |
| **Indexes** | `ix_employees_org` · `ix_employees_department` · `ix_employees_designation` · `ix_employees_line_manager` |
| **Class** | Master |

### `employee_matrix_managers`

| | |
|---|---|
| **Purpose** | Dotted-line reporting. `employees.line_manager_id` is the solid line; this is the many-to-many overlay. |
| **PK** | `id` |
| **Key columns** | `employee_id`, `manager_id` — both FKs to `employees`, both `ON DELETE CASCADE`. No `organization_id`, no `created_at`. |
| **Constraints** | `uq_employee_matrix` UNIQUE(employee_id, manager_id) |
| **Indexes** | `ix_employee_matrix_manager(manager_id)` |
| **Class** | Master |

### `organization_import_jobs`

| | |
|---|---|
| **Purpose** | One row per CSV/Excel org-structure upload attempt: parsed dataset, validation result and summary. Supports validate-then-commit onboarding. |
| **PK** | `id` |
| **Key columns** | `filename` · `status` default `validated` · `mode` · `dataset` JSONB (the whole parsed file) · `validation` JSONB · `summary` JSONB · `created_by_name` denormalised · `imported_at` NULL until committed |
| **FKs** | **none** — `organization_id` and `created_by` are unconstrained UUIDs |
| **Indexes** | `ix_org_import_jobs_org_created(organization_id, created_at)` |
| **Class** | Integration |

---

## 2. Authentication & RBAC

### `users`

| | |
|---|---|
| **Purpose** | Login identity. Paired 1:1 with `employees` for staff; admin-only users may exist without an employee row. |
| **PK** | `id` |
| **Key columns** | `email` · `password_hash` NULLable — SSO/LDAP users have none · `full_name` · `status` default `active` · `must_change_password` BOOLEAN · `deleted_at` |
| **FKs** | `organization_id → organizations.id` |
| **Constraints** | `uq_users_org_email` UNIQUE(organization_id, **lower(email)**) **WHERE deleted_at IS NULL** |
| **Indexes** | `ix_users_org` |
| **Class** | Master |

### `roles`

| | |
|---|---|
| **Purpose** | Named permission bundles, per tenant. |
| **PK** | `id` |
| **Key columns** | `name` · `is_system` BOOLEAN — seeded roles, not user-editable · `scope` VARCHAR NOT NULL — role reach, e.g. org vs campus · `deleted_at` |
| **FKs** | `organization_id → organizations.id` |
| **Constraints** | `uq_roles_org_name` UNIQUE(organization_id, **lower(name)**) **WHERE deleted_at IS NULL** |
| **Indexes** | `ix_roles_org` |
| **Class** | Configuration |

### `permissions`

| | |
|---|---|
| **Purpose** | Global catalogue of permission codes. Seeded from the `*.permissions.ts` files in each API module. |
| **PK** | **`code VARCHAR(100)`** — the only VarChar-keyed business table. No `id`, no `organization_id`, no timestamps. |
| **Key columns** | `module` VARCHAR(60) NOT NULL — groups codes in the role editor · `description` TEXT NOT NULL |
| **FKs** | none |
| **Referenced by** | `role_permissions.permission_code` (VarChar FK, `ON DELETE CASCADE`) |
| **Indexes** | `ix_permissions_module` |
| **Class** | Configuration |

### `role_permissions`

| | |
|---|---|
| **Purpose** | Role → permission grants. |
| **PK** | `id` |
| **FKs** | `role_id → roles.id` CASCADE · `permission_code → permissions.code` CASCADE |
| **Constraints** | `uq_role_permission` UNIQUE(role_id, permission_code) |
| **Indexes** | `ix_role_permissions_code(permission_code)` |
| **Class** | Configuration |

### `user_roles`

| | |
|---|---|
| **Purpose** | User → role assignment. No scope column: the scope lives on `roles.scope`. |
| **PK** | `id` |
| **FKs** | `user_id → users.id` CASCADE · `role_id → roles.id` CASCADE |
| **Constraints** | `uq_user_role` UNIQUE(user_id, role_id) |
| **Indexes** | `ix_user_roles_role(role_id)` |
| **Class** | Configuration |

### `refresh_tokens`

| | |
|---|---|
| **Purpose** | Rotating refresh-token store; one row per issued token. |
| **PK** | `id` |
| **Key columns** | `token_hash` globally UNIQUE — raw token never stored · `replaced_token_id` UUID, unconstrained, forms the rotation chain · `expires_at` · `revoked_at` · `ip` · `user_agent` · `device_hash` |
| **FKs** | `user_id → users.id` CASCADE · `organization_id → organizations.id` |
| **Indexes** | `ix_refresh_tokens_user` · `ix_refresh_tokens_org` |
| **Class** | Transactional |

### `password_history`

| | |
|---|---|
| **Purpose** | Previous password hashes, to enforce the no-reuse window in the password policy. |
| **PK** | `id` · **FKs** `user_id → users.id` CASCADE · **Indexes** `ix_password_history_user` |
| **Class** | Audit |

### `password_reset_tokens`

| | |
|---|---|
| **Purpose** | Single-use password-reset tokens. Added by `001_reconcile.sql`. |
| **PK** | `id` |
| **Key columns** | `token_hash` UNIQUE · `expires_at` · `used_at` |
| **FKs** | `user_id → users.id` CASCADE · `organization_id → organizations.id` |
| **Indexes** | `idx_password_reset_tokens_user` |
| **Class** | Transactional |

### `login_attempts`

| | |
|---|---|
| **Purpose** | Every login attempt, success or failure. Drives lockout. |
| **PK** | `id` |
| **Key columns** | **`email` VARCHAR, not `user_id`** — failures against non-existent accounts are still recorded · `success` BOOLEAN · `reason` · `ip` |
| **FKs** | `organization_id → organizations.id` |
| **Indexes** | `ix_login_attempts_lookup(organization_id, email, created_at)` |
| **Class** | Audit |

### `mfa_secrets`

| | |
|---|---|
| **Purpose** | TOTP enrolment, one per user. |
| **PK** | `id` · **Constraints** `mfa_secrets_user_id_key` UNIQUE(user_id) |
| **Key columns** | `encrypted_secret` TEXT · `enabled` BOOLEAN — a row can exist mid-enrolment with `enabled=false` |
| **FKs** | `user_id → users.id` CASCADE |
| **Class** | Configuration |

### `mfa_backup_codes`

| | |
|---|---|
| **Purpose** | One-time recovery codes for a `mfa_secrets` row. |
| **PK** | `id` · **Key columns** `code_hash` · `used_at` NULL until burned |
| **FKs** | `mfa_secret_id → mfa_secrets.id` CASCADE · **Indexes** `ix_mfa_backup_codes_secret` |
| **Class** | Transactional |

### `trusted_devices`

| | |
|---|---|
| **Purpose** | "Remember this device" — skips MFA challenge. |
| **PK** | `id` · **Key columns** `device_hash` · `label` · `last_seen_at` |
| **FKs** | `user_id → users.id` CASCADE · **Constraints** `uq_trusted_device` UNIQUE(user_id, device_hash) |
| **Class** | Configuration |

### `otp_codes`

| | |
|---|---|
| **Purpose** | Out-of-band one-time codes, used for email/SMS/WhatsApp verification. Not tied to a user. |
| **PK** | `id` |
| **Key columns** | `identifier` VARCHAR — the email or phone number · `channel` enum `email\|sms\|whatsapp` · `code_hash` · `purpose` · `attempts` INT · `expires_at` · `consumed_at` |
| **FKs** | `organization_id → organizations.id` |
| **Indexes** | `ix_otp_codes_lookup(organization_id, identifier, purpose)` |
| **Class** | Transactional |

### `api_keys`

| | |
|---|---|
| **Purpose** | Machine-to-machine credentials for the public API. |
| **PK** | `id` |
| **Key columns** | `prefix` — the visible portion shown in the UI · `key_hash` TEXT globally UNIQUE · `scopes` TEXT[] · `last_used_at` · `expires_at` · `revoked_at` |
| **FKs** | `organization_id → organizations.id` · **Indexes** `ix_api_keys_org` |
| **Class** | Configuration |

---

## 3. Feedback Cycles

### `appraisal_cycles`

| | |
|---|---|
| **Purpose** | One 360 review round. Binds a questionnaire template and a rating scale to a date window. |
| **PK** | `id` |
| **Key columns** | `name` · `start_date`, `end_date` DATE NOT NULL · `submission_deadline` DATE nullable · `status` · `template_id` · `rating_scale_id` · `deleted_at` |
| **FKs** | `organization_id → organizations.id` · `template_id → questionnaire_templates.id` · `rating_scale_id → rating_scales.id` |
| **Constraints** | `appraisal_cycles_status_check` CHECK `status IN ('draft','active','closed','archived')` |
| **Indexes** | `ix_appraisal_cycles_org` |
| **Class** | Transactional |

### `appraisal_participants`

| | |
|---|---|
| **Purpose** | An employee enrolled in a cycle. **This is also the score-carrying row** — there is no separate scores table. |
| **PK** | `id` |
| **Key columns** | `status` · `computed_score` NUMERIC — machine roll-up of weighted responses · `final_score` NUMERIC — the calibrated/human number, what reports show · `potential_rating` NUMERIC — the 9-box Y axis · `calibrated_at` · `visibility` VARCHAR NOT NULL · `released_at` / `released_by` — gate on employee visibility |
| **FKs** | `cycle_id → appraisal_cycles.id` **CASCADE** · `employee_id → employees.id` |
| **Constraints** | `uq_appraisal_participant` UNIQUE(cycle_id, employee_id) |
| **Indexes** | `ix_appraisal_participants_cycle` · `ix_appraisal_participants_employee` |
| **Class** | Transactional |

> Deleting a cycle cascades to participants, which cascades to reviewer assignments, which
> cascades to responses. A cycle delete destroys the whole feedback tree — the only
> surviving evidence is `feedback_audit_events`, which is why it holds no foreign keys.

### `feedback_sources`

**The "quadrants".** Per-cycle rows, not a global lookup.

| | |
|---|---|
| **Purpose** | Defines the evaluator categories available in one cycle — Self, Line Manager, Peer, Subordinate, Parents. Each carries the weight and anonymity rule for that category, and optionally its own questionnaire. |
| **PK** | `id` |
| **Key columns** | `code` VARCHAR(40) — free text, `UNIQUE` per cycle only; the code base uses `self`, `manager`, `peer`, `subordinate`, `parent` (`bulk-generation.service.ts:39`) · `label` · `weight` NUMERIC(6,2) default 1 — the source's share of the roll-up · `required_count` INT default 1 · `is_anonymous` BOOLEAN — drives whether reports may name the reviewer · `is_active` BOOLEAN · **`template_id` UUID NULLABLE** — this quadrant's own questionnaire; NULL means "inherit the cycle's" |
| **FKs** | `cycle_id → appraisal_cycles.id` **CASCADE** · `template_id → questionnaire_templates.id` (nullable, NO ACTION). No `organization_id` — tenancy inherited from the cycle. |
| **Constraints** | `uq_feedback_source_code` UNIQUE(cycle_id, code) |
| **Indexes** | `ix_feedback_sources_cycle` · `ix_feedback_sources_template` |
| **Class** | Configuration (per-cycle) |

> **`template_id` is the per-quadrant questionnaire, and NULL is the default.** Added by
> `database/001_reconcile.sql:1543-1544` (migration `2026.08.20-01`) and declared at
> `apps/api/prisma/schema.prisma:996`. NULL means the quadrant serves the cycle
> questionnaire (`appraisal_cycles.template_id`) — exactly how every cycle behaved before
> the column existed, so every pre-existing row is NULL and nothing changed for it.
> Resolution is `source?.templateId ?? cycle?.templateId ?? null`
> (`apps/api/src/appraisal/questionnaire-resolution.ts:resolveTemplateId`), and the same
> function decides which questions a reviewer sees, which answers `assertValidResponses`
> accepts, and what the competency-coverage matrix reports — so those three can never
> disagree. Written only by `SetupService.setSourceTemplate` (`appraisal.cycle.manage`),
> which refuses a template from another tenant or one with zero questions and writes a
> `source.questionnaire.changed` entry to the feedback trail. There is still **no**
> `question_id` or `competency_id` on this table: a quadrant reaches competencies only
> through its questionnaire's questions.

> **`required_count` is stored but never enforced anywhere in the code.** It is written by
> `setup.service.ts`, `cycle-template.service.ts`, `bulk-generation.service.ts`,
> `evaluation-link.service.ts` and the seed scripts. It is read in exactly one place:
> `apps/api/src/reports/services/reports.service.ts:649` selects
> `max(fs.required_count) AS required` and returns it as a **display field** on the reviewer
> coverage widget. No DTO validator, guard, submission check, nomination rule or
> close-cycle rule ever compares it against the actual number of assignments. Treat it as a
> UI hint, not a constraint.

### `bulk_generation_runs`

| | |
|---|---|
| **Purpose** | Audit/summary of one bulk evaluator-assignment generation run. |
| **PK** | `id` |
| **Key columns** | `cycle_id` + denormalised `cycle_name` · `initiated_by` + `initiated_by_name` · `scope_type` / `scope_id` / `scope_name` — what the run targeted · `status` default `completed` · `config`, `summary`, `skipped`, `failed` JSONB · counters `assignments_created`, `skipped_count`, `failed_count`, `messages_queued` · `completed_at` |
| **FKs** | **none** — `organization_id`, `cycle_id`, `initiated_by`, `scope_id` are all unconstrained UUIDs, and there is no link to the assignments the run produced |
| **Indexes** | `ix_bulk_runs_org_created(organization_id, created_at)` |
| **Class** | Audit |

---

## 4. Competencies, Rubrics & Questionnaires

### `competency_categories`

| | |
|---|---|
| **Purpose** | Top-level grouping of competencies. |
| **PK** | `id` · **Key columns** `name` · `description` · `color_tone` — UI swatch · `is_active` · `deleted_at` |
| **FKs** | `organization_id → organizations.id` |
| **Constraints** | `uq_competency_categories_org_name` UNIQUE(organization_id, **lower(name)**) **WHERE deleted_at IS NULL** — *not declared in `schema.prisma`* |
| **Indexes** | `ix_competency_categories_org` · **Class** Master |

### `competencies`

| | |
|---|---|
| **Purpose** | A named capability. The container; the *content* lives in versions. |
| **PK** | `id` · **Key columns** `category_id` NOT NULL · `name` · `is_archived` BOOLEAN — distinct from `deleted_at` · `deleted_at` |
| **FKs** | `organization_id → organizations.id` · `category_id → competency_categories.id` |
| **Constraints** | `uq_competencies_org_name` UNIQUE(organization_id, **lower(name)**) **WHERE deleted_at IS NULL** |
| **Indexes** | `ix_competencies_org` · `ix_competencies_category` · **Class** Master |

### `competency_versions`

| | |
|---|---|
| **Purpose** | A draft/active/retired revision of a competency's definition. Proficiency levels and behaviour indicators hang off the *version*, not the competency. |
| **PK** | `id` · **Key columns** `version_label` · `status` enum `draft \| active \| retired` · `deleted_at` |
| **FKs** | `competency_id → competencies.id` **CASCADE** · `organization_id → organizations.id` |
| **Constraints** | `uq_competency_versions_comp_label` UNIQUE(competency_id, version_label) WHERE `deleted_at IS NULL` · **`uq_competency_versions_one_active` UNIQUE(competency_id) WHERE `status='active' AND deleted_at IS NULL`** — at most one active version per competency, enforced by Postgres only, absent from `schema.prisma` |
| **Indexes** | `ix_competency_versions_competency` · `ix_competency_versions_org` · **Class** Master |

### `proficiency_levels`

| | |
|---|---|
| **Purpose** | The ordered level ladder for one competency version — Novice, Practitioner, Expert, … |
| **PK** | `id` · **Key columns** `level` SMALLINT · `name` · `description` |
| **FKs** | `version_id → competency_versions.id` **CASCADE** · `organization_id → organizations.id` |
| **Constraints** | `proficiency_levels_level_check` CHECK `level > 0` · `uq_proficiency_levels_version_level` UNIQUE(version_id, level) |
| **Indexes** | `ix_proficiency_levels_version` · **Class** Master |

### `behaviour_indicators`

| | |
|---|---|
| **Purpose** | Observable behaviour statements anchoring a competency version, optionally to a specific proficiency level. |
| **PK** | `id` · **Key columns** `type` enum `positive \| negative` · `text` TEXT · `sort_order` · `deleted_at` |
| **FKs** | `version_id → competency_versions.id` **CASCADE** · `proficiency_level_id → proficiency_levels.id` **SET NULL** · `organization_id → organizations.id` |
| **Indexes** | `ix_behaviour_indicators_version` · `ix_behaviour_indicators_level` · `ix_behaviour_indicators_org` · **Class** Master |

### `competency_designation_mappings`

| | |
|---|---|
| **Purpose** | Which competencies a job title is expected to demonstrate, and at what weight. |
| **PK** | `id` · **Key columns** `weight` NUMERIC · `is_mandatory` BOOLEAN · `deleted_at` |
| **FKs** | `competency_id → competencies.id` CASCADE · `designation_id → designations.id` CASCADE · `organization_id → organizations.id` |
| **Constraints** | `competency_designation_mappings_weight_check` CHECK `weight BETWEEN 0 AND 100` · `uq_comp_desig_mapping` UNIQUE(competency_id, designation_id) **WHERE deleted_at IS NULL** |
| **Indexes** | `ix_comp_desig_mapping_designation` · `ix_comp_desig_mapping_org` · **Class** Master |

### `rating_scales`

| | |
|---|---|
| **Purpose** | A named scoring scale, referenced by cycles, questions and rubrics. |
| **PK** | `id` · **Key columns** `scale_type` · `min_value`, `max_value` NUMERIC · `status` · `deleted_at` |
| **FKs** | `organization_id → organizations.id` · **Indexes** `ix_rating_scales_org` · **Class** Configuration |

### `rating_scale_levels`

| | |
|---|---|
| **Purpose** | The discrete points on a scale, with display metadata. |
| **PK** | `id` · **Key columns** `value` NUMERIC · `label` · `color` · `icon` · `sort_order` |
| **FKs** | `rating_scale_id → rating_scales.id` **CASCADE**. No `organization_id`. |
| **Constraints** | `uq_rating_scale_value` UNIQUE(rating_scale_id, value) |
| **Indexes** | `ix_rating_scale_levels_scale` · **Class** Configuration |

### `questions`

| | |
|---|---|
| **Purpose** | The reusable question bank. A question exists independently of any template. |
| **PK** | `id` |
| **Key columns** | `competency_id` nullable — a question need not map to a competency · `rating_scale_id` nullable — falls back to the cycle's scale · `category` VARCHAR free text · `text` TEXT · `type` enum `rating \| yes_no \| multiple_choice \| text \| numeric` · `is_mandatory` · `weight` NUMERIC · `options` JSONB for multiple choice · `language` · `status` · `deleted_at` |
| **FKs** | `organization_id → organizations.id` · `competency_id → competencies.id` · `rating_scale_id → rating_scales.id` |
| **Indexes** | `ix_questions_org` · `ix_questions_competency` · **Class** Master |

### `questionnaire_templates`

| | |
|---|---|
| **Purpose** | A named, versioned questionnaire. Referenced by `appraisal_cycles.template_id`. |
| **PK** | `id` · **Key columns** `name` · `status` · `version` INT · `deleted_at` |
| **FKs** | `organization_id → organizations.id` · **Indexes** `ix_questionnaire_templates_org` · **Class** Master |

### `template_sections`

| | |
|---|---|
| **Purpose** | Ordered sections within a template. |
| **PK** | `id` · **Key columns** `title` · `description` · `sort_order` |
| **FKs** | `template_id → questionnaire_templates.id` **CASCADE**. No `organization_id`. |
| **Indexes** | `ix_template_sections_template` · **Class** Master |

### `section_questions`

| | |
|---|---|
| **Purpose** | Places a bank question into a section, with per-placement overrides. This is where a question actually becomes part of a questionnaire. |
| **PK** | `id` |
| **Key columns** | `sort_order` · `weight_override` NUMERIC — beats `questions.weight` · `is_mandatory_override` BOOLEAN · `condition` JSONB — conditional display rule |
| **FKs** | `section_id → template_sections.id` **CASCADE** · `question_id → questions.id` |
| **Constraints** | `uq_section_question` UNIQUE(section_id, question_id) — a question cannot appear twice in one section |
| **Indexes** | `ix_section_questions_question` · **Class** Master |

### `rubrics`

| | |
|---|---|
| **Purpose** | Descriptor text per scale point for a competency — the "what a 4 looks like" guidance shown to reviewers. |
| **PK** | `id` · **Key columns** `title` · `descriptors` JSONB NOT NULL · `deleted_at` |
| **FKs** | `organization_id → organizations.id` · `competency_id → competencies.id` · `rating_scale_id → rating_scales.id` |
| **Indexes** | `ix_rubrics_org` · **Class** Master |

---

## 5. Evaluator Assignments

### `reviewer_assignments`

The hinge table. **The only link between a response and a reviewer identity.**

| | |
|---|---|
| **Purpose** | "Person X will review participant Y in quadrant Z." Everything about who gives feedback lives here. |
| **PK** | `id` |
| **Key columns** | `cycle_id` · `participant_id` · `source_id` — the quadrant · **`reviewer_employee_id`** UUID **nullable** · **`reviewer_type`** VARCHAR(20) default `'internal'`, set to `'external'` for parents/outsiders · **`external_ref`** VARCHAR(64) nullable · **`external_name`** VARCHAR(200) nullable · `status` default `pending`, moves to `submitted` · `nomination_status` default `approved` — self/manager nomination workflow · `submitted_at` · `last_reminded_at` |
| **FKs** | `cycle_id → appraisal_cycles.id` CASCADE · `participant_id → appraisal_participants.id` CASCADE · `source_id → feedback_sources.id` · `reviewer_employee_id → employees.id` · `organization_id → organizations.id` |
| **Constraints** | `uq_reviewer_assignment` UNIQUE(participant_id, source_id, reviewer_employee_id) |
| **Indexes** | `ix_reviewer_assignments_cycle(cycle_id, status)` · `ix_reviewer_assignments_reviewer(reviewer_employee_id, status)` · `ix_reviewer_assignments_org` |
| **Class** | Transactional |

> **A row carries *either* `reviewer_employee_id` *or* `external_ref`/`external_name`, never
> both.** Internal reviewers are employees; external reviewers (parents, students, outside
> stakeholders) have no employee record and are identified only by the external columns.
>
> **`feedback_responses` has no reviewer column at all** — it points only at
> `assignment_id`. To answer "who said this?" you must join through
> `reviewer_assignments`, and there is no other path. That is also what makes anonymity
> enforceable: reports simply never project the reviewer columns for sources where
> `feedback_sources.is_anonymous = true`. The join still exists in the database — anonymity
> is an application-layer promise, not a schema guarantee.
>
> **The uniqueness constraint does not cover external reviewers.** Because
> `reviewer_employee_id` is NULL for them and Postgres treats NULLs as distinct, the same
> parent can be assigned to the same participant and quadrant repeatedly. `external_ref`
> participates in no constraint or index.

---

## 6. Feedback Responses & Scores

### `feedback_responses`

| | |
|---|---|
| **Purpose** | One reviewer's answer to one question. The atomic unit of feedback. |
| **PK** | `id` |
| **Key columns** | `rating_value` NUMERIC nullable · `text_value` TEXT nullable — which one is meaningful is decided by `questions.type`; nothing in the schema enforces the pairing · `created_at`. **No `updated_at`, no reviewer column, no `organization_id`.** |
| **FKs** | `assignment_id → reviewer_assignments.id` **CASCADE** · `question_id → questions.id` |
| **Constraints** | `uq_feedback_response` UNIQUE(assignment_id, question_id) — one answer per reviewer per question; re-submission updates in place |
| **Indexes** | `ix_feedback_responses_assignment` |
| **Class** | Transactional |

### `development_actions`

| | |
|---|---|
| **Purpose** | Post-cycle development/IDP items for an employee. |
| **PK** | `id` |
| **Key columns** | **`competency` VARCHAR — a free-text label, NOT a foreign key** to `competencies` · `title` · `description` · `status` · `priority` · `due_date` |
| **FKs** | `employee_id → employees.id` · `organization_id → organizations.id` |
| **Indexes** | `ix_development_actions_employee` · `ix_development_actions_org` |
| **Class** | Transactional |

---

## 7. Parent/External Feedback

### `evaluation_links`

| | |
|---|---|
| **Purpose** | A tokenised public URL that lets a parent evaluate a teacher without logging in. Carries both the SIS context and the resolved 360 binding. |
| **PK** | `id` |
| **SIS context** | `student_id` NOT NULL, `student_name`, `parent_id`, `parent_name`, `teacher_id` NOT NULL, `teacher_name`, `subject_id`, `subject_name`, `teaching_assignment_id`, `class_name`, `section_name`, `session_name` — **all VARCHAR external identifiers**, not UUIDs |
| **360 binding** | `employee_id`, `cycle_id`, `reviewer_assignment_id`, `template_id` — UUIDs resolved via `external_identity_maps` |
| **Token & state** | `token_hash` VARCHAR(128) **globally UNIQUE** — raw token never stored · `status` default `pending` · `one_time` BOOLEAN default true · `expires_at` · `send_channel`, `sent_at`, `opened_at`, `completed_at` |
| **Payload** | `responses` JSONB · `overall_score` NUMERIC · `comment` TEXT — the link stores its own copy of the answers in addition to writing through to `feedback_responses` |
| **FKs** | **`organization_id → organizations.id` only.** `employee_id`, `cycle_id`, `reviewer_assignment_id` and `template_id` have **no FK constraints** in Prisma or SQL. |
| **Indexes** | `evaluation_links_token_hash_key` UNIQUE · `ix_evaluation_links_org_status` · `ix_evaluation_links_org_student` |
| **Class** | Transactional / Integration |

> On completion the service creates or reuses a `feedback_sources` row with
> `code='parent'`, `is_anonymous=true` and a `reviewer_assignments` row with
> `reviewer_type='external'`, so parent feedback flows into the normal scoring path.

### `short_links`

| | |
|---|---|
| **Purpose** | URL shortener for SMS/WhatsApp sends, with a click counter. |
| **PK** | `id` · **Key columns** `code` **globally UNIQUE** · `target_url` TEXT · `clicks` INT |
| **FKs** | `organization_id → organizations.id` · **Indexes** `ix_short_links_org` · **Class** Transactional |

---

## 8. HR & SIS Integration

### `external_identity_maps`

| | |
|---|---|
| **Purpose** | Bridges an external system's identifier to an internal `employees.id`. This is how an SIS teacher id becomes an evaluatee. |
| **PK** | `id` |
| **Key columns** | `external_type` — which system/entity · `external_id` · `external_code` · `match_key` NOT NULL — the value the matcher used (email, code, …) · `active` BOOLEAN |
| **FKs** | `employee_id → employees.id` NOT NULL · `organization_id → organizations.id` |
| **Constraints** | `uq_external_identity` UNIQUE(organization_id, external_type, external_id) |
| **Indexes** | `ix_external_identity_org_type` · `ix_external_identity_employee` |
| **Class** | Integration |

### `sis_datasets`

| | |
|---|---|
| **Purpose** | The **current** SIS snapshot for a tenant — students, parents, teachers, classes, teaching assignments — held whole as JSONB. |
| **PK** | `id` · **Constraints** `sis_datasets_organization_id_key` UNIQUE(organization_id) — exactly one snapshot per tenant, overwritten on each sync. No history. |
| **Key columns** | `provider` · `snapshot` JSONB NOT NULL · `student_count`, `teacher_count` INT |
| **FKs** | **none** — `organization_id` is unconstrained |
| **Class** | Integration |

### `sis_sync_runs`

| | |
|---|---|
| **Purpose** | History of SIS synchronisation runs, dry-run or live. Counters only — the data itself is in `sis_datasets`. |
| **PK** | `id` |
| **Key columns** | `provider` · `mode` · `trigger` default `manual` · `status` · `created_by` + `created_by_name` · counters `created`, `updated`, `deactivated`, `failed`, `warnings` · `summary` JSONB · `started_at`, `finished_at` |
| **FKs** | **none** · **Indexes** `ix_sis_sync_runs_org_started(organization_id, started_at)` |
| **Class** | Audit / Integration |

### `hr_sync_runs`

| | |
|---|---|
| **Purpose** | Identical shape to `sis_sync_runs`, for the HRIS employee feed. |
| **PK** | `id` · **Key columns** same set as `sis_sync_runs` |
| **FKs** | **none** · **Indexes** `ix_hr_sync_runs_org_started(organization_id, started_at)` |
| **Class** | Audit / Integration |

> Provider credentials and field mappings for both integrations are **not** in these
> tables. They live in `configurations` under `hr_integration/settings`,
> `hr_integration/connection`, `sis_integration/settings` and `sis_integration/connection`.
> The scheduled sync discovers which tenants to process by querying
> `configurations WHERE module='hr_integration' AND key='settings'`
> (`hr-sync.service.ts:354`) — a configuration row, not a tenant flag, is what enables the job.

---

## 9. Communication

### `communication_campaigns`

| | |
|---|---|
| **Purpose** | A bulk send: one channel, one template, an audience selector. |
| **PK** | `id` · **Key columns** `channel` enum `email\|sms\|whatsapp` · `template_key` · `subject` · `body` TEXT NOT NULL · `audience` JSONB NOT NULL · `status` |
| **FKs** | `organization_id → organizations.id` · **Indexes** `ix_comm_campaigns_org` · **Class** Transactional |

### `notifications`

| | |
|---|---|
| **Purpose** | **Outbound delivery log** — one row per message actually dispatched to a provider. |
| **PK** | `id` |
| **Key columns** | `campaign_id` nullable — transactional sends have none · `channel` enum · `recipient` VARCHAR — an address, **not a user_id** · `subject`, `body` · `template_key` · `status` · `provider`, `provider_message_id` — for delivery-receipt reconciliation · `error` TEXT · `sent_at` |
| **FKs** | `organization_id → organizations.id` · `campaign_id → communication_campaigns.id` |
| **Indexes** | `ix_notifications_org_status` · `ix_notifications_campaign` · `ix_notifications_provider_msg(provider_message_id)` |
| **Class** | Transactional / Audit |

### `user_notifications`

| | |
|---|---|
| **Purpose** | **In-app bell items.** Unrelated to `notifications` despite the name. |
| **PK** | `id` · **Key columns** `type` · `title` · `body` · `link` — deep link into the SPA · `read_at` NULL until read |
| **FKs** | `user_id → users.id` CASCADE · `organization_id → organizations.id` |
| **Indexes** | `ix_user_notifications_user` · `ix_user_notifications_org` · **Class** Transactional |

---

## 10. Dashboard & Configuration

### `configurations`

The generic key/value store. Far more of the product depends on this table than its name suggests.

| | |
|---|---|
| **Purpose** | Per-tenant JSON settings keyed by `(module, key)`. Roughly a dozen features keep their entire state here rather than in a dedicated table. |
| **PK** | `id` |
| **Key columns** | `module` VARCHAR(60) · `key` VARCHAR(120) · `value` JSONB NOT NULL · `deleted_at` |
| **FKs** | `organization_id → organizations.id` |
| **Constraints** | `uq_configuration_scope` UNIQUE(organization_id, module, key) **WHERE deleted_at IS NULL** — a **partial** index |
| **Indexes** | `ix_configurations_org_module(organization_id, module)` |
| **API** | `GET/POST/DELETE` via `config.controller.ts`, plus a dozen feature-specific services that read and write their own keys directly. |
| **Class** | Configuration |

> **Do not call `prisma.configuration.upsert()`.** The unique index is partial, and Postgres
> rejects `ON CONFLICT` against a partial index with error **42P10**. Every service that
> writes here does a manual find-then-update/create; see the comment at
> `apps/api/src/config/services/configuration.service.ts:28-35`.

#### `configurations` module / key catalogue

Module/key pairs actually read or written by the code base:

| Module | Key | Value shape | Written by |
|---|---|---|---|
| `appraisal` | `cycle_templates` | array of cycle blueprints incl. source definitions | `appraisal/services/cycle-template.service.ts` |
| `reminders` | `enabled` | boolean | `appraisal/services/reminder.service.ts` |
| `reminders` | `cadence_days` | number | `appraisal/services/reminder.service.ts` |
| `reminders` | `send_hour` | number | `appraisal/services/reminder.service.ts` |
| `reports` | `target_score` | number | `reports/services/reports.service.ts`, `ai/services/insights.service.ts` |
| `reports` | `min_responses_to_show` | number — anonymity threshold | `reports/services/reports.service.ts`, `ai/services/insights.service.ts` |
| `reports` | `aggregate_visibility` | object | `reports/services/reports.service.ts` |
| `dashboards` | `executive` | `{widgets:[{key,span,config}]}` layout | `reports/services/dashboard-layout.service.ts` |
| `dashboards` | `hr` | same layout shape | `reports/services/dashboard-layout.service.ts` |
| `auth` | `password_policy` | policy object | `auth/auth.settings.ts` |
| `auth` | `lockout` | lockout thresholds | `auth/auth.settings.ts` |
| `auth` | `mfa_policy` | `{mode}` | `auth/auth.settings.ts` |
| `auth` | `captcha` | provider config, nullable | `auth/auth.settings.ts` |
| `auth` | `ldap` | connection config, nullable | `auth/auth.settings.ts` |
| `auth` | `sso` | `{providers:[…]}`, nullable | `auth/auth.settings.ts` |
| `communication` | `branding` | org name, logo, colours, footer | `communication/services/template.service.ts` |
| `communication` | `defaults` | default channel list | `communication/services/template.service.ts` |
| `communication` | `general` | `{publicBaseUrl, webhookSecret}` | `communication/communication.settings.ts` |
| `communication` | `email` | SMTP host/port/user/from | `communication/communication.settings.ts` |
| `communication` | `sms` | SMS provider config | `communication/communication.settings.ts` |
| `communication` | `whatsapp` | WhatsApp provider config | `communication/communication.settings.ts` |
| `communication` | `template:{event}:{channel}` | per-event message override | `communication/services/template.service.ts` |
| `hr_integration` | `settings` | field mapping + enablement; **also the tenant-discovery key for the scheduled sync** | `hr-integration/hr-config.service.ts` |
| `hr_integration` | `connection` | provider credentials | `hr-integration/hr-connection.service.ts` |
| `sis_integration` | `settings` | mapping + enablement; tenant-discovery key | `sis-integration/sis-config.service.ts` |
| `sis_integration` | `connection` | provider credentials | `sis-integration/sis-connection.service.ts` |
| `ai` | `provider` | AI provider selection + key | `ai/services/ai-provider.service.ts` |

`hr_integration/settings` is additionally read by `common/auth/org-writable.guard.ts` to
decide whether org-structure writes are permitted — a configuration row acting as an
authorisation input.

### `system_settings`

| | |
|---|---|
| **Purpose** | Flat per-tenant JSON settings with **no module dimension**. Overlaps `configurations` by convention only. |
| **PK** | `id` · **Key columns** `key` · `value` JSONB NOT NULL |
| **FKs** | `organization_id → organizations.id` · **Constraints** `uq_system_setting_scope` UNIQUE(organization_id, key) — a **full**, not partial, unique |
| **Indexes** | `ix_system_settings_org` · **Class** Configuration |

### `feature_flags`

| | |
|---|---|
| **Purpose** | Boolean toggles per tenant. |
| **PK** | `id` · **Key columns** `key` · `is_enabled` BOOLEAN · `description` |
| **FKs** | `organization_id → organizations.id` · **Constraints** `uq_feature_flag_scope` UNIQUE(organization_id, key) |
| **Indexes** | `ix_feature_flags_org` · **Class** Configuration |

### `report_schedules`

| | |
|---|---|
| **Purpose** | Recurring report delivery. |
| **PK** | `id` · **Key columns** `report_type` · `frequency` · `recipients` **TEXT[]** · `is_active` · `last_run_at` |
| **FKs** | `organization_id → organizations.id` · `cycle_id → appraisal_cycles.id` **SET NULL** |
| **Indexes** | `ix_report_schedules_org` · **Class** Configuration |

---

## 11. Audit & Operational

### `feedback_audit_events`

The compliance trail for feedback. **Append-only, enforced by a database trigger.**

| | |
|---|---|
| **Purpose** | Immutable record of every consequential feedback action — assignment created, response submitted, score released, link opened, cycle closed. Survives deletion of everything it describes. |
| **PK** | `id` |
| **Actor** | `actor_user_id` nullable — NULL for anonymous parent and system-scheduler events · `actor_name` · `actor_role` — snapshot of role names at event time, or `External` / `System` |
| **Subject** | `cycle_id` + `cycle_name` · `evaluatee_employee_id` + `evaluatee_name` · `evaluator_employee_id` + `evaluator_name` — the name columns cover external reviewers with no employee record · `source_type` — Manager / Peer / Subordinate / Self / Parent |
| **Event** | `action` VARCHAR(80) · `entity_type` NOT NULL · `entity_id` **VARCHAR(64), not UUID** — tokens and links are not all UUIDs · `previous_value` / `new_value` JSONB · `reason` · `ip` · `user_agent` |
| **FKs** | **none, by design.** Every reference is a bare UUID paired with a denormalised name so the trail stays readable after a cycle or employee is deleted. |
| **Indexes** | `ix_feedback_audit_org_created(organization_id, created_at)` · `ix_feedback_audit_org_cycle` · `ix_feedback_audit_org_evaluatee` · `ix_feedback_audit_org_action` |
| **Class** | Audit |

> **Append-only is enforced in the database, not the application.**
> `database/001_reconcile.sql:1404-1412` defines:
>
> ```sql
> CREATE OR REPLACE FUNCTION feedback_audit_events_no_mutate() RETURNS trigger AS $fn$
> BEGIN
>   RAISE EXCEPTION 'feedback_audit_events is append-only; % is not permitted', TG_OP;
> END;
> $fn$ LANGUAGE plpgsql;
>
> CREATE TRIGGER trg_feedback_audit_events_no_mutate
>   BEFORE UPDATE OR DELETE ON feedback_audit_events
>   FOR EACH ROW EXECUTE FUNCTION feedback_audit_events_no_mutate();
> ```
>
> The trigger name is **`trg_feedback_audit_events_no_mutate`**; it is the only trigger in
> the entire schema (confirmed against `information_schema.triggers`, which returns two rows
> for it — one for UPDATE, one for DELETE). Any `UPDATE` or `DELETE`, including a Prisma
> cascade or a well-meaning cleanup script, aborts the whole transaction.

### `audit_logs`

| | |
|---|---|
| **Purpose** | Generic mutation log. `AuditService.record()` writes a row on most mutations in most modules — configuration changes, role changes, cycle changes, competency changes. |
| **PK** | `id` |
| **Key columns** | `user_id` **NOT NULL but with no FK to `users`** · `action` VARCHAR(120) · `entity_type` VARCHAR(80) · `entity_id` UUID — polymorphic, no discriminator constraint · `previous_value` / `new_value` JSONB · `reason` · `ip` · `device` |
| **FKs** | `organization_id → organizations.id` only |
| **Indexes** | `ix_audit_logs_org_entity(organization_id, entity_type)` · `ix_audit_logs_org_user(organization_id, user_id)` |
| **Class** | Audit |

> **`audit_logs` is written on most mutations but has no controller, no API and no UI.**
> The only Prisma access anywhere in the code base is a single
> `this.prisma.auditLog.create(...)` at
> `apps/api/src/common/audit/audit.service.ts:28`. There is no `findMany`, no
> `audit-logs.controller.ts`, no route, and no frontend file references it. Write failures
> are deliberately swallowed so auditing never breaks the primary operation. In practice the
> table is forensics-by-`psql` only — do not point a compliance requirement at it without
> building the read path first. The user-facing audit feature is
> `feedback_audit_events`, which *does* have a controller (`feedback-audit.controller.ts`)
> and a UI.

### `workflow_definitions`

| | |
|---|---|
| **Purpose** | An approval workflow template for a given `entity_type`. |
| **PK** | `id` · **Key columns** `entity_type` · `mode` enum `sequential \| parallel` · `is_active` · `deleted_at` |
| **FKs** | `organization_id → organizations.id` · **Indexes** `ix_workflow_definitions_org(organization_id, entity_type)` · **Class** Configuration |

### `workflow_steps`

| | |
|---|---|
| **Purpose** | Ordered steps of a definition. |
| **PK** | `id` · **Key columns** `step_order` · `assignee_type` · `assignee_value` UUID — a role id or user id depending on `assignee_type`, unconstrained · `sla_hours` · `condition` JSONB |
| **FKs** | `definition_id → workflow_definitions.id` **CASCADE** |
| **Constraints** | `workflow_steps_assignee_type_check` CHECK `assignee_type IN ('role','user')` · `uq_workflow_step_order` UNIQUE(definition_id, step_order) |
| **Indexes** | `ix_workflow_steps_definition` · **Class** Configuration |

### `workflow_instances`

| | |
|---|---|
| **Purpose** | A running approval over one concrete entity. |
| **PK** | `id` · **Key columns** `entity_type` + `entity_id` — polymorphic, unconstrained · `status` enum `pending\|in_progress\|approved\|rejected\|cancelled` · `current_order` INT · `started_by` · `completed_at` |
| **FKs** | `definition_id → workflow_definitions.id` · `organization_id → organizations.id` |
| **Indexes** | `ix_workflow_instances_entity(organization_id, entity_type, entity_id)` · `ix_workflow_instances_definition` · **Class** Transactional |

### `workflow_tasks`

| | |
|---|---|
| **Purpose** | One approver's decision within an instance. |
| **PK** | `id` · **Key columns** `step_order` · `assignee_user_id` NOT NULL, unconstrained · `status` enum `pending\|approved\|rejected\|delegated\|skipped` · `comment` · `delegated_to_user_id` · `decided_at` |
| **FKs** | `instance_id → workflow_instances.id` **CASCADE** · `step_id → workflow_steps.id` |
| **Indexes** | `ix_workflow_tasks_instance` · `ix_workflow_tasks_assignee(assignee_user_id, status)` · **Class** Transactional |

### `webhook_endpoints`

| | |
|---|---|
| **Purpose** | Outbound webhook registrations. |
| **PK** | `id` · **Key columns** `url` TEXT · `events` **TEXT[]** · `secret` TEXT — HMAC signing key · `is_active` · `description` |
| **FKs** | `organization_id → organizations.id` · **Indexes** `ix_webhook_endpoints_org` · **Class** Configuration |

### `webhook_deliveries`

| | |
|---|---|
| **Purpose** | Per-attempt delivery log. |
| **PK** | `id` · **Key columns** `event` · `payload` JSONB · `status` · `status_code` INT · `error` · `attempts` INT |
| **FKs** | `endpoint_id → webhook_endpoints.id` **CASCADE**. No `organization_id`. |
| **Indexes** | `ix_webhook_deliveries_endpoint` · **Class** Audit |

### `schema_migrations`

| | |
|---|---|
| **Purpose** | Applied SQL migration ledger. |
| **PK** | **`version VARCHAR`** · **Key columns** `description` · `applied_at` |
| **Notes** | Created by `001_reconcile.sql`. **The only table in the database with no Prisma model** — 62 tables, 61 models. |
| **Class** | Audit |

---

## Tables you can ignore on day one

These 22 tables exist, work, and are almost never what you are looking for when you start on
this code base. Skip them until a task points you at one.

| Table | Why you can skip it |
|---|---|
| `password_history`, `password_reset_tokens`, `trusted_devices`, `mfa_secrets`, `mfa_backup_codes`, `otp_codes`, `login_attempts` | Auth plumbing. Self-contained inside the auth module; nothing else joins to them. |
| `refresh_tokens` | Session plumbing. Only the token service touches it. |
| `api_keys` | Machine-to-machine auth. Not used by the SPA at all. |
| `webhook_endpoints`, `webhook_deliveries` | Outbound integration. No inbound dependency on the core model. |
| `workflow_definitions`, `workflow_steps`, `workflow_instances`, `workflow_tasks` | Generic approval engine, polymorphic over `entity_type`. Understand the feedback flow first. |
| `bulk_generation_runs`, `hr_sync_runs`, `sis_sync_runs`, `organization_import_jobs` | Run-history/counter tables with **no foreign keys**. Read-only operator screens; nothing depends on them. |
| `short_links` | URL shortener for SMS. One service. |
| `audit_logs` | Written everywhere, **read nowhere**. No API, no UI. |
| `schema_migrations` | Migration ledger. Not in Prisma. |

Conversely, the tables you cannot avoid understanding are: `organizations`, `employees`,
`users`, `appraisal_cycles`, `appraisal_participants`, `feedback_sources`,
`reviewer_assignments`, `feedback_responses`, `questions`/`questionnaire_templates`, and
`configurations`.

---

## Schema and code inconsistencies

Findings surfaced while verifying this reference. The full list with reproduction detail is
in [02-database-erd.md](./02-database-erd.md#schema-inconsistencies-found).

1. `schema_migrations` exists in Postgres but has no Prisma model — 62 tables vs 61 models.
2. Nine partial unique indexes (`... WHERE deleted_at IS NULL`, four over `lower(name)`) are
   declared in `schema.prisma` as ordinary `@@unique` constraints. Prisma believes uniqueness
   is case-sensitive and total; Postgres enforces it case-insensitively over live rows only.
   `prisma.upsert()` against any of them fails with Postgres error **42P10**.
3. `uq_competency_categories_org_name` and `uq_competency_versions_one_active` are absent
   from `schema.prisma` entirely. The "one active version per competency" rule lives only in
   the database.
4. `uq_reviewer_assignment` cannot deduplicate external reviewers, because
   `reviewer_employee_id` is NULL for them and `external_ref` participates in no constraint.
5. `evaluation_links.template_id`, `.employee_id`, `.cycle_id` and `.reviewer_assignment_id`
   are unconstrained UUIDs — no FK in either Prisma or SQL.
6. `bulk_generation_runs`, `hr_sync_runs`, `sis_sync_runs`, `sis_datasets` and
   `organization_import_jobs` carry `organization_id` with **no foreign key**; tenant scoping
   on them is application-enforced only.
7. `audit_logs.user_id` is NOT NULL with no FK to `users`; every `created_by`/`updated_by`
   column in the schema is likewise unconstrained.
8. `feedback_sources.required_count` is written in five places, read once as a display
   value, and enforced nowhere.
9. `000_initial_schema.sql` creates 54 tables; `001_reconcile.sql` creates all 62. Running
   only `000` yields a database the application cannot boot against — `001` is mandatory.
