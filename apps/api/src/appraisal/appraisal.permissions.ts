import { PrismaClient } from '@prisma/client';

export const APPRAISAL_PERMISSIONS = {
  read: 'appraisal.read',
  cycleManage: 'appraisal.cycle.manage',
  assignManage: 'appraisal.assignment.manage',
  calibrate: 'appraisal.calibrate',
  submitFeedback: 'appraisal.feedback.submit',
} as const;

const SEED = [
  { code: APPRAISAL_PERMISSIONS.read, module: 'appraisal', description: 'View appraisals' },
  { code: APPRAISAL_PERMISSIONS.cycleManage, module: 'appraisal', description: 'Manage cycles, sources, participants' },
  { code: APPRAISAL_PERMISSIONS.assignManage, module: 'appraisal', description: 'Assign reviewers' },
  { code: APPRAISAL_PERMISSIONS.calibrate, module: 'appraisal', description: 'Calibrate final scores' },
  { code: APPRAISAL_PERMISSIONS.submitFeedback, module: 'appraisal', description: 'Submit feedback for assigned reviews' },
];

export async function seedAppraisalPermissions(prisma: PrismaClient): Promise<void> {
  for (const permission of SEED) {
    await prisma.permission.upsert({
      where: { code: permission.code },
      update: { module: permission.module, description: permission.description },
      create: permission,
    });
  }
}
