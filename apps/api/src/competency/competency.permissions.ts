/**
 * Competency permission codes. These are DATA — seeded as rows in the
 * `permissions` table and granted to roles via `role_permissions`. Controllers
 * reference the codes; no role NAME is ever hardcoded (PROMPTS.md / handoff §6).
 */
export const COMPETENCY_PERMISSIONS = {
  categoryRead: 'competency.category.read',
  categoryCreate: 'competency.category.create',
  categoryUpdate: 'competency.category.update',
  categoryDelete: 'competency.category.delete',
  read: 'competency.read',
  create: 'competency.create',
  update: 'competency.update',
  archive: 'competency.archive',
  versionManage: 'competency.version.manage',
  indicatorRead: 'competency.indicator.read',
  indicatorManage: 'competency.indicator.manage',
} as const;

export interface PermissionSeed {
  code: string;
  module: string;
  description: string;
}

export const COMPETENCY_PERMISSION_SEED: PermissionSeed[] = [
  { code: COMPETENCY_PERMISSIONS.categoryRead, module: 'competency', description: 'View competency categories' },
  { code: COMPETENCY_PERMISSIONS.categoryCreate, module: 'competency', description: 'Create competency categories' },
  { code: COMPETENCY_PERMISSIONS.categoryUpdate, module: 'competency', description: 'Update competency categories' },
  { code: COMPETENCY_PERMISSIONS.categoryDelete, module: 'competency', description: 'Delete competency categories' },
  { code: COMPETENCY_PERMISSIONS.read, module: 'competency', description: 'View competencies' },
  { code: COMPETENCY_PERMISSIONS.create, module: 'competency', description: 'Create competencies' },
  { code: COMPETENCY_PERMISSIONS.update, module: 'competency', description: 'Update competencies' },
  { code: COMPETENCY_PERMISSIONS.archive, module: 'competency', description: 'Archive competencies' },
  { code: COMPETENCY_PERMISSIONS.versionManage, module: 'competency', description: 'Clone and activate competency versions' },
  { code: COMPETENCY_PERMISSIONS.indicatorRead, module: 'competency', description: 'View behaviour indicators' },
  { code: COMPETENCY_PERMISSIONS.indicatorManage, module: 'competency', description: 'Manage behaviour indicators' },
];
