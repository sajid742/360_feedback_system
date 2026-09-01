import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../common/prisma/prisma.service';
import { nkey, ResolverService } from './resolver.service';
import { DEFAULT_EMPLOYEE_ROLE } from '../../rbac/system-roles';
import type { EntitySummary, ImportDataset, ImportEntity, ImportMode, ImportSummary, ValidationIssue } from '../org-import.types';
import { LicenseService } from '../../license/license.service';

export interface ImportOptions {
  mode: ImportMode;
  confirmDestructive?: boolean;
  /** Applied to imported employees that have no password column (login stays disabled if unset). */
  defaultPassword?: string;
}

const DEFAULT_LEVELS = [
  { level: 1, name: 'Beginner' }, { level: 2, name: 'Developing' }, { level: 3, name: 'Proficient' },
  { level: 4, name: 'Advanced' }, { level: 5, name: 'Expert' },
];

function kebab(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

/** Executes a validated import atomically per the chosen mode. Only ever touches
 *  org-structural data (campuses/departments/designations/employees/competencies);
 *  never RBAC, settings, configuration, rating scales, the root org or the admin. */
@Injectable()
export class ImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: ResolverService,
    private readonly license: LicenseService,
  ) {}

  async run(orgId: string, actorUserId: string | null, dataset: ImportDataset, opts: ImportOptions): Promise<ImportSummary> {
    const destructive = opts.mode === 'replace' || opts.mode === 'reset';
    if (destructive && !opts.confirmDestructive) {
      throw new BadRequestException('This is a destructive operation. Re-confirm with the destructive acknowledgement to proceed.');
    }
    if (dataset.employees.length > 5000) throw new BadRequestException('Employee import is capped at 5000 rows per file.');

    /*
     * LICENCE CHECK, deliberately here: before the transaction, before any hashing, and
     * counted against the WHOLE file rather than row by row. A per-row check would import
     * up to the limit and then stop, leaving a half-loaded organisation that looks
     * successful — the one outcome a bulk import must never produce.
     *
     * A destructive import replaces the existing people, so what it adds is the file's
     * own size; an additive one adds to what is already there.
     */
    await this.license.assertCanAddEmployees(orgId, destructive ? dataset.employees.length : dataset.employees.length);

    const root = await this.prisma.organization.findUnique({ where: { id: orgId }, select: { slug: true } });
    const tenantSlug = root?.slug ?? 'org';

    // Precompute password hashes OUTSIDE the transaction (bcrypt is slow/async).
    const passwordHash = new Map<string, string>();
    for (const e of dataset.employees) {
      const pw = e.password || opts.defaultPassword;
      if (pw) passwordHash.set(e.employeeCode.trim(), await bcrypt.hash(pw, 10));
    }
    // Imported people need a role to do anything at all (F-C1). Resolved once,
    // outside the transaction; if the role is missing we still import (the admin
    // can assign roles later) rather than failing the whole onboarding.
    const defaultRole = await this.prisma.role.findFirst({
      where: { organizationId: orgId, name: DEFAULT_EMPLOYEE_ROLE },
      select: { id: true },
    });
    const defaultRoleId = defaultRole?.id ?? null;
    // Reserve globally-unique campus slugs before the transaction.
    const usedSlugs = new Set((await this.prisma.organization.findMany({ select: { slug: true } })).map((o) => o.slug));

    const summary: Record<ImportEntity, EntitySummary> = {
      organization: this.blank('organization'), campuses: this.blank('campuses'), departments: this.blank('departments'),
      designations: this.blank('designations'), employees: this.blank('employees'), competencies: this.blank('competencies'),
    };
    const warnings: ValidationIssue[] = [];
    const failures: ValidationIssue[] = [];

    await this.prisma.$transaction(async (tx) => {
      if (destructive) await this.wipe(tx, orgId);

      // Fresh existing maps (empty after a wipe).
      const ex = destructive ? await this.emptyExisting() : await this.resolver.loadExisting(orgId);
      const wipe = destructive;

      // Live id maps (existing + newly created), keyed by business key.
      const campusId = new Map<string, string>([...ex.campusesByName].map(([k, v]) => [k, v.id]));
      const deptId = new Map<string, string>([...ex.departmentsByName].map(([k, v]) => [k, v.id]));
      const desigId = new Map<string, string>([...ex.designationsByName].map(([k, v]) => [k, v.id]));
      const empId = new Map<string, string>([...ex.employeesByCode].map(([k, v]) => [k, v.id]));
      const categoryId = new Map<string, string>([...ex.categoriesByName].map(([k, v]) => [k, v.id]));

      if (opts.mode === 'reset') return; // wipe-only

      // 1) Organization metadata (name/status) — never the slug/identity.
      if (dataset.organization?.name) {
        await tx.organization.update({ where: { id: orgId }, data: { name: dataset.organization.name } });
        summary.organization.processed = summary.organization.updated = 1;
      }

      // 2) Campuses / Institutes (org_type='campus' under root).
      for (const c of dataset.campuses) {
        const key = nkey(c.name);
        summary.campuses.processed++;
        const exists = !wipe && campusId.has(key);
        if (exists && opts.mode === 'skip') { summary.campuses.skipped++; continue; }
        try {
          if (exists) {
            await tx.organization.update({ where: { id: campusId.get(key)! }, data: { name: c.name, status: c.status ?? undefined } });
            summary.campuses.updated++;
          } else {
            const slug = this.uniqueSlug(c.slug ? kebab(c.slug) : `${tenantSlug}-${kebab(c.name)}`, usedSlugs);
            const row = await tx.organization.create({ data: { name: c.name, slug, orgType: 'campus', parentOrgId: orgId, status: c.status ?? 'active' } });
            campusId.set(key, row.id); summary.campuses.created++;
          }
        } catch (e) { summary.campuses.failed++; failures.push({ entity: 'campuses', row: c._row, field: null, key: c.name, severity: 'error', message: (e as Error).message }); }
      }

      // 3) Designations (create, then resolve promotion path).
      for (const d of dataset.designations) {
        const key = nkey(d.name);
        summary.designations.processed++;
        const exists = !wipe && desigId.has(key);
        if (exists && opts.mode === 'skip') { summary.designations.skipped++; continue; }
        try {
          if (exists) { await tx.designation.update({ where: { id: desigId.get(key)! }, data: { level: d.level ?? undefined, updatedBy: actorUserId } }); summary.designations.updated++; }
          else { const row = await tx.designation.create({ data: { organizationId: orgId, name: d.name, level: d.level ?? 0, createdBy: actorUserId, updatedBy: actorUserId } }); desigId.set(key, row.id); summary.designations.created++; }
        } catch (e) { summary.designations.failed++; failures.push({ entity: 'designations', row: d._row, field: null, key: d.name, severity: 'error', message: (e as Error).message }); }
      }
      for (const d of dataset.designations) {
        if (!d.promotesTo) continue;
        const id = desigId.get(nkey(d.name)); const to = desigId.get(nkey(d.promotesTo));
        if (id && to) await tx.designation.update({ where: { id }, data: { promotionToId: to } });
      }

      // 4) Departments (create, then resolve parent).
      for (const d of dataset.departments) {
        const key = nkey(d.name);
        summary.departments.processed++;
        const exists = !wipe && deptId.has(key);
        const campus = d.campus ? campusId.get(nkey(d.campus)) ?? null : null;
        if (exists && opts.mode === 'skip') { summary.departments.skipped++; continue; }
        try {
          if (exists) { await tx.department.update({ where: { id: deptId.get(key)! }, data: { campusId: campus, unitType: d.unitType ?? undefined, updatedBy: actorUserId } }); summary.departments.updated++; }
          else { const row = await tx.department.create({ data: { organizationId: orgId, name: d.name, campusId: campus, unitType: d.unitType ?? 'department', createdBy: actorUserId, updatedBy: actorUserId } }); deptId.set(key, row.id); summary.departments.created++; }
        } catch (e) { summary.departments.failed++; failures.push({ entity: 'departments', row: d._row, field: null, key: d.name, severity: 'error', message: (e as Error).message }); }
      }
      for (const d of dataset.departments) {
        if (!d.parent) continue;
        const id = deptId.get(nkey(d.name)); const parent = deptId.get(nkey(d.parent));
        if (id && parent && id !== parent) await tx.department.update({ where: { id }, data: { parentId: parent } });
      }

      // 5) Competencies (category + competency + v1 draft version). Existing skipped.
      for (const c of dataset.competencies) {
        summary.competencies.processed++;
        if (!wipe && ex.competenciesByName.has(nkey(c.name))) { summary.competencies.skipped++; continue; }
        try {
          let catId = categoryId.get(nkey(c.category));
          if (!catId) { const cat = await tx.competencyCategory.create({ data: { organizationId: orgId, name: c.category } }); catId = cat.id; categoryId.set(nkey(c.category), catId); }
          const comp = await tx.competency.create({ data: { organizationId: orgId, categoryId: catId, name: c.name, description: c.description ?? null, createdBy: actorUserId, updatedBy: actorUserId } });
          await tx.competencyVersion.create({ data: { organizationId: orgId, competencyId: comp.id, versionLabel: 'v1', status: 'draft', createdBy: actorUserId, updatedBy: actorUserId, proficiencyLevels: { create: DEFAULT_LEVELS.map((l) => ({ organizationId: orgId, level: l.level, name: l.name })) } } });
          summary.competencies.created++;
        } catch (e) { summary.competencies.failed++; failures.push({ entity: 'competencies', row: c._row, field: null, key: c.name, severity: 'error', message: (e as Error).message }); }
      }

      // 6) Employees — create user + employee (no manager yet).
      for (const e of dataset.employees) {
        const code = e.employeeCode.trim();
        summary.employees.processed++;
        const exists = !wipe && empId.has(code);
        const dept = e.department ? deptId.get(nkey(e.department)) ?? null : null;
        const desig = e.designation ? desigId.get(nkey(e.designation)) ?? null : null;
        const camp = e.campus ? campusId.get(nkey(e.campus)) ?? null : null;
        const status = e.status && ['inactive', 'terminated', 'disabled', 'left', 'resigned'].includes(nkey(e.status)) ? 'inactive' : 'active';
        if (exists && opts.mode === 'skip') { summary.employees.skipped++; continue; }
        try {
          if (exists) {
            const cur = await tx.employee.findUnique({ where: { id: empId.get(code)! }, select: { userId: true } });
            await tx.employee.update({ where: { id: empId.get(code)! }, data: { departmentId: dept, designationId: desig, campusId: camp, status, updatedBy: actorUserId } });
            if (cur && (e.fullName || e.email)) await tx.user.update({ where: { id: cur.userId }, data: { fullName: e.fullName ?? undefined, email: e.email ? e.email.toLowerCase() : undefined } });
            summary.employees.updated++;
          } else {
            // Grant the default role so the person can actually sign in and act,
            // and force a change of the shared import password at first login (F-C1).
            const importedHash = passwordHash.get(code) ?? null;
            const newUser = await tx.user.create({ data: { organizationId: orgId, email: (e.email ?? `${code}@import.local`).toLowerCase(), fullName: e.fullName ?? code, passwordHash: importedHash, mustChangePassword: importedHash !== null, ...(defaultRoleId ? { userRoles: { create: { roleId: defaultRoleId } } } : {}) } });
            const row = await tx.employee.create({ data: { organizationId: orgId, userId: newUser.id, employeeCode: code, departmentId: dept, designationId: desig, campusId: camp, joinDate: this.date(e.joinDate), status, createdBy: actorUserId, updatedBy: actorUserId } });
            empId.set(code, row.id); summary.employees.created++;
          }
        } catch (e2) { summary.employees.failed++; failures.push({ entity: 'employees', row: e._row, field: null, key: code, severity: 'error', message: (e2 as Error).message }); }
      }
      // 6b) Resolve Reporting To (second pass) once all employees exist.
      for (const e of dataset.employees) {
        if (!e.managerCode) continue;
        const id = empId.get(e.employeeCode.trim()); const mgr = empId.get(e.managerCode.trim());
        if (id && mgr && id !== mgr) await tx.employee.update({ where: { id }, data: { lineManagerId: mgr } });
      }
    }, { timeout: 120000 });

    return { perEntity: Object.values(summary), warnings, failures, mode: opts.mode };
  }

  /** Destructive wipe of org-structural data ONLY. Never RBAC/settings/config/root org. */
  private async wipe(tx: Prisma.TransactionClient, orgId: string): Promise<void> {
    const now = new Date();
    // Employees: soft-delete + disable their user logins + revoke tokens (but keep the admin/non-employee users).
    const emps = await tx.employee.findMany({ where: { organizationId: orgId, deletedAt: null }, select: { id: true, userId: true } });
    const empUserIds = emps.map((e) => e.userId);
    await tx.employee.updateMany({ where: { organizationId: orgId, deletedAt: null }, data: { deletedAt: now, status: 'terminated', lineManagerId: null } });
    if (empUserIds.length) {
      await tx.user.updateMany({ where: { id: { in: empUserIds } }, data: { status: 'disabled', deletedAt: now } });
      await tx.refreshToken.updateMany({ where: { userId: { in: empUserIds }, revokedAt: null }, data: { revokedAt: now } });
    }
    await tx.department.updateMany({ where: { organizationId: orgId, deletedAt: null }, data: { deletedAt: now, parentId: null } });
    await tx.designation.updateMany({ where: { organizationId: orgId, deletedAt: null }, data: { deletedAt: now, promotionToId: null } });
    await tx.organization.updateMany({ where: { parentOrgId: orgId, orgType: 'campus', deletedAt: null }, data: { deletedAt: now } });
    // Competencies: soft-delete competencies + deactivate their categories (versions cascade with the competency).
    await tx.competency.updateMany({ where: { organizationId: orgId, deletedAt: null }, data: { deletedAt: now } });
    await tx.competencyCategory.updateMany({ where: { organizationId: orgId }, data: { isActive: false } });
  }

  private async emptyExisting() {
    return {
      campusesByName: new Map(), departmentsByName: new Map(), designationsByName: new Map(),
      employeesByCode: new Map(), emailsInUse: new Map(), categoriesByName: new Map(),
      competenciesByName: new Set<string>(), activeCycleCount: 0,
    } as Awaited<ReturnType<ResolverService['loadExisting']>>;
  }

  private uniqueSlug(base: string, used: Set<string>): string {
    let slug = base, i = 2;
    while (used.has(slug)) slug = `${base}-${i++}`;
    used.add(slug);
    return slug;
  }

  private date(s?: string): Date | null {
    if (!s) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  private blank(entity: ImportEntity): EntitySummary {
    return { entity, processed: 0, created: 0, updated: 0, skipped: 0, failed: 0 };
  }
}
