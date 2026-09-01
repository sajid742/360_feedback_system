import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import type { AuthUser, RequestContext } from '../common/auth/current-user';
import { PasswordService } from '../auth/services/password.service';
import { DEFAULT_EMPLOYEE_ROLE, SUPER_ADMIN_ROLE } from './system-roles';
import { generateTemporaryPassword } from './temporary-password';

type Dict = Record<string, unknown>;

const MODULE_LABELS: Record<string, string> = {
  organization: 'Employees & Organization',
  appraisal: 'Feedback Cycles & Evaluations',
  questionnaire: 'Questionnaires',
  competency: 'Competencies',
  communication: 'Communication',
  sis: 'SIS', identity: 'SIS', external: 'SIS',
  reports: 'Dashboards & Reports', ai: 'Dashboards & Reports',
  configuration: 'System Settings', auth: 'System Settings', integration: 'System Settings',
  workflow: 'Workflows', development: 'Development', system: 'System Settings',
};

@Injectable()
export class RbacService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly passwords: PasswordService,
  ) {}

  /**
   * Email an existing user a link to set their own password (F28).
   *
   * The counterpart to `resetPassword` for people who were onboarded before
   * invitations existed, whose invitation expired, or who never received the first
   * one. Reuses the same single-use token; the administrator never sees a credential.
   */
  async sendInvitation(actor: AuthUser, ctx: RequestContext, userId: string): Promise<Dict> {
    const target = await this.prisma.user.findFirst({
      where: { id: userId, organizationId: actor.organizationId, deletedAt: null },
      select: { id: true, email: true, status: true },
    });
    if (!target) throw new NotFoundException('User not found.');
    if (target.status !== 'active') {
      throw new BadRequestException('This user is deactivated. Reactivate the account before sending an invitation.');
    }
    const result = await this.passwords.sendInvitation(actor.organizationId, target.id);
    await this.audit.record({
      organizationId: actor.organizationId, userId: actor.userId, action: 'rbac.user.invited',
      entityType: 'user', entityId: target.id,
      newValue: { email: target.email, sent: result.sent }, ip: ctx.ip, device: ctx.device,
    });
    return { userId: target.id, email: target.email, ...result };
  }

  /**
   * Admin password reset: set a temporary password for a user (auto-generated if not
   * supplied) and optionally force them to change it at next login. Revokes the
   * target's active sessions and audits the action. Returns the temporary password
   * once so the admin can hand it over securely.
   */
  async resetPassword(
    actor: AuthUser,
    ctx: RequestContext,
    userId: string,
    opts: { temporaryPassword?: string; requireChange?: boolean },
  ): Promise<{ userId: string; temporaryPassword: string; requireChange: boolean }> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, organizationId: actor.organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!user) throw new NotFoundException('User not found.');
    const requireChange = opts.requireChange ?? true;
    const provided = opts.temporaryPassword?.trim();
    const temporaryPassword = provided && provided.length > 0 ? provided : generateTemporaryPassword();
    // adminSetPassword validates against the org password policy and throws on a weak
    // admin-supplied password; hashes, sets the flag, and revokes active sessions.
    await this.passwords.adminSetPassword(actor.organizationId, userId, temporaryPassword, requireChange);
    await this.audit.record({
      organizationId: actor.organizationId, userId: actor.userId, action: 'rbac.user.password_reset',
      entityType: 'user', entityId: userId,
      newValue: { requireChange, generated: !provided }, ip: ctx.ip, device: ctx.device,
    });
    return { userId, temporaryPassword, requireChange };
  }

  /* ------------------------------ roles ------------------------------ */
  async roles(orgId: string): Promise<Dict[]> {
    const roles = await this.prisma.role.findMany({
      where: { organizationId: orgId, deletedAt: null },
      include: { rolePermissions: { select: { permissionCode: true } }, _count: { select: { userRoles: true } } },
      orderBy: { name: 'asc' },
    });
    return roles.map((r) => ({
      id: r.id, name: r.name, description: r.description, scope: r.scope, isSystem: r.isSystem,
      users: r._count.userRoles, permissions: r.rolePermissions.map((p) => p.permissionCode),
      permissionCount: r.rolePermissions.length,
    }));
  }

  /** Permission catalog grouped by display module (read-only reference). */
  async permissionCatalog(): Promise<Dict[]> {
    const perms = await this.prisma.permission.findMany({ orderBy: [{ module: 'asc' }, { code: 'asc' }] });
    const groups = new Map<string, { module: string; label: string; permissions: Dict[] }>();
    for (const p of perms) {
      const label = MODULE_LABELS[p.module] ?? p.module;
      const key = label;
      if (!groups.has(key)) groups.set(key, { module: p.module, label, permissions: [] });
      groups.get(key)!.permissions.push({ code: p.code, description: p.description, action: actionOf(p.code) });
    }
    return [...groups.values()];
  }

  /** Role × permission matrix for the read-only admin view. */
  async matrix(orgId: string): Promise<Dict> {
    const [roles, catalog] = await Promise.all([this.roles(orgId), this.permissionCatalog()]);
    const grants: Record<string, string[]> = {};
    for (const r of roles) grants[r.id as string] = r.permissions as string[];
    return {
      roles: roles.map((r) => ({ id: r.id, name: r.name, scope: r.scope, permissionCount: r.permissionCount })),
      groups: catalog,
      grants,
    };
  }

  /* ------------------------------ users ------------------------------ */
  /**
   * User Management list.
   *
   * Performance (F-P7): this returned EVERY user in the organization on every
   * keystroke of the search box — for a 1,500-person tenant that is a ~286 KB
   * response the browser must parse and re-render in full. Worse, the guard
   * against that was a silent `take: 1000`, so an org with more than a thousand
   * users simply never saw the rest of them. The list is now paginated with a
   * total count, so the payload is bounded and nothing is hidden.
   */
  async users(
    orgId: string,
    search?: string,
    roleId?: string,
    status?: string,
    opts: { page?: number; pageSize?: number } = {},
  ): Promise<Dict> {
    const page = Math.max(1, Number(opts.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(opts.pageSize) || 50));
    const where = {
      organizationId: orgId, deletedAt: null,
      ...(status ? { status } : {}),
      ...(roleId ? { userRoles: { some: { roleId } } } : {}),
      ...(search ? { OR: [{ fullName: { contains: search, mode: 'insensitive' as const } }, { email: { contains: search, mode: 'insensitive' as const } }] } : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        include: {
          userRoles: { include: { role: { select: { id: true, name: true, scope: true } } } },
          employee: { select: { employeeCode: true, department: { select: { name: true } }, designation: { select: { name: true } } } },
        },
        orderBy: { fullName: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.user.count({ where }),
    ]);
    return {
      items: rows.map((u) => ({
        id: u.id, name: u.fullName ?? u.email, email: u.email, status: u.status,
        roles: u.userRoles.map((ur) => ({ id: ur.role.id, name: ur.role.name })),
        isSuperAdmin: u.userRoles.some((ur) => ur.role.name === SUPER_ADMIN_ROLE),
        employeeCode: u.employee?.employeeCode ?? null,
        department: u.employee?.department?.name ?? null,
        designation: u.employee?.designation?.name ?? null,
      })),
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  /** A user's roles + union of effective permissions + effective scope. */
  async userDetail(orgId: string, userId: string): Promise<Dict> {
    const u = await this.prisma.user.findFirst({
      where: { id: userId, organizationId: orgId, deletedAt: null },
      include: { userRoles: { include: { role: { include: { rolePermissions: { select: { permissionCode: true } } } } } } },
    });
    if (!u) throw new NotFoundException('User not found.');
    const perms = new Set<string>();
    const rank: Record<string, number> = { organization: 3, reporting: 2, own: 1 };
    let scope = 'own';
    for (const ur of u.userRoles) {
      ur.role.rolePermissions.forEach((rp) => perms.add(rp.permissionCode));
      if ((rank[ur.role.scope] ?? 1) > (rank[scope] ?? 1)) scope = ur.role.scope;
    }
    return {
      id: u.id, name: u.fullName ?? u.email, email: u.email, status: u.status,
      roles: u.userRoles.map((ur) => ({ id: ur.role.id, name: ur.role.name, scope: ur.role.scope })),
      scope: u.userRoles.length ? scope : 'own',
      permissions: [...perms].sort(),
    };
  }

  /** Assign / change / remove a user's roles (replace set). */
  async setUserRoles(actor: AuthUser, ctx: RequestContext, userId: string, roleIds: string[]): Promise<Dict> {
    const user = await this.prisma.user.findFirst({ where: { id: userId, organizationId: actor.organizationId, deletedAt: null }, select: { id: true } });
    if (!user) throw new NotFoundException('User not found.');
    const roles = await this.prisma.role.findMany({ where: { id: { in: roleIds }, organizationId: actor.organizationId, deletedAt: null }, select: { id: true, name: true } });
    if (roles.length !== roleIds.length) throw new BadRequestException('One or more roles are invalid for this organization.');

    // Safeguard: never remove the last active Super Admin.
    const hadSA = await this.userHasRole(userId, SUPER_ADMIN_ROLE);
    const willHaveSA = roles.some((r) => r.name === SUPER_ADMIN_ROLE);
    if (hadSA && !willHaveSA && (await this.countActiveSuperAdmins(actor.organizationId, userId)) === 0) {
      throw new ConflictException('Cannot remove the last Super Admin. Assign Super Admin to another active user first.');
    }

    const before = (await this.prisma.userRole.findMany({ where: { userId }, include: { role: { select: { name: true } } } })).map((ur) => ur.role.name);
    await this.prisma.$transaction([
      this.prisma.userRole.deleteMany({ where: { userId } }),
      this.prisma.userRole.createMany({ data: roleIds.map((roleId) => ({ userId, roleId })), skipDuplicates: true }),
    ]);
    await this.audit.record({
      organizationId: actor.organizationId, userId: actor.userId, action: 'rbac.user.roles.update',
      entityType: 'user', entityId: userId, previousValue: { roles: before }, newValue: { roles: roles.map((r) => r.name) },
      ip: ctx.ip, device: ctx.device,
    });
    return this.userDetail(actor.organizationId, userId);
  }

  /**
   * Grant the default Employee role to every user in the org that currently has NO
   * role at all (F-C1 repair path). People onboarded before default-role assignment
   * existed can authenticate but are denied every endpoint — they cannot see their
   * review queue or submit feedback. This is idempotent and never touches users who
   * already hold a role, so it cannot downgrade anyone.
   */
  async backfillDefaultRoles(actor: AuthUser, ctx: RequestContext): Promise<Dict> {
    const role = await this.prisma.role.findFirst({
      where: { organizationId: actor.organizationId, name: DEFAULT_EMPLOYEE_ROLE, deletedAt: null },
      select: { id: true },
    });
    if (!role) throw new BadRequestException(`The "${DEFAULT_EMPLOYEE_ROLE}" role does not exist in this organization.`);

    const roleless = await this.prisma.user.findMany({
      where: { organizationId: actor.organizationId, deletedAt: null, userRoles: { none: {} } },
      select: { id: true, email: true },
    });
    if (roleless.length > 0) {
      await this.prisma.userRole.createMany({
        data: roleless.map((u) => ({ userId: u.id, roleId: role.id })),
        skipDuplicates: true,
      });
      await this.audit.record({
        organizationId: actor.organizationId, userId: actor.userId, action: 'rbac.user.roles.backfill',
        entityType: 'user', entityId: actor.organizationId,
        newValue: { role: DEFAULT_EMPLOYEE_ROLE, users: roleless.length },
        ip: ctx.ip, device: ctx.device,
      });
    }
    return { role: DEFAULT_EMPLOYEE_ROLE, updated: roleless.length };
  }

  /** Activate / deactivate a user (deactivated users cannot log in). */
  async setActive(actor: AuthUser, ctx: RequestContext, userId: string, active: boolean): Promise<Dict> {
    const user = await this.prisma.user.findFirst({ where: { id: userId, organizationId: actor.organizationId, deletedAt: null }, select: { id: true, status: true } });
    if (!user) throw new NotFoundException('User not found.');
    if (!active) {
      // Safeguard: never deactivate the last active Super Admin.
      if (await this.userHasRole(userId, SUPER_ADMIN_ROLE) && (await this.countActiveSuperAdmins(actor.organizationId, userId)) === 0) {
        throw new ConflictException('Cannot deactivate the last Super Admin.');
      }
    }
    await this.prisma.user.update({ where: { id: userId }, data: { status: active ? 'active' : 'inactive' } });
    if (!active) {
      // Kill refresh sessions so the account is signed out (access token expires shortly after).
      await this.prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    await this.audit.record({
      organizationId: actor.organizationId, userId: actor.userId, action: active ? 'rbac.user.activate' : 'rbac.user.deactivate',
      entityType: 'user', entityId: userId, ip: ctx.ip, device: ctx.device,
    });
    return { id: userId, status: active ? 'active' : 'inactive' };
  }

  /* ------------------------------ helpers ------------------------------ */
  private async userHasRole(userId: string, roleName: string): Promise<boolean> {
    const n = await this.prisma.userRole.count({ where: { userId, role: { name: roleName } } });
    return n > 0;
  }

  /** Active users (excluding one) holding the Super Admin role. */
  private async countActiveSuperAdmins(orgId: string, excludeUserId?: string): Promise<number> {
    return this.prisma.user.count({
      where: {
        organizationId: orgId, deletedAt: null, status: 'active',
        ...(excludeUserId ? { id: { not: excludeUserId } } : {}),
        userRoles: { some: { role: { name: SUPER_ADMIN_ROLE } } },
      },
    });
  }
}

/** Infer the coarse action from a permission code, for the UI action columns. */
function actionOf(code: string): string {
  const tail = code.split('.').pop() ?? '';
  if (tail === 'read') return 'View';
  if (['manage', 'create', 'update', 'delete', 'archive'].includes(tail)) return 'Manage';
  if (tail === 'submit') return 'Submit';
  if (tail === 'calibrate' || tail === 'act') return 'Approve';
  if (tail === 'assign' || code.includes('assignment')) return 'Assign';
  if (tail === 'executive') return 'View';
  if (tail === 'send') return 'Send';
  if (tail === 'admin') return 'Configure';
  return 'Manage';
}
