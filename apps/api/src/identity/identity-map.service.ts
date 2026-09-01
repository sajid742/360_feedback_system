import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type { AuthUser } from '../common/auth/current-user';
import { SIS_PROVIDER, type SisProvider } from '../sis/sis-provider.interface';
import type { UpsertIdentityMapDto } from './identity.dto';

/**
 * Explicit external-identity mapping. Each external actor (SIS teacher, and later
 * student/alumni/…) is linked to exactly one 360 Employee by an admin-maintained
 * record keyed on a stable external id — never on names. Resolution reads ONLY
 * this table, so a real production SIS drops in unchanged: sync its identifiers
 * into this map and every downstream flow (feedback, scoring, reporting) follows.
 */
@Injectable()
export class IdentityMapService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(SIS_PROVIDER) private readonly sis: SisProvider,
  ) {}

  /** The employee an external actor maps to, or null when unmapped/inactive. */
  async resolveEmployee(orgId: string, externalType: string, externalId: string): Promise<string | null> {
    const row = await this.prisma.externalIdentityMap.findFirst({
      where: { organizationId: orgId, externalType, externalId, active: true },
      select: { employeeId: true },
    });
    return row?.employeeId ?? null;
  }

  /**
   * Identity maps, newest first (F25). Bounded: a synced roster produces one row per
   * external actor, so this grows with the customer's school/HR system, not with
   * anything an administrator typed.
   */
  async list(orgId: string, externalType?: string, limit = 500): Promise<Record<string, unknown>[]> {
    const take = Math.min(2000, Math.max(1, Number(limit) || 500));
    const rows = await this.prisma.externalIdentityMap.findMany({
      where: { organizationId: orgId, ...(externalType ? { externalType } : {}) },
      orderBy: { createdAt: 'desc' },
      take,
    });
    return rows.map((r) => ({
      id: r.id,
      externalType: r.externalType,
      externalId: r.externalId,
      externalCode: r.externalCode,
      matchKey: r.matchKey,
      employeeId: r.employeeId,
      active: r.active,
    }));
  }

  async upsert(user: AuthUser, dto: UpsertIdentityMapDto): Promise<Record<string, unknown>> {
    // Prevent duplicate mappings: an employee may be mapped to at most one external
    // actor of a given type. (A teacher already maps to one employee via the unique
    // scope below; this guards the reverse — two teachers pointing at one employee.)
    if (dto.active !== false) {
      const clash = await this.prisma.externalIdentityMap.findFirst({
        where: {
          organizationId: user.organizationId,
          externalType: dto.externalType,
          employeeId: dto.employeeId,
          active: true,
          NOT: { externalId: dto.externalId },
        },
        select: { externalCode: true, externalId: true },
      });
      if (clash) {
        throw new ConflictException(
          `That employee is already mapped to another ${dto.externalType}${clash.externalCode ? ` (code ${clash.externalCode})` : ''}. Clear that mapping first.`,
        );
      }
    }
    const row = await this.prisma.externalIdentityMap.upsert({
      where: {
        identity_scope: { organizationId: user.organizationId, externalType: dto.externalType, externalId: dto.externalId },
      },
      update: {
        externalCode: dto.externalCode ?? null,
        matchKey: dto.matchKey ?? 'employee_code',
        employeeId: dto.employeeId,
        active: dto.active ?? true,
      },
      create: {
        organizationId: user.organizationId,
        externalType: dto.externalType,
        externalId: dto.externalId,
        externalCode: dto.externalCode ?? null,
        matchKey: dto.matchKey ?? 'employee_code',
        employeeId: dto.employeeId,
        active: dto.active ?? true,
        createdBy: user.userId,
      },
    });
    return { id: row.id, externalType: row.externalType, externalId: row.externalId, employeeId: row.employeeId, active: row.active };
  }

  async remove(orgId: string, id: string): Promise<{ id: string }> {
    await this.prisma.externalIdentityMap.deleteMany({ where: { id, organizationId: orgId } });
    return { id };
  }

  /** Remove a mapping by its external identity (used by the mapping UI's "clear"). */
  async unmap(orgId: string, externalType: string, externalId: string): Promise<{ removed: number }> {
    const res = await this.prisma.externalIdentityMap.deleteMany({ where: { organizationId: orgId, externalType, externalId } });
    return { removed: res.count };
  }

  /** Lightweight employee directory for the mapping picker. */
  /**
   * Employees available for mapping (F25).
   *
   * This used to return every employee behind a silent `take: 2000`, so in an
   * organisation larger than that the remaining people simply could not be mapped
   * and nothing said why. It is now searchable and reports whether the list was
   * truncated, so the administrator can always reach the person they want.
   */
  async employees(
    orgId: string,
    opts: { search?: string; limit?: number } = {},
  ): Promise<{ items: { id: string; employeeCode: string; name: string }[]; total: number; truncated: boolean }> {
    const take = Math.min(1000, Math.max(1, Number(opts.limit) || 500));
    const search = opts.search?.trim();
    const where = {
      organizationId: orgId,
      deletedAt: null,
      ...(search
        ? {
            OR: [
              { employeeCode: { contains: search, mode: 'insensitive' as const } },
              { user: { fullName: { contains: search, mode: 'insensitive' as const } } },
              { user: { email: { contains: search, mode: 'insensitive' as const } } },
            ],
          }
        : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.employee.findMany({
        where,
        select: { id: true, employeeCode: true, user: { select: { fullName: true, email: true } } },
        orderBy: { employeeCode: 'asc' },
        take,
      }),
      this.prisma.employee.count({ where }),
    ]);
    return {
      items: rows.map((r) => ({ id: r.id, employeeCode: r.employeeCode, name: r.user.fullName ?? r.user.email ?? r.employeeCode })),
      total,
      truncated: total > rows.length,
    };
  }

  /**
   * SIS teachers with their current mapping and a *suggested* employee matched by
   * employee code (a convenience only — the admin still confirms; resolution never
   * relies on the code match itself).
   */
  async suggestTeachers(orgId: string): Promise<Record<string, unknown>[]> {
    const [teachers, maps] = await Promise.all([
      this.sis.getTeachers().catch(() => []),
      this.prisma.externalIdentityMap.findMany({ where: { organizationId: orgId, externalType: 'teacher' } }),
    ]);
    // Load only the employees this screen actually references — those whose code
    // matches a teacher, plus those already mapped — instead of the whole directory
    // (F25). The old full load also silently truncated at 2,000, which made mapped
    // names disappear in a large organisation.
    const wantedCodes = teachers.map((t) => t.employeeCode).filter((c): c is string => Boolean(c));
    const wantedIds = maps.map((m) => m.employeeId);
    const rows = wantedCodes.length || wantedIds.length
      ? await this.prisma.employee.findMany({
          where: {
            organizationId: orgId,
            deletedAt: null,
            OR: [
              ...(wantedCodes.length ? [{ employeeCode: { in: wantedCodes } }] : []),
              ...(wantedIds.length ? [{ id: { in: wantedIds } }] : []),
            ],
          },
          select: { id: true, employeeCode: true, user: { select: { fullName: true, email: true } } },
        })
      : [];
    const emps = rows.map((r) => ({ id: r.id, employeeCode: r.employeeCode, name: r.user.fullName ?? r.user.email ?? r.employeeCode }));
    const empByCode = new Map(emps.map((e) => [e.employeeCode.toLowerCase(), e]));
    const empById = new Map(emps.map((e) => [e.id, e]));
    const mapByExt = new Map(maps.map((m) => [m.externalId, m]));
    return teachers.map((t) => {
      const existing = mapByExt.get(t.id);
      const suggested = t.employeeCode ? empByCode.get(t.employeeCode.toLowerCase()) : undefined;
      const mappedEmp = existing ? empById.get(existing.employeeId) : undefined;
      return {
        teacherId: t.id,
        teacherName: t.name,
        employeeCode: t.employeeCode,
        designation: t.designation,
        mappedEmployeeId: existing?.employeeId ?? null,
        mappedEmployeeName: mappedEmp?.name ?? null,
        mappedActive: existing?.active ?? null,
        suggestedEmployeeId: existing ? null : suggested?.id ?? null,
        suggestedEmployeeName: existing ? null : suggested?.name ?? null,
      };
    });
  }
}
