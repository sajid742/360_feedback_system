-- ============================================================================
-- 001_reconcile.sql  —  idempotent, ADDITIVE schema reconcile.
-- Brings a database created by an OLDER version of 000_initial_schema.sql up to
-- the current schema by adding any missing tables, columns and indexes. Safe to
-- run repeatedly and safe on populated tables. Never drops or alters existing
-- data or partial (soft-delete) unique indexes. Applied automatically by deploy.ps1.
-- ============================================================================

-- Prerequisites. pgcrypto backs gen_random_uuid(); the enum types back several
-- columns below. Each type is guarded individually so a partial set still
-- completes (a single shared DO/EXCEPTION block would roll every CREATE back on
-- the first duplicate). This makes the reconcile self-sufficient: it builds a
-- fresh database on its own even if the base DDL step was skipped.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $$ BEGIN CREATE TYPE org_type AS ENUM ('root','campus'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE competency_version_status AS ENUM ('draft','active','retired'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE behaviour_indicator_type AS ENUM ('positive','negative'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE communication_channel AS ENUM ('email','sms','whatsapp'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE question_type AS ENUM ('rating','yes_no','multiple_choice','text','numeric'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE workflow_mode AS ENUM ('sequential','parallel'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE workflow_status AS ENUM ('pending','in_progress','approved','rejected','cancelled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE workflow_task_status AS ENUM ('pending','approved','rejected','delegated','skipped'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS organizations (

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
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS parent_org_id  UUID REFERENCES organizations(id);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS name           VARCHAR(200);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS slug           VARCHAR(120) UNIQUE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS org_type       org_type NOT NULL DEFAULT 'root';
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS status         VARCHAR(20) NOT NULL DEFAULT 'active';
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS created_at     TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS updated_at     TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS deleted_at     TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS users (

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
ALTER TABLE users ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS email           VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash   VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name       VARCHAR(200);
ALTER TABLE users ADD COLUMN IF NOT EXISTS status          VARCHAR(20) NOT NULL DEFAULT 'active';
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at      TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS roles (

  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name            VARCHAR(120) NOT NULL,
  description     TEXT,
  is_system       BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);
ALTER TABLE roles ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
ALTER TABLE roles ADD COLUMN IF NOT EXISTS name            VARCHAR(120);
ALTER TABLE roles ADD COLUMN IF NOT EXISTS description     TEXT;
ALTER TABLE roles ADD COLUMN IF NOT EXISTS is_system       BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE roles ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE roles ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE roles ADD COLUMN IF NOT EXISTS deleted_at      TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS permissions (

  code        VARCHAR(100) PRIMARY KEY,
  module      VARCHAR(60) NOT NULL,
  description TEXT NOT NULL
);
ALTER TABLE permissions ADD COLUMN IF NOT EXISTS module      VARCHAR(60);
ALTER TABLE permissions ADD COLUMN IF NOT EXISTS description TEXT;

CREATE TABLE IF NOT EXISTS role_permissions (

  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id         UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_code VARCHAR(100) NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  CONSTRAINT uq_role_permission UNIQUE (role_id, permission_code)
);
ALTER TABLE role_permissions ADD COLUMN IF NOT EXISTS role_id         UUID REFERENCES roles(id) ON DELETE CASCADE;
ALTER TABLE role_permissions ADD COLUMN IF NOT EXISTS permission_code VARCHAR(100) REFERENCES permissions(code) ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS user_roles (

  id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  CONSTRAINT uq_user_role UNIQUE (user_id, role_id)
);
ALTER TABLE user_roles ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE user_roles ADD COLUMN IF NOT EXISTS role_id UUID REFERENCES roles(id) ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS audit_logs (

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
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS user_id         UUID;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS action          VARCHAR(120);
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS entity_type     VARCHAR(80);
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS entity_id       UUID;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS previous_value  JSONB;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS new_value       JSONB;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS reason          TEXT;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS ip              VARCHAR(60);
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS device          TEXT;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS configurations (

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
ALTER TABLE configurations ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
ALTER TABLE configurations ADD COLUMN IF NOT EXISTS module          VARCHAR(60);
ALTER TABLE configurations ADD COLUMN IF NOT EXISTS key             VARCHAR(120);
ALTER TABLE configurations ADD COLUMN IF NOT EXISTS value           JSONB;
ALTER TABLE configurations ADD COLUMN IF NOT EXISTS created_by      UUID;
ALTER TABLE configurations ADD COLUMN IF NOT EXISTS updated_by      UUID;
ALTER TABLE configurations ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE configurations ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE configurations ADD COLUMN IF NOT EXISTS deleted_at      TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS feature_flags (

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
ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS key             VARCHAR(120);
ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS is_enabled      BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS description     TEXT;
ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS created_by      UUID;
ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS updated_by      UUID;
ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS system_settings (

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
ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS key             VARCHAR(120);
ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS value           JSONB;
ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS created_by      UUID;
ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS updated_by      UUID;
ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS rating_scales (

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
ALTER TABLE rating_scales ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
ALTER TABLE rating_scales ADD COLUMN IF NOT EXISTS name            VARCHAR(120);
ALTER TABLE rating_scales ADD COLUMN IF NOT EXISTS scale_type      VARCHAR(20);
ALTER TABLE rating_scales ADD COLUMN IF NOT EXISTS min_value       NUMERIC(6,2);
ALTER TABLE rating_scales ADD COLUMN IF NOT EXISTS max_value       NUMERIC(6,2);
ALTER TABLE rating_scales ADD COLUMN IF NOT EXISTS status          VARCHAR(20) NOT NULL DEFAULT 'active';
ALTER TABLE rating_scales ADD COLUMN IF NOT EXISTS created_by      UUID;
ALTER TABLE rating_scales ADD COLUMN IF NOT EXISTS updated_by      UUID;
ALTER TABLE rating_scales ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE rating_scales ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE rating_scales ADD COLUMN IF NOT EXISTS deleted_at      TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS rating_scale_levels (

  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rating_scale_id UUID NOT NULL REFERENCES rating_scales(id) ON DELETE CASCADE,
  value           NUMERIC(6,2) NOT NULL,
  label           VARCHAR(60) NOT NULL,
  color           VARCHAR(20),
  icon            VARCHAR(50),
  sort_order      INT NOT NULL DEFAULT 0,
  CONSTRAINT uq_rating_scale_value UNIQUE (rating_scale_id, value)
);
ALTER TABLE rating_scale_levels ADD COLUMN IF NOT EXISTS rating_scale_id UUID REFERENCES rating_scales(id) ON DELETE CASCADE;
ALTER TABLE rating_scale_levels ADD COLUMN IF NOT EXISTS value           NUMERIC(6,2);
ALTER TABLE rating_scale_levels ADD COLUMN IF NOT EXISTS label           VARCHAR(60);
ALTER TABLE rating_scale_levels ADD COLUMN IF NOT EXISTS color           VARCHAR(20);
ALTER TABLE rating_scale_levels ADD COLUMN IF NOT EXISTS icon            VARCHAR(50);
ALTER TABLE rating_scale_levels ADD COLUMN IF NOT EXISTS sort_order      INT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS departments (

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
ALTER TABLE departments ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
ALTER TABLE departments ADD COLUMN IF NOT EXISTS parent_id       UUID REFERENCES departments(id);
ALTER TABLE departments ADD COLUMN IF NOT EXISTS campus_id       UUID REFERENCES organizations(id);
ALTER TABLE departments ADD COLUMN IF NOT EXISTS name            VARCHAR(200);
ALTER TABLE departments ADD COLUMN IF NOT EXISTS unit_type       VARCHAR(40) NOT NULL DEFAULT 'department';
ALTER TABLE departments ADD COLUMN IF NOT EXISTS created_by      UUID;
ALTER TABLE departments ADD COLUMN IF NOT EXISTS updated_by      UUID;
ALTER TABLE departments ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE departments ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE departments ADD COLUMN IF NOT EXISTS deleted_at      TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS designations (

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
ALTER TABLE designations ADD COLUMN IF NOT EXISTS organization_id  UUID REFERENCES organizations(id);
ALTER TABLE designations ADD COLUMN IF NOT EXISTS name             VARCHAR(200);
ALTER TABLE designations ADD COLUMN IF NOT EXISTS level            INT NOT NULL DEFAULT 0;
ALTER TABLE designations ADD COLUMN IF NOT EXISTS promotion_to_id  UUID REFERENCES designations(id);
ALTER TABLE designations ADD COLUMN IF NOT EXISTS created_by       UUID;
ALTER TABLE designations ADD COLUMN IF NOT EXISTS updated_by       UUID;
ALTER TABLE designations ADD COLUMN IF NOT EXISTS created_at       TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE designations ADD COLUMN IF NOT EXISTS updated_at       TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE designations ADD COLUMN IF NOT EXISTS deleted_at       TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS competency_categories (

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
ALTER TABLE competency_categories ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
ALTER TABLE competency_categories ADD COLUMN IF NOT EXISTS name            VARCHAR(150);
ALTER TABLE competency_categories ADD COLUMN IF NOT EXISTS description     TEXT;
ALTER TABLE competency_categories ADD COLUMN IF NOT EXISTS color_tone      VARCHAR(30);
ALTER TABLE competency_categories ADD COLUMN IF NOT EXISTS is_active       BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE competency_categories ADD COLUMN IF NOT EXISTS created_by      UUID;
ALTER TABLE competency_categories ADD COLUMN IF NOT EXISTS updated_by      UUID;
ALTER TABLE competency_categories ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE competency_categories ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE competency_categories ADD COLUMN IF NOT EXISTS deleted_at      TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS competencies (

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
ALTER TABLE competencies ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
ALTER TABLE competencies ADD COLUMN IF NOT EXISTS category_id     UUID REFERENCES competency_categories(id);
ALTER TABLE competencies ADD COLUMN IF NOT EXISTS name            VARCHAR(200);
ALTER TABLE competencies ADD COLUMN IF NOT EXISTS description     TEXT;
ALTER TABLE competencies ADD COLUMN IF NOT EXISTS is_archived     BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE competencies ADD COLUMN IF NOT EXISTS created_by      UUID;
ALTER TABLE competencies ADD COLUMN IF NOT EXISTS updated_by      UUID;
ALTER TABLE competencies ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE competencies ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE competencies ADD COLUMN IF NOT EXISTS deleted_at      TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS competency_versions (

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
ALTER TABLE competency_versions ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
ALTER TABLE competency_versions ADD COLUMN IF NOT EXISTS competency_id   UUID REFERENCES competencies(id) ON DELETE CASCADE;
ALTER TABLE competency_versions ADD COLUMN IF NOT EXISTS version_label   VARCHAR(20);
ALTER TABLE competency_versions ADD COLUMN IF NOT EXISTS status          competency_version_status NOT NULL DEFAULT 'draft';
ALTER TABLE competency_versions ADD COLUMN IF NOT EXISTS created_by      UUID;
ALTER TABLE competency_versions ADD COLUMN IF NOT EXISTS updated_by      UUID;
ALTER TABLE competency_versions ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE competency_versions ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE competency_versions ADD COLUMN IF NOT EXISTS deleted_at      TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS proficiency_levels (

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
ALTER TABLE proficiency_levels ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
ALTER TABLE proficiency_levels ADD COLUMN IF NOT EXISTS version_id      UUID REFERENCES competency_versions(id) ON DELETE CASCADE;
ALTER TABLE proficiency_levels ADD COLUMN IF NOT EXISTS level           SMALLINT CHECK (level > 0);
ALTER TABLE proficiency_levels ADD COLUMN IF NOT EXISTS name            VARCHAR(80);
ALTER TABLE proficiency_levels ADD COLUMN IF NOT EXISTS description     TEXT;
ALTER TABLE proficiency_levels ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE proficiency_levels ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS behaviour_indicators (

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
ALTER TABLE behaviour_indicators ADD COLUMN IF NOT EXISTS organization_id      UUID REFERENCES organizations(id);
ALTER TABLE behaviour_indicators ADD COLUMN IF NOT EXISTS version_id           UUID REFERENCES competency_versions(id) ON DELETE CASCADE;
ALTER TABLE behaviour_indicators ADD COLUMN IF NOT EXISTS proficiency_level_id UUID REFERENCES proficiency_levels(id) ON DELETE SET NULL;
ALTER TABLE behaviour_indicators ADD COLUMN IF NOT EXISTS type                 behaviour_indicator_type;
ALTER TABLE behaviour_indicators ADD COLUMN IF NOT EXISTS text                 TEXT;
ALTER TABLE behaviour_indicators ADD COLUMN IF NOT EXISTS sort_order           INT NOT NULL DEFAULT 0;
ALTER TABLE behaviour_indicators ADD COLUMN IF NOT EXISTS created_by           UUID;
ALTER TABLE behaviour_indicators ADD COLUMN IF NOT EXISTS updated_by           UUID;
ALTER TABLE behaviour_indicators ADD COLUMN IF NOT EXISTS created_at           TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE behaviour_indicators ADD COLUMN IF NOT EXISTS updated_at           TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE behaviour_indicators ADD COLUMN IF NOT EXISTS deleted_at           TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS competency_designation_mappings (

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
ALTER TABLE competency_designation_mappings ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
ALTER TABLE competency_designation_mappings ADD COLUMN IF NOT EXISTS competency_id   UUID REFERENCES competencies(id) ON DELETE CASCADE;
ALTER TABLE competency_designation_mappings ADD COLUMN IF NOT EXISTS designation_id  UUID REFERENCES designations(id) ON DELETE CASCADE;
ALTER TABLE competency_designation_mappings ADD COLUMN IF NOT EXISTS weight          NUMERIC(6,2) NOT NULL DEFAULT 0 CHECK (weight >= 0 AND weight <= 100);
ALTER TABLE competency_designation_mappings ADD COLUMN IF NOT EXISTS is_mandatory    BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE competency_designation_mappings ADD COLUMN IF NOT EXISTS created_by      UUID;
ALTER TABLE competency_designation_mappings ADD COLUMN IF NOT EXISTS updated_by      UUID;
ALTER TABLE competency_designation_mappings ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE competency_designation_mappings ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE competency_designation_mappings ADD COLUMN IF NOT EXISTS deleted_at      TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS refresh_tokens (

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
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS organization_id   UUID REFERENCES organizations(id);
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS user_id           UUID REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS token_hash        VARCHAR(128) UNIQUE;
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS replaced_token_id UUID;
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS expires_at        TIMESTAMPTZ;
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS revoked_at        TIMESTAMPTZ;
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS ip                VARCHAR(60);
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS user_agent        TEXT;
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS device_hash       VARCHAR(128);
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS created_at        TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS mfa_secrets (

  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  encrypted_secret TEXT NOT NULL,
  enabled          BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE mfa_secrets ADD COLUMN IF NOT EXISTS user_id          UUID UNIQUE REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE mfa_secrets ADD COLUMN IF NOT EXISTS encrypted_secret TEXT;
ALTER TABLE mfa_secrets ADD COLUMN IF NOT EXISTS enabled          BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE mfa_secrets ADD COLUMN IF NOT EXISTS created_at       TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE mfa_secrets ADD COLUMN IF NOT EXISTS updated_at       TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS mfa_backup_codes (

  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mfa_secret_id UUID NOT NULL REFERENCES mfa_secrets(id) ON DELETE CASCADE,
  code_hash     VARCHAR(128) NOT NULL,
  used_at       TIMESTAMPTZ
);
ALTER TABLE mfa_backup_codes ADD COLUMN IF NOT EXISTS mfa_secret_id UUID REFERENCES mfa_secrets(id) ON DELETE CASCADE;
ALTER TABLE mfa_backup_codes ADD COLUMN IF NOT EXISTS code_hash     VARCHAR(128);
ALTER TABLE mfa_backup_codes ADD COLUMN IF NOT EXISTS used_at       TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS trusted_devices (

  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_hash  VARCHAR(128) NOT NULL,
  label        VARCHAR(120),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_trusted_device UNIQUE (user_id, device_hash)
);
ALTER TABLE trusted_devices ADD COLUMN IF NOT EXISTS user_id      UUID REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE trusted_devices ADD COLUMN IF NOT EXISTS device_hash  VARCHAR(128);
ALTER TABLE trusted_devices ADD COLUMN IF NOT EXISTS label        VARCHAR(120);
ALTER TABLE trusted_devices ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE trusted_devices ADD COLUMN IF NOT EXISTS created_at   TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS login_attempts (

  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  email           VARCHAR(255) NOT NULL,
  success         BOOLEAN NOT NULL,
  reason          VARCHAR(120),
  ip              VARCHAR(60),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE login_attempts ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
ALTER TABLE login_attempts ADD COLUMN IF NOT EXISTS email           VARCHAR(255);
ALTER TABLE login_attempts ADD COLUMN IF NOT EXISTS success         BOOLEAN;
ALTER TABLE login_attempts ADD COLUMN IF NOT EXISTS reason          VARCHAR(120);
ALTER TABLE login_attempts ADD COLUMN IF NOT EXISTS ip              VARCHAR(60);
ALTER TABLE login_attempts ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS password_history (

  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  password_hash VARCHAR(255) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE password_history ADD COLUMN IF NOT EXISTS user_id       UUID REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE password_history ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
ALTER TABLE password_history ADD COLUMN IF NOT EXISTS created_at    TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS employees (

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
ALTER TABLE employees ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS user_id         UUID UNIQUE REFERENCES users(id);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS employee_code   VARCHAR(60);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS department_id   UUID REFERENCES departments(id);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS designation_id  UUID REFERENCES designations(id);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS campus_id       UUID REFERENCES organizations(id);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS line_manager_id UUID REFERENCES employees(id);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS join_date       DATE;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS status          VARCHAR(20) NOT NULL DEFAULT 'active';
ALTER TABLE employees ADD COLUMN IF NOT EXISTS created_by      UUID;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS updated_by      UUID;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE employees ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE employees ADD COLUMN IF NOT EXISTS deleted_at      TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS employee_matrix_managers (

  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  manager_id  UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  CONSTRAINT uq_employee_matrix UNIQUE (employee_id, manager_id)
);
ALTER TABLE employee_matrix_managers ADD COLUMN IF NOT EXISTS employee_id UUID REFERENCES employees(id) ON DELETE CASCADE;
ALTER TABLE employee_matrix_managers ADD COLUMN IF NOT EXISTS manager_id  UUID REFERENCES employees(id) ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS communication_campaigns (

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
ALTER TABLE communication_campaigns ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
ALTER TABLE communication_campaigns ADD COLUMN IF NOT EXISTS name            VARCHAR(200);
ALTER TABLE communication_campaigns ADD COLUMN IF NOT EXISTS channel         communication_channel;
ALTER TABLE communication_campaigns ADD COLUMN IF NOT EXISTS template_key    VARCHAR(120);
ALTER TABLE communication_campaigns ADD COLUMN IF NOT EXISTS subject         VARCHAR(255);
ALTER TABLE communication_campaigns ADD COLUMN IF NOT EXISTS body            TEXT;
ALTER TABLE communication_campaigns ADD COLUMN IF NOT EXISTS audience        JSONB;
ALTER TABLE communication_campaigns ADD COLUMN IF NOT EXISTS status          VARCHAR(20) NOT NULL DEFAULT 'draft';
ALTER TABLE communication_campaigns ADD COLUMN IF NOT EXISTS created_by      UUID;
ALTER TABLE communication_campaigns ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE communication_campaigns ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS notifications (

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
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS organization_id     UUID REFERENCES organizations(id);
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS campaign_id         UUID REFERENCES communication_campaigns(id);
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS channel         communication_channel;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS recipient           VARCHAR(255);
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS subject             VARCHAR(255);
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS body                TEXT;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS template_key        VARCHAR(120);
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS status              VARCHAR(20) NOT NULL DEFAULT 'queued';
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS provider            VARCHAR(60);
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS provider_message_id VARCHAR(200);
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS error               TEXT;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS sent_at             TIMESTAMPTZ;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS created_by          UUID;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS created_at          TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS otp_codes (

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
ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS identifier      VARCHAR(255);
ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS channel         communication_channel;
ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS code_hash       VARCHAR(128);
ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS purpose         VARCHAR(60);
ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS attempts        INT NOT NULL DEFAULT 0;
ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS expires_at      TIMESTAMPTZ;
ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS consumed_at     TIMESTAMPTZ;
ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS short_links (

  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  code            VARCHAR(20) NOT NULL UNIQUE,
  target_url      TEXT NOT NULL,
  clicks          INT NOT NULL DEFAULT 0,
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE short_links ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
ALTER TABLE short_links ADD COLUMN IF NOT EXISTS code            VARCHAR(20) UNIQUE;
ALTER TABLE short_links ADD COLUMN IF NOT EXISTS target_url      TEXT;
ALTER TABLE short_links ADD COLUMN IF NOT EXISTS clicks          INT NOT NULL DEFAULT 0;
ALTER TABLE short_links ADD COLUMN IF NOT EXISTS created_by      UUID;
ALTER TABLE short_links ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS questions (

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
ALTER TABLE questions ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
ALTER TABLE questions ADD COLUMN IF NOT EXISTS competency_id   UUID REFERENCES competencies(id);
ALTER TABLE questions ADD COLUMN IF NOT EXISTS rating_scale_id UUID REFERENCES rating_scales(id);
ALTER TABLE questions ADD COLUMN IF NOT EXISTS category        VARCHAR(120);
ALTER TABLE questions ADD COLUMN IF NOT EXISTS text            TEXT;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS type            question_type;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS is_mandatory    BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS weight          NUMERIC(6,2) NOT NULL DEFAULT 1;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS options         JSONB;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS language        VARCHAR(10) NOT NULL DEFAULT 'en';
ALTER TABLE questions ADD COLUMN IF NOT EXISTS status          VARCHAR(20) NOT NULL DEFAULT 'active';
ALTER TABLE questions ADD COLUMN IF NOT EXISTS created_by      UUID;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS updated_by      UUID;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE questions ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE questions ADD COLUMN IF NOT EXISTS deleted_at      TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS questionnaire_templates (

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
ALTER TABLE questionnaire_templates ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
ALTER TABLE questionnaire_templates ADD COLUMN IF NOT EXISTS name            VARCHAR(200);
ALTER TABLE questionnaire_templates ADD COLUMN IF NOT EXISTS description     TEXT;
ALTER TABLE questionnaire_templates ADD COLUMN IF NOT EXISTS status          VARCHAR(20) NOT NULL DEFAULT 'draft';
ALTER TABLE questionnaire_templates ADD COLUMN IF NOT EXISTS version         INT NOT NULL DEFAULT 1;
ALTER TABLE questionnaire_templates ADD COLUMN IF NOT EXISTS created_by      UUID;
ALTER TABLE questionnaire_templates ADD COLUMN IF NOT EXISTS updated_by      UUID;
ALTER TABLE questionnaire_templates ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE questionnaire_templates ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE questionnaire_templates ADD COLUMN IF NOT EXISTS deleted_at      TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS template_sections (

  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID NOT NULL REFERENCES questionnaire_templates(id) ON DELETE CASCADE,
  title       VARCHAR(200) NOT NULL,
  description TEXT,
  sort_order  INT NOT NULL DEFAULT 0
);
ALTER TABLE template_sections ADD COLUMN IF NOT EXISTS template_id UUID REFERENCES questionnaire_templates(id) ON DELETE CASCADE;
ALTER TABLE template_sections ADD COLUMN IF NOT EXISTS title       VARCHAR(200);
ALTER TABLE template_sections ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE template_sections ADD COLUMN IF NOT EXISTS sort_order  INT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS section_questions (

  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id            UUID NOT NULL REFERENCES template_sections(id) ON DELETE CASCADE,
  question_id           UUID NOT NULL REFERENCES questions(id),
  sort_order            INT NOT NULL DEFAULT 0,
  weight_override       NUMERIC(6,2),
  is_mandatory_override BOOLEAN,
  condition             JSONB,
  CONSTRAINT uq_section_question UNIQUE (section_id, question_id)
);
ALTER TABLE section_questions ADD COLUMN IF NOT EXISTS section_id            UUID REFERENCES template_sections(id) ON DELETE CASCADE;
ALTER TABLE section_questions ADD COLUMN IF NOT EXISTS question_id           UUID REFERENCES questions(id);
ALTER TABLE section_questions ADD COLUMN IF NOT EXISTS sort_order            INT NOT NULL DEFAULT 0;
ALTER TABLE section_questions ADD COLUMN IF NOT EXISTS weight_override       NUMERIC(6,2);
ALTER TABLE section_questions ADD COLUMN IF NOT EXISTS is_mandatory_override BOOLEAN;
ALTER TABLE section_questions ADD COLUMN IF NOT EXISTS condition             JSONB;

CREATE TABLE IF NOT EXISTS rubrics (

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
ALTER TABLE rubrics ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
ALTER TABLE rubrics ADD COLUMN IF NOT EXISTS competency_id   UUID REFERENCES competencies(id);
ALTER TABLE rubrics ADD COLUMN IF NOT EXISTS rating_scale_id UUID REFERENCES rating_scales(id);
ALTER TABLE rubrics ADD COLUMN IF NOT EXISTS title           VARCHAR(200);
ALTER TABLE rubrics ADD COLUMN IF NOT EXISTS descriptors     JSONB;
ALTER TABLE rubrics ADD COLUMN IF NOT EXISTS created_by      UUID;
ALTER TABLE rubrics ADD COLUMN IF NOT EXISTS updated_by      UUID;
ALTER TABLE rubrics ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE rubrics ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE rubrics ADD COLUMN IF NOT EXISTS deleted_at      TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS workflow_definitions (

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
ALTER TABLE workflow_definitions ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
ALTER TABLE workflow_definitions ADD COLUMN IF NOT EXISTS name            VARCHAR(200);
ALTER TABLE workflow_definitions ADD COLUMN IF NOT EXISTS entity_type     VARCHAR(80);
ALTER TABLE workflow_definitions ADD COLUMN IF NOT EXISTS mode            workflow_mode NOT NULL DEFAULT 'sequential';
ALTER TABLE workflow_definitions ADD COLUMN IF NOT EXISTS is_active       BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE workflow_definitions ADD COLUMN IF NOT EXISTS created_by      UUID;
ALTER TABLE workflow_definitions ADD COLUMN IF NOT EXISTS updated_by      UUID;
ALTER TABLE workflow_definitions ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE workflow_definitions ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE workflow_definitions ADD COLUMN IF NOT EXISTS deleted_at      TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS workflow_steps (

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
ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS definition_id  UUID REFERENCES workflow_definitions(id) ON DELETE CASCADE;
ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS name           VARCHAR(200);
ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS step_order     INT;
ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS assignee_type  VARCHAR(20) CHECK (assignee_type IN ('role','user'));
ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS assignee_value UUID;
ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS sla_hours      INT;
ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS condition      JSONB;

CREATE TABLE IF NOT EXISTS workflow_instances (

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
ALTER TABLE workflow_instances ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
ALTER TABLE workflow_instances ADD COLUMN IF NOT EXISTS definition_id   UUID REFERENCES workflow_definitions(id);
ALTER TABLE workflow_instances ADD COLUMN IF NOT EXISTS entity_type     VARCHAR(80);
ALTER TABLE workflow_instances ADD COLUMN IF NOT EXISTS entity_id       UUID;
ALTER TABLE workflow_instances ADD COLUMN IF NOT EXISTS status          workflow_status NOT NULL DEFAULT 'pending';
ALTER TABLE workflow_instances ADD COLUMN IF NOT EXISTS current_order   INT NOT NULL DEFAULT 1;
ALTER TABLE workflow_instances ADD COLUMN IF NOT EXISTS started_by      UUID;
ALTER TABLE workflow_instances ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE workflow_instances ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE workflow_instances ADD COLUMN IF NOT EXISTS completed_at    TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS workflow_tasks (

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
ALTER TABLE workflow_tasks ADD COLUMN IF NOT EXISTS instance_id          UUID REFERENCES workflow_instances(id) ON DELETE CASCADE;
ALTER TABLE workflow_tasks ADD COLUMN IF NOT EXISTS step_id              UUID REFERENCES workflow_steps(id);
ALTER TABLE workflow_tasks ADD COLUMN IF NOT EXISTS step_order           INT;
ALTER TABLE workflow_tasks ADD COLUMN IF NOT EXISTS assignee_user_id     UUID;
ALTER TABLE workflow_tasks ADD COLUMN IF NOT EXISTS status               workflow_task_status NOT NULL DEFAULT 'pending';
ALTER TABLE workflow_tasks ADD COLUMN IF NOT EXISTS comment              TEXT;
ALTER TABLE workflow_tasks ADD COLUMN IF NOT EXISTS delegated_to_user_id UUID;
ALTER TABLE workflow_tasks ADD COLUMN IF NOT EXISTS decided_at           TIMESTAMPTZ;
ALTER TABLE workflow_tasks ADD COLUMN IF NOT EXISTS created_at           TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS appraisal_cycles (

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
ALTER TABLE appraisal_cycles ADD COLUMN IF NOT EXISTS organization_id     UUID REFERENCES organizations(id);
ALTER TABLE appraisal_cycles ADD COLUMN IF NOT EXISTS name                VARCHAR(200);
ALTER TABLE appraisal_cycles ADD COLUMN IF NOT EXISTS start_date          DATE;
ALTER TABLE appraisal_cycles ADD COLUMN IF NOT EXISTS end_date            DATE;
ALTER TABLE appraisal_cycles ADD COLUMN IF NOT EXISTS submission_deadline DATE;
ALTER TABLE appraisal_cycles ADD COLUMN IF NOT EXISTS status              VARCHAR(20) NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','active','closed','archived'));
ALTER TABLE appraisal_cycles ADD COLUMN IF NOT EXISTS template_id         UUID REFERENCES questionnaire_templates(id);
ALTER TABLE appraisal_cycles ADD COLUMN IF NOT EXISTS rating_scale_id     UUID REFERENCES rating_scales(id);
ALTER TABLE appraisal_cycles ADD COLUMN IF NOT EXISTS created_by          UUID;
ALTER TABLE appraisal_cycles ADD COLUMN IF NOT EXISTS updated_by          UUID;
ALTER TABLE appraisal_cycles ADD COLUMN IF NOT EXISTS created_at          TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE appraisal_cycles ADD COLUMN IF NOT EXISTS updated_at          TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE appraisal_cycles ADD COLUMN IF NOT EXISTS deleted_at          TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS feedback_sources (

  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id       UUID NOT NULL REFERENCES appraisal_cycles(id) ON DELETE CASCADE,
  code           VARCHAR(40) NOT NULL,
  label          VARCHAR(120) NOT NULL,
  weight         NUMERIC(6,2) NOT NULL DEFAULT 1,
  required_count INT NOT NULL DEFAULT 1,
  is_anonymous   BOOLEAN NOT NULL DEFAULT false,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT uq_feedback_source_code UNIQUE (cycle_id, code)
);
ALTER TABLE feedback_sources ADD COLUMN IF NOT EXISTS cycle_id       UUID REFERENCES appraisal_cycles(id) ON DELETE CASCADE;
ALTER TABLE feedback_sources ADD COLUMN IF NOT EXISTS code           VARCHAR(40);
ALTER TABLE feedback_sources ADD COLUMN IF NOT EXISTS label          VARCHAR(120);
ALTER TABLE feedback_sources ADD COLUMN IF NOT EXISTS weight         NUMERIC(6,2) NOT NULL DEFAULT 1;
ALTER TABLE feedback_sources ADD COLUMN IF NOT EXISTS required_count INT NOT NULL DEFAULT 1;
ALTER TABLE feedback_sources ADD COLUMN IF NOT EXISTS is_anonymous   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE feedback_sources ADD COLUMN IF NOT EXISTS is_active      BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS appraisal_participants (

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
ALTER TABLE appraisal_participants ADD COLUMN IF NOT EXISTS cycle_id    UUID REFERENCES appraisal_cycles(id) ON DELETE CASCADE;
ALTER TABLE appraisal_participants ADD COLUMN IF NOT EXISTS employee_id UUID REFERENCES employees(id);
ALTER TABLE appraisal_participants ADD COLUMN IF NOT EXISTS status      VARCHAR(20) NOT NULL DEFAULT 'pending';
ALTER TABLE appraisal_participants ADD COLUMN IF NOT EXISTS final_score NUMERIC(6,2);
ALTER TABLE appraisal_participants ADD COLUMN IF NOT EXISTS potential_rating NUMERIC(6,2);
ALTER TABLE appraisal_participants ADD COLUMN IF NOT EXISTS visibility  VARCHAR(20) NOT NULL DEFAULT 'draft';
ALTER TABLE appraisal_participants ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ;
ALTER TABLE appraisal_participants ADD COLUMN IF NOT EXISTS released_by UUID;
ALTER TABLE appraisal_participants ADD COLUMN IF NOT EXISTS created_at  TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS reviewer_assignments (

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
ALTER TABLE reviewer_assignments ADD COLUMN IF NOT EXISTS organization_id      UUID REFERENCES organizations(id);
ALTER TABLE reviewer_assignments ADD COLUMN IF NOT EXISTS cycle_id             UUID REFERENCES appraisal_cycles(id) ON DELETE CASCADE;
ALTER TABLE reviewer_assignments ADD COLUMN IF NOT EXISTS participant_id       UUID REFERENCES appraisal_participants(id) ON DELETE CASCADE;
ALTER TABLE reviewer_assignments ADD COLUMN IF NOT EXISTS source_id            UUID REFERENCES feedback_sources(id);
ALTER TABLE reviewer_assignments ADD COLUMN IF NOT EXISTS reviewer_employee_id UUID REFERENCES employees(id);
ALTER TABLE reviewer_assignments ADD COLUMN IF NOT EXISTS reviewer_type        VARCHAR(20) NOT NULL DEFAULT 'internal';
ALTER TABLE reviewer_assignments ADD COLUMN IF NOT EXISTS external_ref         VARCHAR(64);
ALTER TABLE reviewer_assignments ADD COLUMN IF NOT EXISTS external_name        VARCHAR(200);
ALTER TABLE reviewer_assignments ADD COLUMN IF NOT EXISTS status               VARCHAR(20) NOT NULL DEFAULT 'pending';
ALTER TABLE reviewer_assignments ADD COLUMN IF NOT EXISTS nomination_status    VARCHAR(20) NOT NULL DEFAULT 'approved';
ALTER TABLE reviewer_assignments ADD COLUMN IF NOT EXISTS submitted_at         TIMESTAMPTZ;
ALTER TABLE reviewer_assignments ADD COLUMN IF NOT EXISTS last_reminded_at     TIMESTAMPTZ;
ALTER TABLE reviewer_assignments ADD COLUMN IF NOT EXISTS created_at           TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS feedback_responses (

  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id UUID NOT NULL REFERENCES reviewer_assignments(id) ON DELETE CASCADE,
  question_id   UUID NOT NULL REFERENCES questions(id),
  rating_value  NUMERIC(6,2),
  text_value    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_feedback_response UNIQUE (assignment_id, question_id)
);
ALTER TABLE feedback_responses ADD COLUMN IF NOT EXISTS assignment_id UUID REFERENCES reviewer_assignments(id) ON DELETE CASCADE;
ALTER TABLE feedback_responses ADD COLUMN IF NOT EXISTS question_id   UUID REFERENCES questions(id);
ALTER TABLE feedback_responses ADD COLUMN IF NOT EXISTS rating_value  NUMERIC(6,2);
ALTER TABLE feedback_responses ADD COLUMN IF NOT EXISTS text_value    TEXT;
ALTER TABLE feedback_responses ADD COLUMN IF NOT EXISTS created_at    TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS api_keys (

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
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS name            VARCHAR(120);
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS prefix          VARCHAR(24);
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS key_hash        TEXT UNIQUE;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS scopes          TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS last_used_at    TIMESTAMPTZ;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS expires_at      TIMESTAMPTZ;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS revoked_at      TIMESTAMPTZ;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS created_by      UUID;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS webhook_endpoints (

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
ALTER TABLE webhook_endpoints ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
ALTER TABLE webhook_endpoints ADD COLUMN IF NOT EXISTS url             TEXT;
ALTER TABLE webhook_endpoints ADD COLUMN IF NOT EXISTS events          TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE webhook_endpoints ADD COLUMN IF NOT EXISTS secret          TEXT;
ALTER TABLE webhook_endpoints ADD COLUMN IF NOT EXISTS is_active       BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE webhook_endpoints ADD COLUMN IF NOT EXISTS description     VARCHAR(200);
ALTER TABLE webhook_endpoints ADD COLUMN IF NOT EXISTS created_by      UUID;
ALTER TABLE webhook_endpoints ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE webhook_endpoints ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS webhook_deliveries (

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
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS endpoint_id UUID REFERENCES webhook_endpoints(id) ON DELETE CASCADE;
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS event       VARCHAR(80);
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS payload     JSONB;
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS status      VARCHAR(20) NOT NULL DEFAULT 'pending';
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS status_code INT;
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS error       TEXT;
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS attempts    INT NOT NULL DEFAULT 0;
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS created_at  TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS development_actions (

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
ALTER TABLE development_actions ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
ALTER TABLE development_actions ADD COLUMN IF NOT EXISTS employee_id     UUID REFERENCES employees(id);
ALTER TABLE development_actions ADD COLUMN IF NOT EXISTS competency      VARCHAR(200);
ALTER TABLE development_actions ADD COLUMN IF NOT EXISTS title           VARCHAR(300);
ALTER TABLE development_actions ADD COLUMN IF NOT EXISTS description     TEXT;
ALTER TABLE development_actions ADD COLUMN IF NOT EXISTS status          VARCHAR(20) NOT NULL DEFAULT 'open';
ALTER TABLE development_actions ADD COLUMN IF NOT EXISTS priority        VARCHAR(20) NOT NULL DEFAULT 'medium';
ALTER TABLE development_actions ADD COLUMN IF NOT EXISTS due_date        DATE;
ALTER TABLE development_actions ADD COLUMN IF NOT EXISTS created_by      UUID;
ALTER TABLE development_actions ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE development_actions ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS report_schedules (

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
ALTER TABLE report_schedules ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
ALTER TABLE report_schedules ADD COLUMN IF NOT EXISTS name            VARCHAR(200);
ALTER TABLE report_schedules ADD COLUMN IF NOT EXISTS report_type     VARCHAR(40);
ALTER TABLE report_schedules ADD COLUMN IF NOT EXISTS frequency       VARCHAR(20) NOT NULL DEFAULT 'weekly';
ALTER TABLE report_schedules ADD COLUMN IF NOT EXISTS recipients      TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE report_schedules ADD COLUMN IF NOT EXISTS cycle_id        UUID REFERENCES appraisal_cycles(id) ON DELETE SET NULL;
ALTER TABLE report_schedules ADD COLUMN IF NOT EXISTS is_active       BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE report_schedules ADD COLUMN IF NOT EXISTS last_run_at     TIMESTAMPTZ;
ALTER TABLE report_schedules ADD COLUMN IF NOT EXISTS created_by      UUID;
ALTER TABLE report_schedules ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS user_notifications (

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
ALTER TABLE user_notifications ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
ALTER TABLE user_notifications ADD COLUMN IF NOT EXISTS user_id         UUID REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE user_notifications ADD COLUMN IF NOT EXISTS type            VARCHAR(40);
ALTER TABLE user_notifications ADD COLUMN IF NOT EXISTS title           VARCHAR(200);
ALTER TABLE user_notifications ADD COLUMN IF NOT EXISTS body            TEXT;
ALTER TABLE user_notifications ADD COLUMN IF NOT EXISTS link            VARCHAR(300);
ALTER TABLE user_notifications ADD COLUMN IF NOT EXISTS read_at         TIMESTAMPTZ;
ALTER TABLE user_notifications ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS evaluation_links (

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
ALTER TABLE evaluation_links ADD COLUMN IF NOT EXISTS organization_id        UUID REFERENCES organizations(id);
ALTER TABLE evaluation_links ADD COLUMN IF NOT EXISTS token_hash             VARCHAR(128) UNIQUE;
ALTER TABLE evaluation_links ADD COLUMN IF NOT EXISTS student_id             VARCHAR(64);
ALTER TABLE evaluation_links ADD COLUMN IF NOT EXISTS student_name           VARCHAR(200);
ALTER TABLE evaluation_links ADD COLUMN IF NOT EXISTS parent_id              VARCHAR(64);
ALTER TABLE evaluation_links ADD COLUMN IF NOT EXISTS parent_name            VARCHAR(200);
ALTER TABLE evaluation_links ADD COLUMN IF NOT EXISTS recipient              VARCHAR(255);
ALTER TABLE evaluation_links ADD COLUMN IF NOT EXISTS teacher_id             VARCHAR(64);
ALTER TABLE evaluation_links ADD COLUMN IF NOT EXISTS teacher_name           VARCHAR(200);
ALTER TABLE evaluation_links ADD COLUMN IF NOT EXISTS subject_id             VARCHAR(64);
ALTER TABLE evaluation_links ADD COLUMN IF NOT EXISTS subject_name           VARCHAR(200);
ALTER TABLE evaluation_links ADD COLUMN IF NOT EXISTS teaching_assignment_id VARCHAR(64);
ALTER TABLE evaluation_links ADD COLUMN IF NOT EXISTS class_name             VARCHAR(120);
ALTER TABLE evaluation_links ADD COLUMN IF NOT EXISTS section_name           VARCHAR(120);
ALTER TABLE evaluation_links ADD COLUMN IF NOT EXISTS session_name           VARCHAR(120);
ALTER TABLE evaluation_links ADD COLUMN IF NOT EXISTS template_id            UUID;
ALTER TABLE evaluation_links ADD COLUMN IF NOT EXISTS employee_id            UUID;
ALTER TABLE evaluation_links ADD COLUMN IF NOT EXISTS cycle_id               UUID;
ALTER TABLE evaluation_links ADD COLUMN IF NOT EXISTS reviewer_assignment_id UUID;
ALTER TABLE evaluation_links ADD COLUMN IF NOT EXISTS status                 VARCHAR(20) NOT NULL DEFAULT 'pending';
ALTER TABLE evaluation_links ADD COLUMN IF NOT EXISTS one_time               BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE evaluation_links ADD COLUMN IF NOT EXISTS expires_at             TIMESTAMPTZ;
ALTER TABLE evaluation_links ADD COLUMN IF NOT EXISTS responses              JSONB;
ALTER TABLE evaluation_links ADD COLUMN IF NOT EXISTS overall_score          NUMERIC(6,2);
ALTER TABLE evaluation_links ADD COLUMN IF NOT EXISTS comment                TEXT;
ALTER TABLE evaluation_links ADD COLUMN IF NOT EXISTS send_channel           VARCHAR(20);
ALTER TABLE evaluation_links ADD COLUMN IF NOT EXISTS sent_at                TIMESTAMPTZ;
ALTER TABLE evaluation_links ADD COLUMN IF NOT EXISTS opened_at              TIMESTAMPTZ;
ALTER TABLE evaluation_links ADD COLUMN IF NOT EXISTS completed_at           TIMESTAMPTZ;
ALTER TABLE evaluation_links ADD COLUMN IF NOT EXISTS created_by             UUID;
ALTER TABLE evaluation_links ADD COLUMN IF NOT EXISTS created_at             TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE evaluation_links ADD COLUMN IF NOT EXISTS updated_at             TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS external_identity_maps (

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
ALTER TABLE external_identity_maps ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
ALTER TABLE external_identity_maps ADD COLUMN IF NOT EXISTS external_type   VARCHAR(30);
ALTER TABLE external_identity_maps ADD COLUMN IF NOT EXISTS external_id     VARCHAR(64);
ALTER TABLE external_identity_maps ADD COLUMN IF NOT EXISTS external_code   VARCHAR(120);
ALTER TABLE external_identity_maps ADD COLUMN IF NOT EXISTS match_key       VARCHAR(60) NOT NULL DEFAULT 'employee_code';
ALTER TABLE external_identity_maps ADD COLUMN IF NOT EXISTS employee_id     UUID REFERENCES employees(id);
ALTER TABLE external_identity_maps ADD COLUMN IF NOT EXISTS active          BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE external_identity_maps ADD COLUMN IF NOT EXISTS created_by      UUID;
ALTER TABLE external_identity_maps ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE external_identity_maps ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT now();

-- External reviewers (parents, …) carry no employee id.
ALTER TABLE reviewer_assignments ALTER COLUMN reviewer_employee_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS ix_organizations_parent ON organizations(parent_org_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_org_email ON users(organization_id, lower(email)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_users_org ON users(organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_roles_org_name ON roles(organization_id, lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_roles_org ON roles(organization_id);
CREATE INDEX IF NOT EXISTS ix_permissions_module ON permissions(module);
CREATE INDEX IF NOT EXISTS ix_role_permissions_code ON role_permissions(permission_code);
CREATE INDEX IF NOT EXISTS ix_user_roles_role ON user_roles(role_id);
CREATE INDEX IF NOT EXISTS ix_audit_logs_org_entity ON audit_logs(organization_id, entity_type);
CREATE INDEX IF NOT EXISTS ix_audit_logs_org_user ON audit_logs(organization_id, user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_configuration_scope ON configurations(organization_id, module, key) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_configurations_org_module ON configurations(organization_id, module);
CREATE INDEX IF NOT EXISTS ix_feature_flags_org ON feature_flags(organization_id);
CREATE INDEX IF NOT EXISTS ix_system_settings_org ON system_settings(organization_id);
CREATE INDEX IF NOT EXISTS ix_rating_scales_org ON rating_scales(organization_id);
CREATE INDEX IF NOT EXISTS ix_rating_scale_levels_scale ON rating_scale_levels(rating_scale_id);
CREATE INDEX IF NOT EXISTS ix_departments_org ON departments(organization_id);
CREATE INDEX IF NOT EXISTS ix_departments_parent ON departments(parent_id);
CREATE INDEX IF NOT EXISTS ix_designations_org ON designations(organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_competency_categories_org_name ON competency_categories(organization_id, lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_competency_categories_org ON competency_categories(organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_competencies_org_name ON competencies(organization_id, lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_competencies_org ON competencies(organization_id);
CREATE INDEX IF NOT EXISTS ix_competencies_category ON competencies(category_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_competency_versions_comp_label ON competency_versions(competency_id, version_label) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_competency_versions_one_active ON competency_versions(competency_id) WHERE status = 'active' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_competency_versions_org ON competency_versions(organization_id);
CREATE INDEX IF NOT EXISTS ix_competency_versions_competency ON competency_versions(competency_id);
CREATE INDEX IF NOT EXISTS ix_proficiency_levels_version ON proficiency_levels(version_id);
CREATE INDEX IF NOT EXISTS ix_behaviour_indicators_org ON behaviour_indicators(organization_id);
CREATE INDEX IF NOT EXISTS ix_behaviour_indicators_version ON behaviour_indicators(version_id);
CREATE INDEX IF NOT EXISTS ix_behaviour_indicators_level ON behaviour_indicators(proficiency_level_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_comp_desig_mapping ON competency_designation_mappings(competency_id, designation_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_comp_desig_mapping_org ON competency_designation_mappings(organization_id);
CREATE INDEX IF NOT EXISTS ix_comp_desig_mapping_designation ON competency_designation_mappings(designation_id);
CREATE INDEX IF NOT EXISTS ix_refresh_tokens_org ON refresh_tokens(organization_id);
CREATE INDEX IF NOT EXISTS ix_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS ix_mfa_backup_codes_secret ON mfa_backup_codes(mfa_secret_id);
CREATE INDEX IF NOT EXISTS ix_login_attempts_lookup ON login_attempts(organization_id, email, created_at);
CREATE INDEX IF NOT EXISTS ix_password_history_user ON password_history(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_employees_org_code ON employees(organization_id, employee_code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_employees_org ON employees(organization_id);
CREATE INDEX IF NOT EXISTS ix_employees_department ON employees(department_id);
CREATE INDEX IF NOT EXISTS ix_employees_designation ON employees(designation_id);
CREATE INDEX IF NOT EXISTS ix_employees_line_manager ON employees(line_manager_id);
CREATE INDEX IF NOT EXISTS ix_employee_matrix_manager ON employee_matrix_managers(manager_id);
CREATE INDEX IF NOT EXISTS ix_comm_campaigns_org ON communication_campaigns(organization_id);
CREATE INDEX IF NOT EXISTS ix_notifications_org_status ON notifications(organization_id, status);
CREATE INDEX IF NOT EXISTS ix_notifications_campaign ON notifications(campaign_id);
CREATE INDEX IF NOT EXISTS ix_notifications_provider_msg ON notifications(provider_message_id);
CREATE INDEX IF NOT EXISTS ix_otp_codes_lookup ON otp_codes(organization_id, identifier, purpose);
CREATE INDEX IF NOT EXISTS ix_short_links_org ON short_links(organization_id);
CREATE INDEX IF NOT EXISTS ix_questions_org ON questions(organization_id);
CREATE INDEX IF NOT EXISTS ix_questions_competency ON questions(competency_id);
CREATE INDEX IF NOT EXISTS ix_questionnaire_templates_org ON questionnaire_templates(organization_id);
CREATE INDEX IF NOT EXISTS ix_template_sections_template ON template_sections(template_id);
CREATE INDEX IF NOT EXISTS ix_section_questions_question ON section_questions(question_id);
CREATE INDEX IF NOT EXISTS ix_rubrics_org ON rubrics(organization_id);
CREATE INDEX IF NOT EXISTS ix_workflow_definitions_org ON workflow_definitions(organization_id, entity_type);
CREATE INDEX IF NOT EXISTS ix_workflow_steps_definition ON workflow_steps(definition_id);
CREATE INDEX IF NOT EXISTS ix_workflow_instances_entity ON workflow_instances(organization_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS ix_workflow_instances_definition ON workflow_instances(definition_id);
CREATE INDEX IF NOT EXISTS ix_workflow_tasks_instance ON workflow_tasks(instance_id);
CREATE INDEX IF NOT EXISTS ix_workflow_tasks_assignee ON workflow_tasks(assignee_user_id, status);
CREATE INDEX IF NOT EXISTS ix_appraisal_cycles_org ON appraisal_cycles(organization_id);
CREATE INDEX IF NOT EXISTS ix_feedback_sources_cycle ON feedback_sources(cycle_id);
CREATE INDEX IF NOT EXISTS ix_appraisal_participants_cycle ON appraisal_participants(cycle_id);
CREATE INDEX IF NOT EXISTS ix_reviewer_assignments_org ON reviewer_assignments(organization_id);
CREATE INDEX IF NOT EXISTS ix_reviewer_assignments_reviewer ON reviewer_assignments(reviewer_employee_id, status);
CREATE INDEX IF NOT EXISTS ix_feedback_responses_assignment ON feedback_responses(assignment_id);
CREATE INDEX IF NOT EXISTS ix_api_keys_org ON api_keys(organization_id);
CREATE INDEX IF NOT EXISTS ix_webhook_endpoints_org ON webhook_endpoints(organization_id);
CREATE INDEX IF NOT EXISTS ix_webhook_deliveries_endpoint ON webhook_deliveries(endpoint_id);
CREATE INDEX IF NOT EXISTS ix_development_actions_org ON development_actions(organization_id);
CREATE INDEX IF NOT EXISTS ix_development_actions_employee ON development_actions(employee_id);
CREATE INDEX IF NOT EXISTS ix_report_schedules_org ON report_schedules(organization_id);
CREATE INDEX IF NOT EXISTS ix_user_notifications_user ON user_notifications(user_id);
CREATE INDEX IF NOT EXISTS ix_user_notifications_org ON user_notifications(organization_id);
CREATE INDEX IF NOT EXISTS ix_evaluation_links_org_status ON evaluation_links(organization_id, status);
CREATE INDEX IF NOT EXISTS ix_evaluation_links_org_student ON evaluation_links(organization_id, student_id);
CREATE INDEX IF NOT EXISTS ix_external_identity_org_type ON external_identity_maps(organization_id, external_type);
CREATE INDEX IF NOT EXISTS ix_external_identity_employee ON external_identity_maps(employee_id);

-- Bulk Feedback Cycle generation — audit/result runs (additive; no parallel hierarchy).
CREATE TABLE IF NOT EXISTS bulk_generation_runs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL,
  cycle_id            UUID,
  cycle_name          VARCHAR(200),
  initiated_by        UUID,
  initiated_by_name   VARCHAR(200),
  scope_type          VARCHAR(20) NOT NULL,
  scope_id            UUID,
  scope_name          VARCHAR(200),
  status              VARCHAR(20) NOT NULL DEFAULT 'completed',
  config              JSONB,
  summary             JSONB,
  skipped             JSONB,
  failed              JSONB,
  assignments_created INTEGER NOT NULL DEFAULT 0,
  skipped_count       INTEGER NOT NULL DEFAULT 0,
  failed_count        INTEGER NOT NULL DEFAULT 0,
  messages_queued     INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at        TIMESTAMPTZ
);
ALTER TABLE bulk_generation_runs ADD COLUMN IF NOT EXISTS initiated_by_name VARCHAR(200);
ALTER TABLE bulk_generation_runs ADD COLUMN IF NOT EXISTS messages_queued INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS ix_bulk_runs_org_created ON bulk_generation_runs(organization_id, created_at);

-- RBAC: data scope on roles (organization | reporting | own). Additive.
ALTER TABLE roles ADD COLUMN IF NOT EXISTS scope VARCHAR(20) NOT NULL DEFAULT 'organization';

-- 360 Feedback Audit Trail — dedicated, APPEND-ONLY event stream for the feedback
-- lifecycle. References existing employees/cycles/links by id only (no duplicate
-- data); stores action + identifiers, not sensitive feedback content.
CREATE TABLE IF NOT EXISTS feedback_audit_events (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       UUID NOT NULL,
  action                VARCHAR(80) NOT NULL,
  actor_user_id         UUID,
  actor_name            VARCHAR(200),
  actor_role            VARCHAR(200),
  cycle_id              UUID,
  cycle_name            VARCHAR(200),
  evaluatee_employee_id UUID,
  evaluatee_name        VARCHAR(200),
  evaluator_employee_id UUID,
  evaluator_name        VARCHAR(200),
  source_type           VARCHAR(60),
  entity_type           VARCHAR(80) NOT NULL,
  entity_id             VARCHAR(64),
  previous_value        JSONB,
  new_value             JSONB,
  reason                TEXT,
  ip                    VARCHAR(60),
  user_agent            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_feedback_audit_org_created ON feedback_audit_events(organization_id, created_at);
CREATE INDEX IF NOT EXISTS ix_feedback_audit_org_cycle ON feedback_audit_events(organization_id, cycle_id);
CREATE INDEX IF NOT EXISTS ix_feedback_audit_org_evaluatee ON feedback_audit_events(organization_id, evaluatee_employee_id);
CREATE INDEX IF NOT EXISTS ix_feedback_audit_org_action ON feedback_audit_events(organization_id, action);

-- Enforce append-only at the database layer: reject any UPDATE or DELETE so the
-- trail cannot be tampered with, even by an administrator or a direct DB client.
CREATE OR REPLACE FUNCTION feedback_audit_events_no_mutate() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'feedback_audit_events is append-only; % is not permitted', TG_OP;
END;
$fn$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_feedback_audit_events_no_mutate ON feedback_audit_events;
CREATE TRIGGER trg_feedback_audit_events_no_mutate
  BEFORE UPDATE OR DELETE ON feedback_audit_events
  FOR EACH ROW EXECUTE FUNCTION feedback_audit_events_no_mutate();

-- Organization Data Import & Onboarding — parsed dataset + validation + summary per attempt.
CREATE TABLE IF NOT EXISTS organization_import_jobs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL,
  created_by       UUID,
  created_by_name  VARCHAR(200),
  filename         VARCHAR(255),
  status           VARCHAR(20) NOT NULL DEFAULT 'validated',
  mode             VARCHAR(20),
  dataset          JSONB,
  validation       JSONB,
  summary          JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  imported_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_org_import_jobs_org_created ON organization_import_jobs(organization_id, created_at);

-- External HR Integration — synchronization run history (dry-run or live). Additive.
CREATE TABLE IF NOT EXISTS hr_sync_runs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL,
  provider         VARCHAR(60) NOT NULL,
  mode             VARCHAR(20) NOT NULL,
  trigger          VARCHAR(20) NOT NULL DEFAULT 'manual',
  status           VARCHAR(20) NOT NULL DEFAULT 'completed',
  created_by       UUID,
  created_by_name  VARCHAR(200),
  created          INTEGER NOT NULL DEFAULT 0,
  updated          INTEGER NOT NULL DEFAULT 0,
  deactivated      INTEGER NOT NULL DEFAULT 0,
  failed           INTEGER NOT NULL DEFAULT 0,
  warnings         INTEGER NOT NULL DEFAULT 0,
  summary          JSONB,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_hr_sync_runs_org_started ON hr_sync_runs(organization_id, started_at);

-- Student/SIS Integration — persisted per-org SIS dataset (JSON snapshot) served
-- through the existing SisProvider interface. One row per organization. Additive.
CREATE TABLE IF NOT EXISTS sis_datasets (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL UNIQUE,
  provider         VARCHAR(60) NOT NULL,
  snapshot         JSONB NOT NULL,
  student_count    INTEGER NOT NULL DEFAULT 0,
  teacher_count    INTEGER NOT NULL DEFAULT 0,
  updated_by       UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Student/SIS Integration — import/synchronization run history. Mirrors hr_sync_runs. Additive.
CREATE TABLE IF NOT EXISTS sis_sync_runs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL,
  provider         VARCHAR(60) NOT NULL,
  mode             VARCHAR(20) NOT NULL,
  trigger          VARCHAR(20) NOT NULL DEFAULT 'manual',
  status           VARCHAR(20) NOT NULL DEFAULT 'completed',
  created_by       UUID,
  created_by_name  VARCHAR(200),
  created          INTEGER NOT NULL DEFAULT 0,
  updated          INTEGER NOT NULL DEFAULT 0,
  deactivated      INTEGER NOT NULL DEFAULT 0,
  failed           INTEGER NOT NULL DEFAULT 0,
  warnings         INTEGER NOT NULL DEFAULT 0,
  summary          JSONB,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_sis_sync_runs_org_started ON sis_sync_runs(organization_id, started_at);

-- ---------------------------------------------------------------------------
-- Admin password reset + forgot-password flow (additive, idempotent)
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash      varchar(64) NOT NULL UNIQUE,
  expires_at      timestamptz(6) NOT NULL,
  used_at         timestamptz(6),
  created_at      timestamptz(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens(user_id);

-- F-C6: protect a calibrated (HR-overridden) final score from being silently
-- overwritten by automatic recomputation when a late reviewer submits.
ALTER TABLE appraisal_participants ADD COLUMN IF NOT EXISTS calibrated_at timestamptz(6);
ALTER TABLE appraisal_participants ADD COLUMN IF NOT EXISTS computed_score numeric(6,2);

-- ============================================================================
-- Schema version tracking (F-H7)
-- ----------------------------------------------------------------------------
-- The schema is applied by these hand-maintained SQL files rather than a
-- migration tool. Previously nothing recorded WHICH version a given database was
-- at, so after an upgrade neither the customer nor support could verify that the
-- database actually matched the application — an upgrade could only be hoped for,
-- never confirmed. This table records every applied version so `/ready` and the
-- upgrade runbook can assert the database is current.
-- ============================================================================
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     varchar(40) PRIMARY KEY,
  description text,
  applied_at  timestamptz(6) NOT NULL DEFAULT now()
);

-- Bump this (and EXPECTED_SCHEMA_VERSION in the API) whenever the schema changes.
INSERT INTO schema_migrations (version, description)
VALUES ('2026.08.14-01', 'Calibration protection columns (calibrated_at, computed_score) + schema version tracking')
ON CONFLICT (version) DO NOTHING;

-- ============================================================================
-- Quadrant-specific questionnaires.
--
-- A cycle has always had ONE questionnaire shared by every quadrant. This optional
-- column lets a quadrant carry its own instead, so different evaluator groups can be
-- asked different questions - subordinates on delegation, peers on collaboration -
-- while competencies remain in the one global library. A competency referenced by
-- the questionnaires of two or more quadrants is therefore comparable across them,
-- with no separate mapping table and no stored "shared" flag to drift out of date.
--
-- NULL keeps the previous behaviour exactly: fall back to appraisal_cycles.template_id.
-- Every existing row stays NULL, so historical cycles, responses and scores are
-- untouched.
-- ============================================================================
ALTER TABLE feedback_sources ADD COLUMN IF NOT EXISTS template_id UUID REFERENCES questionnaire_templates(id);
CREATE INDEX IF NOT EXISTS ix_feedback_sources_template ON feedback_sources(template_id);

INSERT INTO schema_migrations (version, description)
VALUES ('2026.08.20-01', 'Optional per-quadrant questionnaire: feedback_sources.template_id')
ON CONFLICT (version) DO NOTHING;

-- F-P5: reviewer assignments are queried by cycle on every cycle-detail load, the
-- daily reminder cron and cycle activation, but were only indexed by organization
-- and reviewer — so each of those did a sequential scan of the whole table.
CREATE INDEX IF NOT EXISTS ix_reviewer_assignments_cycle ON reviewer_assignments(cycle_id, status);
CREATE INDEX IF NOT EXISTS ix_appraisal_participants_employee ON appraisal_participants(employee_id);

-- ============================================================================
-- Consolidated parent feedback (one form per student, many teachers).
--
-- The original parent workflow issues ONE secure link per (student, teaching
-- assignment), so a parent with a child taught by five teachers receives five
-- links and submits five times. This adds an alternative mode: one link per
-- student, listing every teacher that child has, with one rating each.
--
-- The consolidated form is a data-entry improvement ONLY. Each rating still
-- becomes an ordinary feedback_responses row against an ordinary external
-- reviewer_assignments row for that teacher's participant, so scoring, the
-- Parents quadrant weight, the anonymity threshold and every report continue to
-- work unchanged and per teacher.
--
-- Every column below is additive and defaults to the previous behaviour, so
-- existing cycles, links, responses, scores and reports are untouched.
-- ============================================================================

-- Per-cycle, per-quadrant switch. NULL = the original one-form-per-teacher mode.
ALTER TABLE feedback_sources ADD COLUMN IF NOT EXISTS parent_mode VARCHAR(24);
ALTER TABLE feedback_sources ADD COLUMN IF NOT EXISTS parent_require_all BOOLEAN NOT NULL DEFAULT FALSE;

-- A consolidated link is student-scoped, so it has no single teacher.
ALTER TABLE evaluation_links ADD COLUMN IF NOT EXISTS mode VARCHAR(24);
ALTER TABLE evaluation_links ALTER COLUMN teacher_id DROP NOT NULL;

-- The teachers one consolidated form covers, snapshotted when the link is generated
-- so the form cannot drift away from the assignments created alongside it.
CREATE TABLE IF NOT EXISTS evaluation_link_targets (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id                UUID NOT NULL REFERENCES evaluation_links(id) ON DELETE CASCADE,
  teacher_id             VARCHAR(64)  NOT NULL,
  teacher_name           VARCHAR(200),
  subject_names          VARCHAR(400),
  teaching_assignment_id VARCHAR(64),
  employee_id            UUID NOT NULL REFERENCES employees(id),
  reviewer_assignment_id UUID REFERENCES reviewer_assignments(id),
  rating_value           NUMERIC(6,2),
  status                 VARCHAR(20) NOT NULL DEFAULT 'pending',
  sort_order             INT NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_evaluation_link_target ON evaluation_link_targets(link_id, teacher_id);
CREATE INDEX IF NOT EXISTS ix_evaluation_link_targets_link ON evaluation_link_targets(link_id);
CREATE INDEX IF NOT EXISTS ix_evaluation_link_targets_assignment ON evaluation_link_targets(reviewer_assignment_id);

INSERT INTO schema_migrations (version, description)
VALUES ('2026.08.21-01', 'Consolidated parent feedback: feedback_sources.parent_mode/parent_require_all, evaluation_links.mode, evaluation_link_targets')
ON CONFLICT (version) DO NOTHING;
