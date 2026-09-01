import { PrismaClient } from '@prisma/client';

export type RoleScope = 'organization' | 'reporting' | 'own';

export interface SystemRoleDef {
  name: string;
  description: string;
  scope: RoleScope;
  /** Explicit permission codes; `'*'` means "every permission" (Super Admin). */
  permissions: string[] | '*';
}

/**
 * The five essential predefined roles. Fixed permission sets (see RBAC decision):
 * admins ASSIGN these roles to users; they don't edit each role's permissions.
 * Codes reference the existing per-module permission catalog — no parallel scheme.
 */
export const SYSTEM_ROLES: SystemRoleDef[] = [
  {
    name: 'Super Admin',
    description: 'Full, unrestricted access: system configuration, user & role management, security and integrations.',
    scope: 'organization',
    permissions: '*',
  },
  {
    name: 'HR/Admin',
    description: 'Manage employees, feedback cycles, questionnaires/competencies/rubrics, evaluator assignments, communication; access HR dashboards & reports.',
    scope: 'organization',
    permissions: [
      // Organization / employees
      'organization.read', 'organization.employee.manage', 'organization.department.manage', 'organization.designation.manage', 'organization.campus.manage',
      // Organization data import & onboarding + external HR + student/SIS integration
      'organization.import.manage', 'organization.hr.manage', 'organization.sis.manage',
      // Feedback cycles / evaluations / bulk generation (bulk is gated by appraisal.cycle.manage)
      'appraisal.read', 'appraisal.cycle.manage', 'appraisal.assignment.manage', 'appraisal.calibrate', 'appraisal.feedback.submit',
      // Questionnaires
      'questionnaire.read', 'questionnaire.question.manage', 'questionnaire.template.manage', 'questionnaire.rubric.manage',
      // Competencies
      'competency.read', 'competency.create', 'competency.update', 'competency.archive',
      'competency.category.read', 'competency.category.create', 'competency.category.update', 'competency.category.delete',
      'competency.version.manage', 'competency.indicator.read', 'competency.indicator.manage',
      // Communication
      'communication.read', 'communication.manage', 'communication.send', 'communication.campaign.manage',
      // Dashboards & reports
      'reports.read', 'reports.executive', 'reports.manage', 'reports.dashboard.configure', 'ai.read',
      // Sees quadrant scores held below the minimum-response threshold. HR runs the
      // programme and has to be able to audit a cycle; the threshold protects the
      // appraisee from inferring who said what — not HR from its own programme data.
      'reports.confidential.view',
      // Development, external/parent evaluations, SIS, identity mapping
      'development.read', 'development.manage', 'external.evaluation.manage', 'identity.manage', 'sis.read',
      // Cycle-related configuration (rating scales, feature-flag visibility) — NOT full system settings
      'configuration.read', 'configuration.rating_scale.read', 'configuration.rating_scale.manage', 'configuration.feature_flag.read',
      // Approvals
      'workflow.read', 'workflow.act',
    ],
  },
  {
    name: 'Manager',
    description: 'View permitted information for their reporting hierarchy, complete assigned evaluations, and monitor permitted evaluation progress.',
    scope: 'reporting',
    permissions: [
      'organization.read',
      'appraisal.read', 'appraisal.feedback.submit',
      'reports.read',
      // Same lift as HR/Admin — but a Manager's data scope is 'reporting', so it can
      // only ever apply to their own reporting line. Revoke it in Access Control if
      // your policy is that managers must not see single-reviewer quadrants.
      'reports.confidential.view',
      'development.read', 'development.manage',
      'workflow.read', 'workflow.act',
      'competency.read', 'questionnaire.read',
    ],
  },
  {
    name: 'Employee',
    description: 'Access own profile, view and complete assigned evaluations, and view feedback/results permitted by the system.',
    scope: 'own',
    permissions: [
      'organization.read',
      'appraisal.read', 'appraisal.feedback.submit',
      'reports.read',
      'development.read',
    ],
  },
  {
    // A read-only observer of AGGREGATE dashboards. Deliberately does NOT hold
    // 'reports.executive' or 'ai.read' (F-C8): those expose named per-person results
    // — the nine-box talent grid, at-risk lists, and AI insights containing verbatim
    // anonymous comments — and 'reports.executive' additionally bypasses the
    // results-release gate. A read-only role must not see individual 360 feedback
    // that HR has not released. Grant HR/Admin instead where that access is needed.
    name: 'Viewer',
    description: 'Read-only access to aggregate dashboards and reports. Cannot see individual 360 results or modify system data.',
    scope: 'organization',
    permissions: [
      'organization.read', 'appraisal.read',
      'competency.read', 'competency.category.read', 'competency.indicator.read',
      'questionnaire.read', 'communication.read',
      'reports.read',
      'development.read', 'workflow.read', 'sis.read',
      'configuration.rating_scale.read', 'configuration.feature_flag.read',
    ],
  },
];

export const SUPER_ADMIN_ROLE = 'Super Admin';

/**
 * Role granted automatically to newly provisioned people (UI create + bulk import).
 * Without a role a user can authenticate but is denied every endpoint — they cannot
 * see their review queue or submit feedback, which silently breaks the evaluator
 * workflow for everyone onboarded after bootstrap (F-C1).
 */
export const DEFAULT_EMPLOYEE_ROLE = 'Employee';

/**
 * Idempotently create/refresh the five system roles for an organization and sync
 * their permission grants. Safe to run repeatedly (e.g. after new modules add codes).
 */
export async function seedSystemRoles(prisma: PrismaClient, organizationId: string): Promise<void> {
  const allPermissions = await prisma.permission.findMany({ select: { code: true } });
  const allCodes = allPermissions.map((p) => p.code);

  for (const def of SYSTEM_ROLES) {
    const role =
      (await prisma.role.findFirst({ where: { organizationId, name: def.name } })) ??
      (await prisma.role.create({ data: { organizationId, name: def.name, description: def.description, isSystem: true, scope: def.scope } }));

    // Keep description/scope/isSystem current.
    await prisma.role.update({ where: { id: role.id }, data: { description: def.description, scope: def.scope, isSystem: true } });

    const wanted = new Set(def.permissions === '*' ? allCodes : def.permissions.filter((c) => allCodes.includes(c)));
    const existing = await prisma.rolePermission.findMany({ where: { roleId: role.id }, select: { permissionCode: true } });
    const have = new Set(existing.map((e) => e.permissionCode));

    const toAdd = [...wanted].filter((c) => !have.has(c));
    const toRemove = [...have].filter((c) => !wanted.has(c));
    if (toAdd.length) {
      await prisma.rolePermission.createMany({ data: toAdd.map((permissionCode) => ({ roleId: role.id, permissionCode })), skipDuplicates: true });
    }
    if (toRemove.length) {
      await prisma.rolePermission.deleteMany({ where: { roleId: role.id, permissionCode: { in: toRemove } } });
    }
  }
}
