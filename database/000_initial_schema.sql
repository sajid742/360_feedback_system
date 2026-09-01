-- =====================================================================
-- Enterprise 360 — canonical initial schema (clean build)
-- PostgreSQL 16. UUID PKs, snake_case, soft delete, audit columns,
-- tenant-scoped indexes. Mirrors apps/api/prisma/schema.prisma 1:1.
-- Grows one module per increment. Requires pgcrypto for gen_random_uuid().
-- =====================================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Enum types (mirror the Prisma enums; Prisma casts values to these).
DO $$ BEGIN
  CREATE TYPE org_type AS ENUM ('root','campus');
  CREATE TYPE competency_version_status AS ENUM ('draft','active','retired');
  CREATE TYPE behaviour_indicator_type AS ENUM ('positive','negative');
  CREATE TYPE communication_channel AS ENUM ('email','sms','whatsapp');
  CREATE TYPE question_type AS ENUM ('rating','yes_no','multiple_choice','text','numeric');
  CREATE TYPE workflow_mode AS ENUM ('sequential','parallel');
  CREATE TYPE workflow_status AS ENUM ('pending','in_progress','approved','rejected','cancelled');
  CREATE TYPE workflow_task_status AS ENUM ('pending','approved','rejected','delegated','skipped');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------
-- FOUNDATION
-- ---------------------------------------------------------------------
CREATE TABLE organizations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_org_id  UUID REFERENCES organizations(id),
  name           VARCHAR(200) NOT NULL,
  slug           VARCHAR(120) NOT NULL UNIQUE,
  org_type       org_type NOT NULL DEFAULT 'root',
  status         VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ
);
CREATE INDEX ix_organizations_parent ON organizations(parent_org_id);

CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  email           VARCHAR(255) NOT NULL,
  password_hash   VARCHAR(255),
  full_name       VARCHAR(200),
  status          VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);
CREATE UNIQUE INDEX uq_users_org_email ON users(organization_id, lower(email)) WHERE deleted_at IS NULL;
CREATE INDEX ix_users_org ON users(organization_id);

CREATE TABLE roles (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name            VARCHAR(120) NOT NULL,
  description     TEXT,
  is_system       BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);
CREATE UNIQUE INDEX uq_roles_org_name ON roles(organization_id, lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX ix_roles_org ON roles(organization_id);

CREATE TABLE permissions (
  code        VARCHAR(100) PRIMARY KEY,
  module      VARCHAR(60) NOT NULL,
  description TEXT NOT NULL
);
CREATE INDEX ix_permissions_module ON permissions(module);

CREATE TABLE role_permissions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id         UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_code VARCHAR(100) NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  CONSTRAINT uq_role_permission UNIQUE (role_id, permission_code)
);
CREATE INDEX ix_role_permissions_code ON role_permissions(permission_code);

CREATE TABLE user_roles (
  id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  CONSTRAINT uq_user_role UNIQUE (user_id, role_id)
);
CREATE INDEX ix_user_roles_role ON user_roles(role_id);

CREATE TABLE audit_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  user_id         UUID NOT NULL,
  action          VARCHAR(120) NOT NULL,
  entity_type     VARCHAR(80) NOT NULL,
  entity_id       UUID NOT NULL,
  previous_value  JSONB,
  new_value       JSONB,
  reason          TEXT,
  ip              VARCHAR(60),
  device          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_audit_logs_org_entity ON audit_logs(organization_id, entity_type);
CREATE INDEX ix_audit_logs_org_user ON audit_logs(organization_id, user_id);

-- ---------------------------------------------------------------------
-- CONFIGURATION
-- ---------------------------------------------------------------------
CREATE TABLE configurations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  module          VARCHAR(60) NOT NULL,
  key             VARCHAR(120) NOT NULL,
  value           JSONB NOT NULL,
  created_by      UUID,
  updated_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);
CREATE UNIQUE INDEX uq_configuration_scope ON configurations(organization_id, module, key) WHERE deleted_at IS NULL;
CREATE INDEX ix_configurations_org_module ON configurations(organization_id, module);

CREATE TABLE feature_flags (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  key             VARCHAR(120) NOT NULL,
  is_enabled      BOOLEAN NOT NULL DEFAULT false,
  description     TEXT,
  created_by      UUID,
  updated_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_feature_flag_scope UNIQUE (organization_id, key)
);
CREATE INDEX ix_feature_flags_org ON feature_flags(organization_id);

CREATE TABLE system_settings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  key             VARCHAR(120) NOT NULL,
  value           JSONB NOT NULL,
  created_by      UUID,
  updated_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_system_setting_scope UNIQUE (organization_id, key)
);
CREATE INDEX ix_system_settings_org ON system_settings(organization_id);

CREATE TABLE rating_scales (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name            VARCHAR(120) NOT NULL,
  scale_type      VARCHAR(20) NOT NULL,
  min_value       NUMERIC(6,2) NOT NULL,
  max_value       NUMERIC(6,2) NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'active',
  created_by      UUID,
  updated_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);
CREATE INDEX ix_rating_scales_org ON rating_scales(organization_id);

CREATE TABLE rating_scale_levels (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rating_scale_id UUID NOT NULL REFERENCES rating_scales(id) ON DELETE CASCADE,
  value           NUMERIC(6,2) NOT NULL,
  label           VARCHAR(60) NOT NULL,
  color           VARCHAR(20),
  icon            VARCHAR(50),
  sort_order      INT NOT NULL DEFAULT 0,
  CONSTRAINT uq_rating_scale_value UNIQUE (rating_scale_id, value)
);
CREATE INDEX ix_rating_scale_levels_scale ON rating_scale_levels(rating_scale_id);

-- ---------------------------------------------------------------------
-- ORGANIZATION (tables; module behavior in its increment)
-- ---------------------------------------------------------------------
CREATE TABLE departments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  parent_id       UUID REFERENCES departments(id),
  campus_id       UUID REFERENCES organizations(id),
  name            VARCHAR(200) NOT NULL,
  unit_type       VARCHAR(40) NOT NULL DEFAULT 'department',
  created_by      UUID,
  updated_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);
CREATE INDEX ix_departments_org ON departments(organization_id);
CREATE INDEX ix_departments_parent ON departments(parent_id);

CREATE TABLE designations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id),
  name             VARCHAR(200) NOT NULL,
  level            INT NOT NULL DEFAULT 0,
  promotion_to_id  UUID REFERENCES designations(id),
  created_by       UUID,
  updated_by       UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ
);
CREATE INDEX ix_designations_org ON designations(organization_id);

-- ---------------------------------------------------------------------
-- COMPETENCY
-- ---------------------------------------------------------------------
CREATE TABLE competency_categories (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name            VARCHAR(150) NOT NULL,
  description     TEXT,
  color_tone      VARCHAR(30),
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_by      UUID,
  updated_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);
CREATE UNIQUE INDEX uq_competency_categories_org_name ON competency_categories(organization_id, lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX ix_competency_categories_org ON competency_categories(organization_id);

CREATE TABLE competencies (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  category_id     UUID NOT NULL REFERENCES competency_categories(id),
  name            VARCHAR(200) NOT NULL,
  description     TEXT,
  is_archived     BOOLEAN NOT NULL DEFAULT false,
  created_by      UUID,
  updated_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);
CREATE UNIQUE INDEX uq_competencies_org_name ON competencies(organization_id, lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX ix_competencies_org ON competencies(organization_id);
CREATE INDEX ix_competencies_category ON competencies(category_id);

CREATE TABLE competency_versions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  competency_id   UUID NOT NULL REFERENCES competencies(id) ON DELETE CASCADE,
  version_label   VARCHAR(20) NOT NULL,
  status          competency_version_status NOT NULL DEFAULT 'draft',
  created_by      UUID,
  updated_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);
CREATE UNIQUE INDEX uq_competency_versions_comp_label ON competency_versions(competency_id, version_label) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_competency_versions_one_active ON competency_versions(competency_id) WHERE status = 'active' AND deleted_at IS NULL;
CREATE INDEX ix_competency_versions_org ON competency_versions(organization_id);
CREATE INDEX ix_competency_versions_competency ON competency_versions(competency_id);

CREATE TABLE proficiency_levels (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  version_id      UUID NOT NULL REFERENCES competency_versions(id) ON DELETE CASCADE,
  level           SMALLINT NOT NULL CHECK (level > 0),
  name            VARCHAR(80) NOT NULL,
  description     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_proficiency_levels_version_level UNIQUE (version_id, level)
);
CREATE INDEX ix_proficiency_levels_version ON proficiency_levels(version_id);

CREATE TABLE behaviour_indicators (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations(id),
  version_id           UUID NOT NULL REFERENCES competency_versions(id) ON DELETE CASCADE,
  proficiency_level_id UUID REFERENCES proficiency_levels(id) ON DELETE SET NULL,
  type                 behaviour_indicator_type NOT NULL,
  text                 TEXT NOT NULL,
  sort_order           INT NOT NULL DEFAULT 0,
  created_by           UUID,
  updated_by           UUID,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at           TIMESTAMPTZ
);
CREATE INDEX ix_behaviour_indicators_org ON behaviour_indicators(organization_id);
CREATE INDEX ix_behaviour_indicators_version ON behaviour_indicators(version_id);
CREATE INDEX ix_behaviour_indicators_level ON behaviour_indicators(proficiency_level_id);

CREATE TABLE competency_designation_mappings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  competency_id   UUID NOT NULL REFERENCES competencies(id) ON DELETE CASCADE,
  designation_id  UUID NOT NULL REFERENCES designations(id) ON DELETE CASCADE,
  weight          NUMERIC(6,2) NOT NULL DEFAULT 0 CHECK (weight >= 0 AND weight <= 100),
  is_mandatory    BOOLEAN NOT NULL DEFAULT false,
  created_by      UUID,
  updated_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);
CREATE UNIQUE INDEX uq_comp_desig_mapping ON competency_designation_mappings(competency_id, designation_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_comp_desig_mapping_org ON competency_designation_mappings(organization_id);
CREATE INDEX ix_comp_desig_mapping_designation ON competency_designation_mappings(designation_id);

-- =====================================================================
-- End of initial schema
-- =====================================================================

-- ---------------------------------------------------------------------
-- AUTHENTICATION
-- ---------------------------------------------------------------------
CREATE TABLE refresh_tokens (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations(id),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash        VARCHAR(128) NOT NULL UNIQUE,
  replaced_token_id UUID,
  expires_at        TIMESTAMPTZ NOT NULL,
  revoked_at        TIMESTAMPTZ,
  ip                VARCHAR(60),
  user_agent        TEXT,
  device_hash       VARCHAR(128),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_refresh_tokens_org ON refresh_tokens(organization_id);
CREATE INDEX ix_refresh_tokens_user ON refresh_tokens(user_id);

CREATE TABLE mfa_secrets (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  encrypted_secret TEXT NOT NULL,
  enabled          BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE mfa_backup_codes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mfa_secret_id UUID NOT NULL REFERENCES mfa_secrets(id) ON DELETE CASCADE,
  code_hash     VARCHAR(128) NOT NULL,
  used_at       TIMESTAMPTZ
);
CREATE INDEX ix_mfa_backup_codes_secret ON mfa_backup_codes(mfa_secret_id);

CREATE TABLE trusted_devices (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_hash  VARCHAR(128) NOT NULL,
  label        VARCHAR(120),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_trusted_device UNIQUE (user_id, device_hash)
);

CREATE TABLE login_attempts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  email           VARCHAR(255) NOT NULL,
  success         BOOLEAN NOT NULL,
  reason          VARCHAR(120),
  ip              VARCHAR(60),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_login_attempts_lookup ON login_attempts(organization_id, email, created_at);

CREATE TABLE password_history (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  password_hash VARCHAR(255) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_password_history_user ON password_history(user_id);

-- ---------------------------------------------------------------------
-- ORGANIZATION — employees, managers
-- ---------------------------------------------------------------------
CREATE TABLE employees (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  user_id         UUID NOT NULL UNIQUE REFERENCES users(id),
  employee_code   VARCHAR(60) NOT NULL,
  department_id   UUID REFERENCES departments(id),
  designation_id  UUID REFERENCES designations(id),
  campus_id       UUID REFERENCES organizations(id),
  line_manager_id UUID REFERENCES employees(id),
  join_date       DATE,
  status          VARCHAR(20) NOT NULL DEFAULT 'active',
  created_by      UUID,
  updated_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);
CREATE UNIQUE INDEX uq_employees_org_code ON employees(organization_id, employee_code) WHERE deleted_at IS NULL;
CREATE INDEX ix_employees_org ON employees(organization_id);
CREATE INDEX ix_employees_department ON employees(department_id);
CREATE INDEX ix_employees_designation ON employees(designation_id);
CREATE INDEX ix_employees_line_manager ON employees(line_manager_id);

CREATE TABLE employee_matrix_managers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  manager_id  UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  CONSTRAINT uq_employee_matrix UNIQUE (employee_id, manager_id)
);
CREATE INDEX ix_employee_matrix_manager ON employee_matrix_managers(manager_id);

-- ---------------------------------------------------------------------
-- COMMUNICATION GATEWAY
-- ---------------------------------------------------------------------
CREATE TABLE communication_campaigns (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name            VARCHAR(200) NOT NULL,
  channel         communication_channel NOT NULL,
  template_key    VARCHAR(120),
  subject         VARCHAR(255),
  body            TEXT NOT NULL,
  audience        JSONB NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'draft',
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_comm_campaigns_org ON communication_campaigns(organization_id);

CREATE TABLE notifications (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES organizations(id),
  campaign_id         UUID REFERENCES communication_campaigns(id),
  channel         communication_channel NOT NULL,
  recipient           VARCHAR(255) NOT NULL,
  subject             VARCHAR(255),
  body                TEXT NOT NULL,
  template_key        VARCHAR(120),
  status              VARCHAR(20) NOT NULL DEFAULT 'queued',
  provider            VARCHAR(60),
  provider_message_id VARCHAR(200),
  error               TEXT,
  sent_at             TIMESTAMPTZ,
  created_by          UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_notifications_org_status ON notifications(organization_id, status);
CREATE INDEX ix_notifications_campaign ON notifications(campaign_id);
CREATE INDEX ix_notifications_provider_msg ON notifications(provider_message_id);

CREATE TABLE otp_codes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  identifier      VARCHAR(255) NOT NULL,
  channel         communication_channel NOT NULL,
  code_hash       VARCHAR(128) NOT NULL,
  purpose         VARCHAR(60) NOT NULL,
  attempts        INT NOT NULL DEFAULT 0,
  expires_at      TIMESTAMPTZ NOT NULL,
  consumed_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_otp_codes_lookup ON otp_codes(organization_id, identifier, purpose);

CREATE TABLE short_links (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  code            VARCHAR(20) NOT NULL UNIQUE,
  target_url      TEXT NOT NULL,
  clicks          INT NOT NULL DEFAULT 0,
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_short_links_org ON short_links(organization_id);

-- ---------------------------------------------------------------------
-- QUESTIONNAIRE
-- ---------------------------------------------------------------------
CREATE TABLE questions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  competency_id   UUID REFERENCES competencies(id),
  rating_scale_id UUID REFERENCES rating_scales(id),
  category        VARCHAR(120),
  text            TEXT NOT NULL,
  type            question_type NOT NULL,
  is_mandatory    BOOLEAN NOT NULL DEFAULT true,
  weight          NUMERIC(6,2) NOT NULL DEFAULT 1,
  options         JSONB,
  language        VARCHAR(10) NOT NULL DEFAULT 'en',
  status          VARCHAR(20) NOT NULL DEFAULT 'active',
  created_by      UUID,
  updated_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);
CREATE INDEX ix_questions_org ON questions(organization_id);
CREATE INDEX ix_questions_competency ON questions(competency_id);

CREATE TABLE questionnaire_templates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name            VARCHAR(200) NOT NULL,
  description     TEXT,
  status          VARCHAR(20) NOT NULL DEFAULT 'draft',
  version         INT NOT NULL DEFAULT 1,
  created_by      UUID,
  updated_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);
CREATE INDEX ix_questionnaire_templates_org ON questionnaire_templates(organization_id);

CREATE TABLE template_sections (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID NOT NULL REFERENCES questionnaire_templates(id) ON DELETE CASCADE,
  title       VARCHAR(200) NOT NULL,
  description TEXT,
  sort_order  INT NOT NULL DEFAULT 0
);
CREATE INDEX ix_template_sections_template ON template_sections(template_id);

CREATE TABLE section_questions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id            UUID NOT NULL REFERENCES template_sections(id) ON DELETE CASCADE,
  question_id           UUID NOT NULL REFERENCES questions(id),
  sort_order            INT NOT NULL DEFAULT 0,
  weight_override       NUMERIC(6,2),
  is_mandatory_override BOOLEAN,
  condition             JSONB,
  CONSTRAINT uq_section_question UNIQUE (section_id, question_id)
);
CREATE INDEX ix_section_questions_question ON section_questions(question_id);

CREATE TABLE rubrics (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  competency_id   UUID REFERENCES competencies(id),
  rating_scale_id UUID REFERENCES rating_scales(id),
  title           VARCHAR(200) NOT NULL,
  descriptors     JSONB NOT NULL,
  created_by      UUID,
  updated_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);
CREATE INDEX ix_rubrics_org ON rubrics(organization_id);

-- ---------------------------------------------------------------------
-- WORKFLOW ENGINE (generic, polymorphic entity)
-- ---------------------------------------------------------------------
CREATE TABLE workflow_definitions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name            VARCHAR(200) NOT NULL,
  entity_type     VARCHAR(80) NOT NULL,
  mode            workflow_mode NOT NULL DEFAULT 'sequential',
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_by      UUID,
  updated_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);
CREATE INDEX ix_workflow_definitions_org ON workflow_definitions(organization_id, entity_type);

CREATE TABLE workflow_steps (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  definition_id  UUID NOT NULL REFERENCES workflow_definitions(id) ON DELETE CASCADE,
  name           VARCHAR(200) NOT NULL,
  step_order     INT NOT NULL,
  assignee_type  VARCHAR(20) NOT NULL CHECK (assignee_type IN ('role','user')),
  assignee_value UUID,
  sla_hours      INT,
  condition      JSONB,
  CONSTRAINT uq_workflow_step_order UNIQUE (definition_id, step_order)
);
CREATE INDEX ix_workflow_steps_definition ON workflow_steps(definition_id);

CREATE TABLE workflow_instances (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  definition_id   UUID NOT NULL REFERENCES workflow_definitions(id),
  entity_type     VARCHAR(80) NOT NULL,
  entity_id       UUID NOT NULL,
  status          workflow_status NOT NULL DEFAULT 'pending',
  current_order   INT NOT NULL DEFAULT 1,
  started_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
);
CREATE INDEX ix_workflow_instances_entity ON workflow_instances(organization_id, entity_type, entity_id);
CREATE INDEX ix_workflow_instances_definition ON workflow_instances(definition_id);

CREATE TABLE workflow_tasks (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id          UUID NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
  step_id              UUID NOT NULL REFERENCES workflow_steps(id),
  step_order           INT NOT NULL,
  assignee_user_id     UUID NOT NULL,
  status               workflow_task_status NOT NULL DEFAULT 'pending',
  comment              TEXT,
  delegated_to_user_id UUID,
  decided_at           TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_workflow_tasks_instance ON workflow_tasks(instance_id);
CREATE INDEX ix_workflow_tasks_assignee ON workflow_tasks(assignee_user_id, status);

-- ---------------------------------------------------------------------
-- APPRAISAL
-- ---------------------------------------------------------------------
CREATE TABLE appraisal_cycles (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES organizations(id),
  name                VARCHAR(200) NOT NULL,
  start_date          DATE NOT NULL,
  end_date            DATE NOT NULL,
  submission_deadline DATE,
  status              VARCHAR(20) NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','active','closed','archived')),
  template_id         UUID REFERENCES questionnaire_templates(id),
  rating_scale_id     UUID REFERENCES rating_scales(id),
  created_by          UUID,
  updated_by          UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at          TIMESTAMPTZ
);
CREATE INDEX ix_appraisal_cycles_org ON appraisal_cycles(organization_id);

CREATE TABLE feedback_sources (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id       UUID NOT NULL REFERENCES appraisal_cycles(id) ON DELETE CASCADE,
  code           VARCHAR(40) NOT NULL,
  label          VARCHAR(120) NOT NULL,
  weight         NUMERIC(6,2) NOT NULL DEFAULT 1,
  required_count INT NOT NULL DEFAULT 1,
  is_anonymous   BOOLEAN NOT NULL DEFAULT false,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  -- Optional quadrant-specific questionnaire. NULL means "use the cycle's template",
  -- which is how every cycle behaved before this column existed. Set it to give one
  -- evaluator group its own questions - e.g. peers rating collaboration while the
  -- line manager rates delivery. Competencies stay in the shared global library, so
  -- a competency asked by two or more quadrants is automatically comparable.
  template_id    UUID REFERENCES questionnaire_templates(id),
  CONSTRAINT uq_feedback_source_code UNIQUE (cycle_id, code)
);
CREATE INDEX ix_feedback_sources_cycle ON feedback_sources(cycle_id);
CREATE INDEX ix_feedback_sources_template ON feedback_sources(template_id);

CREATE TABLE appraisal_participants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id    UUID NOT NULL REFERENCES appraisal_cycles(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id),
  status      VARCHAR(20) NOT NULL DEFAULT 'pending',
  final_score NUMERIC(6,2),
  potential_rating NUMERIC(6,2),
  visibility  VARCHAR(20) NOT NULL DEFAULT 'draft',
  released_at TIMESTAMPTZ,
  released_by UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_appraisal_participant UNIQUE (cycle_id, employee_id)
);
CREATE INDEX ix_appraisal_participants_cycle ON appraisal_participants(cycle_id);

CREATE TABLE reviewer_assignments (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations(id),
  cycle_id             UUID NOT NULL REFERENCES appraisal_cycles(id) ON DELETE CASCADE,
  participant_id       UUID NOT NULL REFERENCES appraisal_participants(id) ON DELETE CASCADE,
  source_id            UUID NOT NULL REFERENCES feedback_sources(id),
  reviewer_employee_id UUID REFERENCES employees(id),
  reviewer_type        VARCHAR(20) NOT NULL DEFAULT 'internal',
  external_ref         VARCHAR(64),
  external_name        VARCHAR(200),
  status               VARCHAR(20) NOT NULL DEFAULT 'pending',
  nomination_status    VARCHAR(20) NOT NULL DEFAULT 'approved',
  submitted_at         TIMESTAMPTZ,
  last_reminded_at     TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_reviewer_assignment UNIQUE (participant_id, source_id, reviewer_employee_id)
);
CREATE INDEX ix_reviewer_assignments_org ON reviewer_assignments(organization_id);
CREATE INDEX ix_reviewer_assignments_reviewer ON reviewer_assignments(reviewer_employee_id, status);

CREATE TABLE feedback_responses (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id UUID NOT NULL REFERENCES reviewer_assignments(id) ON DELETE CASCADE,
  question_id   UUID NOT NULL REFERENCES questions(id),
  rating_value  NUMERIC(6,2),
  text_value    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_feedback_response UNIQUE (assignment_id, question_id)
);
CREATE INDEX ix_feedback_responses_assignment ON feedback_responses(assignment_id);

-- ===========================================================================
-- Integration (Phase 13): programmatic API keys + outbound webhooks.
-- ===========================================================================

CREATE TABLE api_keys (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name            VARCHAR(120) NOT NULL,
  prefix          VARCHAR(24) NOT NULL,
  key_hash        TEXT NOT NULL UNIQUE,
  scopes          TEXT[] NOT NULL DEFAULT '{}',
  last_used_at    TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_api_keys_org ON api_keys(organization_id);

CREATE TABLE webhook_endpoints (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  url             TEXT NOT NULL,
  events          TEXT[] NOT NULL DEFAULT '{}',
  secret          TEXT NOT NULL,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  description     VARCHAR(200),
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_webhook_endpoints_org ON webhook_endpoints(organization_id);

CREATE TABLE webhook_deliveries (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id UUID NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event       VARCHAR(80) NOT NULL,
  payload     JSONB NOT NULL,
  status      VARCHAR(20) NOT NULL DEFAULT 'pending',
  status_code INT,
  error       TEXT,
  attempts    INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_webhook_deliveries_endpoint ON webhook_deliveries(endpoint_id);

-- ===========================================================================
-- Development action plans (Phase 13 high-value).
-- ===========================================================================
CREATE TABLE development_actions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  employee_id     UUID NOT NULL REFERENCES employees(id),
  competency      VARCHAR(200),
  title           VARCHAR(300) NOT NULL,
  description     TEXT,
  status          VARCHAR(20) NOT NULL DEFAULT 'open',
  priority        VARCHAR(20) NOT NULL DEFAULT 'medium',
  due_date        DATE,
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_development_actions_org ON development_actions(organization_id);
CREATE INDEX ix_development_actions_employee ON development_actions(employee_id);

-- ===========================================================================
-- Nice-to-have: scheduled report digests + in-app notifications.
-- ===========================================================================
CREATE TABLE report_schedules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name            VARCHAR(200) NOT NULL,
  report_type     VARCHAR(40) NOT NULL,
  frequency       VARCHAR(20) NOT NULL DEFAULT 'weekly',
  recipients      TEXT[] NOT NULL DEFAULT '{}',
  cycle_id        UUID REFERENCES appraisal_cycles(id) ON DELETE SET NULL,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  last_run_at     TIMESTAMPTZ,
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_report_schedules_org ON report_schedules(organization_id);

CREATE TABLE user_notifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type            VARCHAR(40) NOT NULL,
  title           VARCHAR(200) NOT NULL,
  body            TEXT,
  link            VARCHAR(300),
  read_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_user_notifications_user ON user_notifications(user_id);
CREATE INDEX ix_user_notifications_org ON user_notifications(organization_id);

-- External evaluation (SIS Phase 2): tokenised, no-login parent evaluation links.
CREATE TABLE evaluation_links (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        UUID NOT NULL REFERENCES organizations(id),
  token_hash             VARCHAR(128) NOT NULL UNIQUE,
  student_id             VARCHAR(64) NOT NULL,
  student_name           VARCHAR(200),
  parent_id              VARCHAR(64),
  parent_name            VARCHAR(200),
  recipient              VARCHAR(255),
  teacher_id             VARCHAR(64) NOT NULL,
  teacher_name           VARCHAR(200),
  subject_id             VARCHAR(64),
  subject_name           VARCHAR(200),
  teaching_assignment_id VARCHAR(64),
  class_name             VARCHAR(120),
  section_name           VARCHAR(120),
  session_name           VARCHAR(120),
  template_id            UUID,
  employee_id            UUID,
  cycle_id               UUID,
  reviewer_assignment_id UUID,
  status                 VARCHAR(20) NOT NULL DEFAULT 'pending',
  one_time               BOOLEAN NOT NULL DEFAULT true,
  expires_at             TIMESTAMPTZ,
  responses              JSONB,
  overall_score          NUMERIC(6,2),
  comment                TEXT,
  send_channel           VARCHAR(20),
  sent_at                TIMESTAMPTZ,
  opened_at              TIMESTAMPTZ,
  completed_at           TIMESTAMPTZ,
  created_by             UUID,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_evaluation_links_org_status ON evaluation_links(organization_id, status);
CREATE INDEX ix_evaluation_links_org_student ON evaluation_links(organization_id, student_id);

-- External identity mapping: SIS teacher (and future student/alumni/…) -> 360 Employee.
CREATE TABLE external_identity_maps (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  external_type   VARCHAR(30) NOT NULL,
  external_id     VARCHAR(64) NOT NULL,
  external_code   VARCHAR(120),
  match_key       VARCHAR(60) NOT NULL DEFAULT 'employee_code',
  employee_id     UUID NOT NULL REFERENCES employees(id),
  active          BOOLEAN NOT NULL DEFAULT true,
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_external_identity UNIQUE (organization_id, external_type, external_id)
);
CREATE INDEX ix_external_identity_org_type ON external_identity_maps(organization_id, external_type);
CREATE INDEX ix_external_identity_employee ON external_identity_maps(employee_id);
