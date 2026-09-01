import { PrismaClient } from '@prisma/client';

export const REPORTS_PERMISSIONS = {
  read: 'reports.read',
  manage: 'reports.manage',
  executive: 'reports.executive',
  dashboardConfigure: 'reports.dashboard.configure',
  /**
   * See rater-source breakdowns that sit below the minimum-response threshold.
   *
   * The threshold exists so an APPRAISEE cannot infer who said what. It was being
   * applied to every caller, including HR and the employee's own manager — the very
   * people expected to audit whether a cycle ran properly. A Line Manager quadrant
   * has one reviewer by definition and was therefore permanently confidential to
   * everyone. Holding this permission lifts the suppression for that caller only.
   * It does not change stored data, the threshold itself, what anyone else sees, or
   * the score calculation — and it still exposes NO reviewer identity.
   */
  confidentialView: 'reports.confidential.view',
} as const;

const SEED = [
  { code: REPORTS_PERMISSIONS.read, module: 'reports', description: 'View reports and dashboards' },
  { code: REPORTS_PERMISSIONS.manage, module: 'reports', description: 'Manage scheduled report digests' },
  { code: REPORTS_PERMISSIONS.executive, module: 'reports', description: 'View the executive dashboard' },
  { code: REPORTS_PERMISSIONS.dashboardConfigure, module: 'reports', description: 'Customize the Executive/HR dashboard layout' },
  { code: REPORTS_PERMISSIONS.confidentialView, module: 'reports', description: 'See quadrant scores held below the minimum-response threshold' },
];

export async function seedReportsPermissions(prisma: PrismaClient): Promise<void> {
  for (const permission of SEED) {
    await prisma.permission.upsert({
      where: { code: permission.code },
      update: { module: permission.module, description: permission.description },
      create: permission,
    });
  }
}
