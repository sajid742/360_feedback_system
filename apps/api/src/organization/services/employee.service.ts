import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { paginate, type Paginated } from '../../common/dto/pagination.dto';
import type { AuthUser, RequestContext } from '../../common/auth/current-user';
import { wouldCreateCycle } from '../cycle-guard';
import { PasswordService } from '../../auth/services/password.service';
import { ScopeService } from '../../rbac/scope.service';
import { DEFAULT_EMPLOYEE_ROLE } from '../../rbac/system-roles';
import { generateTemporaryPassword } from '../../rbac/temporary-password';
import { EntitlementService } from '../../license/entitlement.service';
import type {
  AssignMatrixDto,
  CreateEmployeeDto,
  EmployeeQueryDto,
  UpdateEmployeeDto,
} from '../dto/organization.dto';

const INCLUDE = {
  user: { select: { id: true, email: true, fullName: true } },
  department: { select: { id: true, name: true } },
  designation: { select: { id: true, name: true } },
  lineManager: { include: { user: { select: { fullName: true, email: true } } } },
  matrixOf: { include: { manager: { include: { user: { select: { fullName: true, email: true } } } } } },
} satisfies Prisma.EmployeeInclude;

type EmployeeRow = Prisma.EmployeeGetPayload<{ include: typeof INCLUDE }>;

@Injectable()
export class EmployeeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly scope: ScopeService,
    private readonly passwords: PasswordService,
    private readonly entitlements: EntitlementService,
  ) {}

  async list(user: AuthUser, query: EmployeeQueryDto): Promise<Paginated<Record<string, unknown>>> {
    // Record-level scope: Manager sees their reporting hierarchy, Employee sees only self.
    const visible = await this.scope.visibleEmployeeIds(user);
    const where: Prisma.EmployeeWhereInput = {
      organizationId: user.organizationId,
      deletedAt: null,
      ...(visible ? { id: { in: [...visible] } } : {}),
      ...(query.departmentId ? { departmentId: query.departmentId } : {}),
      ...(query.designationId ? { designationId: query.designationId } : {}),
      ...(query.search
        ? {
            OR: [
              { employeeCode: { contains: query.search, mode: 'insensitive' } },
              { user: { fullName: { contains: query.search, mode: 'insensitive' } } },
              { user: { email: { contains: query.search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.employee.findMany({
        where,
        include: INCLUDE,
        orderBy: { employeeCode: 'asc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.employee.count({ where }),
    ]);
    return paginate(rows.map(serialize), total, query.page, query.pageSize);
  }

  async create(user: AuthUser, ctx: RequestContext, dto: CreateEmployeeDto): Promise<Record<string, unknown>> {
    // Plan gate first, before any other validation, so a customer at their limit gets
    // the plan message rather than an unrelated complaint about the payload. A new
    // employee also gets a sign-in account, so both caps are checked.
    await this.entitlements.assertWithinLimit(user.organizationId, 'maxEmployees', 1);
    await this.entitlements.assertWithinLimit(user.organizationId, 'maxUsers', 1);
    await this.assertEmailFree(user.organizationId, dto.email);
    await this.assertCodeFree(user.organizationId, dto.employeeCode);
    if (dto.lineManagerId) await this.getOwned(user.organizationId, dto.lineManagerId);

    // A new person must be able to actually sign in and complete reviews (F-C1):
    // issue a temporary password when none is supplied (forced change at first
    // login) and grant the default Employee role. Previously both were omitted, so
    // every UI-created employee had a null password hash and zero permissions.
    const temporaryPassword = dto.password ? null : generateTemporaryPassword();
    const plainPassword = dto.password ?? temporaryPassword!;
    const defaultRole = await this.prisma.role.findFirst({
      where: { organizationId: user.organizationId, name: DEFAULT_EMPLOYEE_ROLE },
      select: { id: true },
    });

    const created = await this.prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          organizationId: user.organizationId,
          email: dto.email.toLowerCase(),
          fullName: dto.fullName,
          passwordHash: await bcrypt.hash(plainPassword, 10),
          mustChangePassword: true,
          ...(defaultRole ? { userRoles: { create: { roleId: defaultRole.id } } } : {}),
        },
      });
      return tx.employee.create({
        data: {
          organizationId: user.organizationId,
          userId: newUser.id,
          employeeCode: dto.employeeCode,
          departmentId: dto.departmentId ?? null,
          designationId: dto.designationId ?? null,
          campusId: dto.campusId ?? null,
          lineManagerId: dto.lineManagerId ?? null,
          joinDate: dto.joinDate ? new Date(dto.joinDate) : null,
          createdBy: user.userId,
          updatedBy: user.userId,
        },
        include: INCLUDE,
      });
    });
    await this.record(user, ctx, 'organization.employee.create', created.id, { email: dto.email });

    // Invitation onboarding (F28): email the person a single-use link so they choose
    // their own password and the administrator never handles a credential. If email
    // isn't configured or delivery fails we fall back to showing the temporary
    // password, because onboarding must not dead-end on a mail problem.
    let invitation: { sent: boolean; reason?: string } | undefined;
    if (dto.sendInvite && !dto.password) {
      invitation = await this.passwords.sendInvitation(user.organizationId, created.userId!);
    }

    // The temporary password is returned ONCE so the admin can hand it over (same
    // contract as the admin password-reset flow); it is never stored in plain text.
    // It is withheld when an invitation actually went out — that's the whole point.
    return {
      ...serialize(created),
      temporaryPassword: invitation?.sent ? null : temporaryPassword,
      invitation,
      roleAssigned: defaultRole ? DEFAULT_EMPLOYEE_ROLE : null,
    };
  }

  async update(user: AuthUser, ctx: RequestContext, id: string, dto: UpdateEmployeeDto): Promise<Record<string, unknown>> {
    const existing = await this.getOwned(user.organizationId, id);
    if (dto.lineManagerId) {
      if (dto.lineManagerId === id) throw new BadRequestException('An employee cannot report to themselves.');
      await this.getOwned(user.organizationId, dto.lineManagerId);
      const cycle = await wouldCreateCycle((nid) => this.managerOf(nid), dto.lineManagerId, id);
      if (cycle) throw new BadRequestException('This line manager would create a reporting cycle.');
    }
    const row = await this.prisma.employee.update({
      where: { id },
      data: {
        departmentId: dto.departmentId === undefined ? existing.departmentId : dto.departmentId,
        designationId: dto.designationId === undefined ? existing.designationId : dto.designationId,
        campusId: dto.campusId === undefined ? existing.campusId : dto.campusId,
        lineManagerId: dto.lineManagerId === undefined ? existing.lineManagerId : dto.lineManagerId,
        status: dto.status ?? existing.status,
        updatedBy: user.userId,
      },
      include: INCLUDE,
    });
    await this.record(user, ctx, 'organization.employee.update', id, dto);
    return serialize(row);
  }

  async assignMatrix(user: AuthUser, ctx: RequestContext, id: string, dto: AssignMatrixDto): Promise<void> {
    await this.getOwned(user.organizationId, id);
    if (dto.managerIds.includes(id)) throw new BadRequestException('An employee cannot be their own matrix manager.');
    const valid = await this.prisma.employee.count({
      where: { id: { in: dto.managerIds }, organizationId: user.organizationId, deletedAt: null },
    });
    if (valid !== dto.managerIds.length) throw new BadRequestException('One or more managers are invalid.');
    await this.prisma.$transaction([
      this.prisma.employeeMatrixManager.deleteMany({ where: { employeeId: id } }),
      this.prisma.employeeMatrixManager.createMany({
        data: dto.managerIds.map((managerId) => ({ employeeId: id, managerId })),
      }),
    ]);
    await this.record(user, ctx, 'organization.employee.matrix', id, dto);
  }

  /** Termination: soft-delete the employee, mark terminated, and disable login. */
  async terminate(user: AuthUser, ctx: RequestContext, id: string): Promise<void> {
    const existing = await this.getOwned(user.organizationId, id);
    await this.prisma.$transaction([
      this.prisma.employee.update({
        where: { id },
        data: { status: 'terminated', deletedAt: new Date(), updatedBy: user.userId },
      }),
      this.prisma.user.update({ where: { id: existing.userId }, data: { status: 'disabled' } }),
      this.prisma.refreshToken.updateMany({
        where: { userId: existing.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    await this.record(user, ctx, 'organization.employee.terminate', id, null);
  }

  async orgChart(user: AuthUser): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.employee.findMany({
      where: { organizationId: user.organizationId, deletedAt: null },
      include: INCLUDE,
    });
    return rows.map(serialize);
  }

  private async managerOf(id: string): Promise<string | null> {
    const row = await this.prisma.employee.findUnique({ where: { id }, select: { lineManagerId: true } });
    return row?.lineManagerId ?? null;
  }

  private async getOwned(organizationId: string, id: string) {
    const row = await this.prisma.employee.findFirst({ where: { id, organizationId, deletedAt: null } });
    if (!row) throw new NotFoundException('Employee not found.');
    return row;
  }

  private async assertEmailFree(organizationId: string, email: string): Promise<void> {
    const clash = await this.prisma.user.findFirst({
      where: { organizationId, deletedAt: null, email: email.toLowerCase() },
      select: { id: true },
    });
    if (clash) throw new ConflictException('A user with this email already exists.');
  }

  private async assertCodeFree(organizationId: string, code: string): Promise<void> {
    const clash = await this.prisma.employee.findFirst({
      where: { organizationId, deletedAt: null, employeeCode: code },
      select: { id: true },
    });
    if (clash) throw new ConflictException('This employee code is already in use.');
  }

  private async record(user: AuthUser, ctx: RequestContext, action: string, entityId: string, newValue: unknown): Promise<void> {
    await this.audit.record({
      organizationId: user.organizationId,
      userId: user.userId,
      action,
      entityType: 'employee',
      entityId,
      newValue: newValue ?? undefined,
      ip: ctx.ip,
      device: ctx.device,
    });
  }
}

function serialize(row: EmployeeRow): Record<string, unknown> {
  return {
    id: row.id,
    employeeCode: row.employeeCode,
    status: row.status,
    joinDate: row.joinDate,
    user: row.user,
    department: row.department,
    designation: row.designation,
    // Campuses are organization rows and Employee.campusId has no Prisma relation, so the
    // raw id is returned and the client resolves the name from the campus list it already
    // loads. Settable via create/update but previously never read back.
    campusId: row.campusId,
    lineManagerId: row.lineManagerId,
    lineManager: row.lineManager
      ? { id: row.lineManagerId, name: row.lineManager.user.fullName ?? row.lineManager.user.email }
      : null,
    matrixManagers: row.matrixOf.map((m) => ({
      id: m.managerId,
      name: m.manager.user.fullName ?? m.manager.user.email,
    })),
  };
}
