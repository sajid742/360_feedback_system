import { PrismaClient } from '@prisma/client';

export const ORG_PERMISSIONS = {
  read: 'organization.read',
  departmentManage: 'organization.department.manage',
  designationManage: 'organization.designation.manage',
  employeeManage: 'organization.employee.manage',
  campusManage: 'organization.campus.manage',
} as const;

const SEED = [
  { code: ORG_PERMISSIONS.read, module: 'organization', description: 'View organization structure' },
  { code: ORG_PERMISSIONS.departmentManage, module: 'organization', description: 'Manage departments' },
  { code: ORG_PERMISSIONS.designationManage, module: 'organization', description: 'Manage designations' },
  { code: ORG_PERMISSIONS.employeeManage, module: 'organization', description: 'Manage employees' },
  { code: ORG_PERMISSIONS.campusManage, module: 'organization', description: 'Manage campuses' },
];

export async function seedOrganizationPermissions(prisma: PrismaClient): Promise<void> {
  for (const permission of SEED) {
    await prisma.permission.upsert({
      where: { code: permission.code },
      update: { module: permission.module, description: permission.description },
      create: permission,
    });
  }
}
