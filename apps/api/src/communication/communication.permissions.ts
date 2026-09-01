import { PrismaClient } from '@prisma/client';

export const COMM_PERMISSIONS = {
  read: 'communication.read',
  send: 'communication.send',
  campaignManage: 'communication.campaign.manage',
  manage: 'communication.manage',
} as const;

const SEED = [
  { code: COMM_PERMISSIONS.read, module: 'communication', description: 'View communications' },
  { code: COMM_PERMISSIONS.send, module: 'communication', description: 'Send messages / OTP / short links' },
  { code: COMM_PERMISSIONS.campaignManage, module: 'communication', description: 'Manage campaigns' },
  { code: COMM_PERMISSIONS.manage, module: 'communication', description: 'Manage templates, providers, branding & channels' },
];

export async function seedCommunicationPermissions(prisma: PrismaClient): Promise<void> {
  for (const permission of SEED) {
    await prisma.permission.upsert({
      where: { code: permission.code },
      update: { module: permission.module, description: permission.description },
      create: permission,
    });
  }
}
