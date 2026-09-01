import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

export function nkey(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

export interface ExistingData {
  campusesByName: Map<string, { id: string; name: string }>;
  departmentsByName: Map<string, { id: string; name: string; parentId: string | null; campusId: string | null }>;
  designationsByName: Map<string, { id: string; name: string }>;
  employeesByCode: Map<string, { id: string; employeeCode: string; lineManagerId: string | null; status: string; userId: string }>;
  emailsInUse: Map<string, string>; // lower(email) -> userId
  categoriesByName: Map<string, { id: string }>;
  competenciesByName: Set<string>;
  activeCycleCount: number;
}

/** Loads the tenant's current org-structural data, keyed by the business keys the
 *  importer resolves references against (campus/dept/designation name, employeeCode, email). */
@Injectable()
export class ResolverService {
  constructor(private readonly prisma: PrismaService) {}

  async loadExisting(orgId: string): Promise<ExistingData> {
    const [campuses, departments, designations, employees, users, categories, competencies, activeCycleCount] = await Promise.all([
      this.prisma.organization.findMany({ where: { parentOrgId: orgId, orgType: 'campus', deletedAt: null }, select: { id: true, name: true } }),
      this.prisma.department.findMany({ where: { organizationId: orgId, deletedAt: null }, select: { id: true, name: true, parentId: true, campusId: true } }),
      this.prisma.designation.findMany({ where: { organizationId: orgId, deletedAt: null }, select: { id: true, name: true } }),
      this.prisma.employee.findMany({ where: { organizationId: orgId, deletedAt: null }, select: { id: true, employeeCode: true, lineManagerId: true, status: true, userId: true } }),
      this.prisma.user.findMany({ where: { organizationId: orgId, deletedAt: null }, select: { id: true, email: true } }),
      this.prisma.competencyCategory.findMany({ where: { organizationId: orgId }, select: { id: true, name: true } }),
      this.prisma.competency.findMany({ where: { organizationId: orgId, deletedAt: null }, select: { name: true } }),
      this.prisma.appraisalCycle.count({ where: { organizationId: orgId, deletedAt: null, status: { in: ['active', 'closed'] } } }),
    ]);
    return {
      campusesByName: new Map(campuses.map((c) => [nkey(c.name), c])),
      departmentsByName: new Map(departments.map((d) => [nkey(d.name), d])),
      designationsByName: new Map(designations.map((d) => [nkey(d.name), d])),
      employeesByCode: new Map(employees.map((e) => [e.employeeCode.trim(), e])),
      emailsInUse: new Map(users.map((u) => [u.email.toLowerCase(), u.id])),
      categoriesByName: new Map(categories.map((c) => [nkey(c.name), c])),
      competenciesByName: new Set(competencies.map((c) => nkey(c.name))),
      activeCycleCount,
    };
  }
}
