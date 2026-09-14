import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import type { AuthUser, RequestContext } from '../common/auth/current-user';
import { EntitlementService } from '../license/entitlement.service';
import { DEFAULT_PLAN, PLANS, PLAN_CODES, isPlanCode, type PlanCode } from '../license/plans';
import { isSubscriptionStatus, type SubscriptionStatus } from '../license/entitlements.types';
import { provisionTenant } from '../provisioning/tenant-provisioning';
import type { CreateTenantDto, UpdateSubscriptionDto } from './platform.dto';

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,118}[a-z0-9])?$/;

/**
 * Platform operations — the vendor's view across tenants.
 *
 * SCOPE DISCIPLINE. Everything here reads or writes commercial state: which
 * organisations exist, what they are subscribed to, and how much they are using. It
 * never reads a tenant's feedback, responses or reports. Impersonation ("sign in as
 * this customer") is deliberately absent: this system holds performance reviews, and
 * quietly entering a customer's account to read them is a privacy decision that needs
 * consent and its own audit stream, not a convenience method.
 */
@Injectable()
export class PlatformService {
  private readonly log = new Logger(PlatformService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementService,
  ) {}

  /* -------------------------------------------------------- organisations */

  /**
   * Every tenant, with its plan and headline usage.
   *
   * ROOTS ONLY. A campus is a row in `organizations` too, so an unfiltered count is
   * the single easiest way to get a tenant list wrong — `GET /provisioning/status`
   * already reports roots + campuses as the organisation count.
   */
  async organizations(): Promise<Record<string, unknown>[]> {
    const orgs = await this.prisma.organization.findMany({
      where: { orgType: 'root', deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, slug: true, status: true, createdAt: true },
    });

    return Promise.all(
      orgs.map(async (org) => {
        const state = await this.entitlements.get(org.id);
        const [employees, users, campuses] = await Promise.all([
          this.entitlements.count(org.id, 'maxEmployees'),
          this.entitlements.count(org.id, 'maxUsers'),
          this.entitlements.count(org.id, 'maxCampuses'),
        ]);
        return {
          id: org.id,
          name: org.name,
          slug: org.slug,
          status: org.status,
          createdAt: org.createdAt,
          source: state.source,
          plan: state.planCode,
          planLabel: state.planLabel,
          subscriptionStatus: state.subscriptionStatus,
          operational: state.operational,
          trialEndsAt: state.trialEndsAt,
          currentPeriodEnd: state.currentPeriodEnd,
          employees,
          maxEmployees: state.limits.maxEmployees,
          users,
          campuses,
        };
      }),
    );
  }

  /** One tenant, with its full entitlement state and every limit's usage. */
  async organization(id: string): Promise<Record<string, unknown>> {
    const org = await this.requireRoot(id);
    const state = await this.entitlements.get(id);
    const subscription = await this.prisma.subscription.findFirst({
      where: { organizationId: id, deletedAt: null },
    });
    return {
      organization: { id: org.id, name: org.name, slug: org.slug, status: org.status, createdAt: org.createdAt },
      entitlements: {
        source: state.source,
        plan: state.planCode,
        planLabel: state.planLabel,
        status: state.status,
        subscriptionStatus: state.subscriptionStatus,
        operational: state.operational,
        message: state.message,
        modules: state.modules,
        limits: state.limits,
      },
      subscription,
      usage: await this.entitlements.usage(id),
    };
  }

  /** Create a tenant and give it a subscription in one step. */
  async createTenant(actor: AuthUser, ctx: RequestContext, dto: CreateTenantDto): Promise<Record<string, unknown>> {
    const slug = dto.slug.trim().toLowerCase();
    if (!SLUG_PATTERN.test(slug)) {
      throw new BadRequestException(
        'Sign-in code must be 3–120 characters, lowercase letters, numbers and hyphens, and cannot start or end with a hyphen.',
      );
    }
    // The slug namespace is global and shared with campuses, so this has to check every
    // organisation row rather than only roots.
    const clash = await this.prisma.organization.findFirst({ where: { slug }, select: { id: true } });
    if (clash) throw new ConflictException(`The sign-in code "${slug}" is already in use.`);

    const result = await provisionTenant(this.prisma, {
      orgName: dto.orgName.trim(),
      slug,
      email: dto.email.trim().toLowerCase(),
      password: dto.password,
      withStarterContent: dto.withStarterContent !== false,
    });

    // A trial of a real plan, not a fourth plan called "trial" — see entitlements.types.
    const planCode: PlanCode = isPlanCode(dto.planCode ?? '') ? (dto.planCode as PlanCode) : 'professional';
    const trialDays = dto.trialDays ?? 30;
    const trialEndsAt = trialDays > 0 ? new Date(Date.now() + trialDays * 86_400_000) : null;

    await this.prisma.subscription.create({
      data: {
        organizationId: result.organizationId,
        planCode,
        status: trialEndsAt ? 'trialing' : 'active',
        trialEndsAt,
        currentPeriodStart: new Date(),
        currentPeriodEnd: trialEndsAt,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      },
    });
    this.entitlements.invalidate(result.organizationId);

    await this.audit.record({
      organizationId: result.organizationId,
      userId: actor.userId,
      action: 'platform.tenant.created',
      entityType: 'organization',
      entityId: result.organizationId,
      newValue: { slug, planCode, trialDays },
      ...ctx,
    });
    this.log.log(`Platform admin ${actor.email} created tenant "${slug}" on ${planCode} (${trialDays}-day trial).`);

    return { ...result, planCode, trialEndsAt };
  }

  /* --------------------------------------------------------- subscription */

  /**
   * Assign or change a plan.
   *
   * DOWNGRADES NEVER DELETE DATA. A Professional tenant with 400 employees moving to
   * Starter keeps all 400; the cap applies to additions, so they simply cannot add more
   * until they upgrade or remove some. Destroying customer data on a billing event is
   * not a behaviour worth having.
   */
  async setSubscription(
    actor: AuthUser,
    ctx: RequestContext,
    orgId: string,
    dto: UpdateSubscriptionDto,
  ): Promise<Record<string, unknown>> {
    await this.requireRoot(orgId);
    const existing = await this.prisma.subscription.findFirst({ where: { organizationId: orgId, deletedAt: null } });

    if (dto.limitOverrides) this.assertLimitOverrides(dto.limitOverrides);
    if (dto.moduleOverrides) this.assertModuleOverrides(dto.moduleOverrides);

    const data = {
      ...(dto.planCode !== undefined ? { planCode: dto.planCode } : {}),
      ...(dto.status !== undefined ? { status: dto.status } : {}),
      // `'trialEndsAt' in dto` rather than a truthiness test: an explicit null clears
      // the date, while omitting the field must leave it alone.
      ...('trialEndsAt' in dto ? { trialEndsAt: dto.trialEndsAt ? new Date(dto.trialEndsAt) : null } : {}),
      ...('currentPeriodStart' in dto ? { currentPeriodStart: dto.currentPeriodStart ? new Date(dto.currentPeriodStart) : null } : {}),
      ...('currentPeriodEnd' in dto ? { currentPeriodEnd: dto.currentPeriodEnd ? new Date(dto.currentPeriodEnd) : null } : {}),
      ...(dto.graceDays !== undefined ? { graceDays: dto.graceDays } : {}),
      ...(dto.limitOverrides !== undefined ? { limitOverrides: dto.limitOverrides as Prisma.InputJsonValue } : {}),
      ...(dto.moduleOverrides !== undefined ? { moduleOverrides: dto.moduleOverrides as Prisma.InputJsonValue } : {}),
      ...(dto.externalCustomerId !== undefined ? { externalCustomerId: dto.externalCustomerId } : {}),
      ...(dto.externalSubscriptionId !== undefined ? { externalSubscriptionId: dto.externalSubscriptionId } : {}),
      ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
      updatedBy: actor.userId,
    };

    const row = existing
      ? await this.prisma.subscription.update({ where: { id: existing.id }, data })
      : await this.prisma.subscription.create({
          data: {
            organizationId: orgId,
            planCode: dto.planCode ?? DEFAULT_PLAN,
            status: dto.status ?? 'active',
            createdBy: actor.userId,
            ...data,
          },
        });

    this.entitlements.invalidate(orgId);

    // Written to the tenant's own audit log, so a billing dispute has a trail the
    // customer can also see.
    await this.audit.record({
      organizationId: orgId,
      userId: actor.userId,
      action: existing ? 'platform.subscription.updated' : 'platform.subscription.created',
      entityType: 'subscription',
      entityId: row.id,
      previousValue: existing
        ? { planCode: existing.planCode, status: existing.status, currentPeriodEnd: existing.currentPeriodEnd }
        : null,
      newValue: { planCode: row.planCode, status: row.status, currentPeriodEnd: row.currentPeriodEnd },
      ...ctx,
    });

    return this.organization(orgId);
  }

  /** Suspend or restore a tenant. Suspension is a subscription status, not deletion. */
  async setSuspended(actor: AuthUser, ctx: RequestContext, orgId: string, suspended: boolean): Promise<Record<string, unknown>> {
    return this.setSubscription(actor, ctx, orgId, { status: suspended ? 'suspended' : 'active' });
  }

  /* ------------------------------------------------------------ operators */

  async admins(): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.platformAdmin.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'asc' },
      include: { user: { select: { email: true, fullName: true, organizationId: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      email: r.user.email,
      fullName: r.user.fullName,
      label: r.label,
      createdAt: r.createdAt,
    }));
  }

  /* ------------------------------------------------------------- summary */

  async stats(): Promise<Record<string, unknown>> {
    const orgs = await this.organizations();
    const byPlan: Record<string, number> = {};
    for (const code of PLAN_CODES) byPlan[code] = 0;
    let unsubscribed = 0;
    for (const o of orgs) {
      const plan = o.plan as string | null;
      if (plan && plan in byPlan) byPlan[plan] += 1;
      else unsubscribed += 1;
    }
    return {
      tenants: orgs.length,
      byPlan,
      /** On an installed licence or none at all — i.e. not on a subscription. */
      unsubscribed,
      suspended: orgs.filter((o) => o.subscriptionStatus === 'suspended').length,
      trialing: orgs.filter((o) => o.subscriptionStatus === 'trialing').length,
      employees: orgs.reduce((sum, o) => sum + (o.employees as number), 0),
    };
  }

  /* ------------------------------------------------------------- helpers */

  private async requireRoot(id: string): Promise<{ id: string; name: string; slug: string; status: string; createdAt: Date }> {
    const org = await this.prisma.organization.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, name: true, slug: true, status: true, createdAt: true, orgType: true },
    });
    if (!org) throw new NotFoundException('Organization not found.');
    // A campus is an organisation row, but it is part of its parent tenant and can
    // never hold a plan of its own.
    if (org.orgType !== 'root') throw new BadRequestException('This is a campus, not a tenant. Subscriptions belong to the parent organization.');
    return org;
  }

  /** Reject an override key that is not a real limit, so a typo cannot silently do nothing. */
  private assertLimitOverrides(overrides: Record<string, unknown>): void {
    const known = Object.keys(PLANS.enterprise.limits);
    const unknown = Object.keys(overrides).filter((k) => !known.includes(k));
    if (unknown.length) {
      throw new BadRequestException(`Unknown limit${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}.`);
    }
  }

  private assertModuleOverrides(overrides: Record<string, unknown>): void {
    const allowed = new Set(['add', 'remove']);
    const unknown = Object.keys(overrides).filter((k) => !allowed.has(k));
    if (unknown.length) {
      throw new BadRequestException(`Module overrides accept only "add" and "remove". Unknown: ${unknown.join(', ')}.`);
    }
    for (const key of ['add', 'remove']) {
      const v = overrides[key];
      if (v !== undefined && !Array.isArray(v)) throw new BadRequestException(`"${key}" must be a list of module codes.`);
    }
  }

  /** Status transitions an operator may set, for the UI. */
  statuses(): SubscriptionStatus[] {
    return (['trialing', 'active', 'past_due', 'grace', 'expired', 'suspended', 'cancelled'] as SubscriptionStatus[]).filter(
      isSubscriptionStatus,
    );
  }
}
