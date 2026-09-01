import { PrismaClient } from '@prisma/client';

/** Permission gating the administrator-only 360 Feedback Audit Trail. */
export const FEEDBACK_AUDIT_PERMISSIONS = {
  read: 'feedback.audit.read',
} as const;

const SEED = [
  { code: FEEDBACK_AUDIT_PERMISSIONS.read, module: 'system', description: 'View and export the 360 Feedback Audit Trail' },
];

export async function seedFeedbackAuditPermissions(prisma: PrismaClient): Promise<void> {
  for (const permission of SEED) {
    await prisma.permission.upsert({
      where: { code: permission.code },
      update: { module: permission.module, description: permission.description },
      create: permission,
    });
  }
}
