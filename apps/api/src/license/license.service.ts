import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { isInternalBuild } from './build-config';
import { verifyLicense } from './license.crypto';
import {
  ALWAYS_ON_MODULES,
  DEFAULT_GRACE_DAYS,
  EXPIRY_WARNING_DAYS,
  LICENSED_MODULES,
  type LicensePayload,
  type LicenseState,
  type LicenseStatus,
  type LicenseUsage,
  type LicensedModule,
} from './license.types';

const MODULE = 'license';
const KEY = 'current';

/**
 * The one place licence logic lives.
 *
 * WHERE IT IS STORED. In the existing `configurations` table
 * (`module='license', key='current'`), not a new table. That table is already
 * tenant-scoped, already JSONB, already carries created_by/updated_by, and already
 * survives Docker restarts because it is in PostgreSQL — so licensing needed **no
 * schema migration at all**. A dedicated `licenses` table would have added a migration
 * and a second thing to back up for no behaviour we do not already get.
 *
 * WHAT IS STORED. The signed licence string, plus the moment it was installed and by
 * whom. Nothing derived: status and usage are recomputed on read, because a stored
 * status would go stale the moment a date passed.
 */
@Injectable()
export class LicenseService {
  private readonly log = new Logger(LicenseService.name);
  /** Verification is pure CPU but runs on hot paths; cache briefly per organisation. */
  private cache = new Map<string, { at: number; state: LicenseState }>();
  private static readonly CACHE_MS = 30_000;

  constructor(private readonly prisma: PrismaService) {}

  /* ------------------------------------------------------------------ read */

  async getState(orgId: string): Promise<LicenseState> {
    const hit = this.cache.get(orgId);
    if (hit && Date.now() - hit.at < LicenseService.CACHE_MS) return hit.state;
    const state = await this.resolve(orgId);
    this.cache.set(orgId, { at: Date.now(), state });
    return state;
  }

  private invalidate(orgId: string): void {
    this.cache.delete(orgId);
  }

  private async resolve(orgId: string): Promise<LicenseState> {
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { slug: true, name: true },
    });
    const stored = await this.read(orgId);

    if (!stored?.licenseKey) {
      return this.developmentOrNone(org?.name ?? 'this installation');
    }

    const result = verifyLicense(stored.licenseKey);
    if (!result.ok) {
      // The reason is logged for an administrator; the UI gets one plain sentence, so a
      // probe cannot learn which part failed.
      this.log.warn(`Licence for org ${orgId} did not verify: ${result.reason}`);
      const dev = this.developmentLicense(org?.name ?? '');
      if (dev) return { ...dev, message: 'A licence is installed but could not be verified. Running on the development licence.' };
      return {
        status: 'INVALID', payload: null, daysRemaining: null, operational: false, isDevelopment: false,
        message: 'The installed licence could not be verified. Please install a valid licence file, or contact your supplier.',
        modules: [...ALWAYS_ON_MODULES], maxEmployees: 0, maxUsers: null, graceDays: 0,
      };
    }

    const payload = result.payload;

    /*
     * TENANT BINDING — bound to the organisation SLUG, not its UUID.
     *
     * The slug is what a customer types to sign in and what the vendor knows them by;
     * it is stable across a database restore, a re-provision, or a move to another
     * server. The UUID is not: restoring into a freshly bootstrapped database produces
     * a new one, and binding to it would invalidate a perfectly legitimate licence at
     * the worst possible moment. So the id is recorded, cross-checked, and only ever
     * produces a log line — never a rejection.
     */
    if (org && payload.organizationSlug !== '*' && payload.organizationSlug !== org.slug) {
      return {
        status: 'INVALID', payload: null, daysRemaining: null, operational: false, isDevelopment: false,
        message: `This licence was issued for a different organisation ("${payload.organizationSlug}") and cannot be used here.`,
        modules: [...ALWAYS_ON_MODULES], maxEmployees: 0, maxUsers: null, graceDays: 0,
      };
    }
    if (payload.organizationId && payload.organizationId !== orgId) {
      this.log.log(
        `Licence ${payload.licenseId} records a different organisation id than this installation — ` +
        'accepted on the slug match (normal after a database restore).',
      );
    }

    if (stored.suspended) {
      return {
        status: 'SUSPENDED', payload, daysRemaining: null, operational: false, isDevelopment: false,
        message: 'This licence has been suspended. Please contact your supplier.',
        modules: [...ALWAYS_ON_MODULES], maxEmployees: payload.maxEmployees ?? 0, maxUsers: payload.maxUsers ?? null,
        graceDays: payload.graceDays ?? DEFAULT_GRACE_DAYS,
      };
    }

    return this.evaluateDates(payload);
  }

  /** Status from the calendar. Everything date-related is decided here, once. */
  private evaluateDates(p: LicensePayload): LicenseState {
    const graceDays = p.graceDays ?? DEFAULT_GRACE_DAYS;
    const now = Date.now();
    const starts = Date.parse(p.startsAt);
    const expires = Date.parse(p.expiresAt);
    const day = 86_400_000;
    const daysRemaining = Math.ceil((expires - now) / day);
    const base = {
      payload: p,
      daysRemaining,
      isDevelopment: false,
      modules: this.modulesOf(p),
      maxEmployees: p.maxEmployees ?? 0,
      maxUsers: p.maxUsers ?? null,
      graceDays,
    };
    const on = (status: LicenseStatus, message: string, operational: boolean): LicenseState =>
      ({ ...base, status, message, operational });

    if (Number.isFinite(starts) && now < starts) {
      return on('NOT_STARTED', `This licence becomes active on ${fmt(p.startsAt)}.`, false);
    }
    if (now <= expires) {
      return daysRemaining <= EXPIRY_WARNING_DAYS
        ? on('EXPIRING', `Licence expires in ${daysRemaining} day${daysRemaining === 1 ? '' : 's'}, on ${fmt(p.expiresAt)}. Please arrange renewal.`, true)
        : on('ACTIVE', `Licensed to ${p.organizationName} until ${fmt(p.expiresAt)}.`, true);
    }
    const graceEnds = expires + graceDays * day;
    if (now <= graceEnds) {
      const left = Math.ceil((graceEnds - now) / day);
      return on(
        'GRACE_PERIOD',
        `Licence expired on ${fmt(p.expiresAt)}. You are in a ${graceDays}-day grace period with ${left} day${left === 1 ? '' : 's'} remaining. Please install a renewed licence.`,
        true,
      );
    }
    return on(
      'EXPIRED',
      `Licence ${p.licenseId} expired on ${fmt(p.expiresAt)}. Existing data is untouched and administrators can still install a renewed licence, but new records cannot be added until then.`,
      false,
    );
  }

  private modulesOf(p: LicensePayload): LicensedModule[] {
    const listed = (p.modules ?? []).filter((m): m is LicensedModule => (LICENSED_MODULES as readonly string[]).includes(m));
    return [...new Set([...ALWAYS_ON_MODULES, ...listed])];
  }

  /* ---------------------------------------------------- development licence */

  /**
   * DEVELOPMENT LICENCE — the reason `npm run dev` and `db:demo` still work with no
   * licence installed.
   *
   * It exists ONLY in an internal build. It used to be gated on `NODE_ENV`, which is an
   * environment variable the customer owns: setting it to `development` in their compose
   * file, with no licence installed, granted every module and unlimited employees. The
   * gate is now a build-time constant compiled into `dist`, so no environment change can
   * bring it back — and a mistyped `NODE_ENV` can no longer disable licensing by accident.
   *
   * It is not a hidden bypass even in development: it is reported as `isDevelopment` in
   * the API, printed at startup and labelled in the admin screen.
   *
   * `LICENSE_REQUIRE=true` remains, so a developer can exercise real licence behaviour
   * without a customer build. It can only ever tighten, never loosen.
   */
  private developmentLicense(orgName: string): LicenseState | null {
    if (!isInternalBuild()) return null;
    if (process.env.LICENSE_REQUIRE === 'true') return null;
    return {
      status: 'ACTIVE',
      payload: {
        v: 1,
        licenseId: 'DEVELOPMENT',
        organizationName: orgName || 'Development',
        organizationSlug: '*',
        edition: 'demo',
        issuedAt: new Date().toISOString(),
        startsAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 365 * 86_400_000).toISOString(),
        maxEmployees: 0,
        modules: [...LICENSED_MODULES],
      },
      message: 'Running on the built-in development licence. Install a licence before deploying to a customer.',
      daysRemaining: null,
      operational: true,
      isDevelopment: true,
      modules: [...LICENSED_MODULES],
      maxEmployees: 0,
      maxUsers: null,
      graceDays: 0,
    };
  }

  private developmentOrNone(orgName: string): LicenseState {
    const dev = this.developmentLicense(orgName);
    if (dev) return dev;
    return {
      status: 'NONE', payload: null, daysRemaining: null, operational: false, isDevelopment: false,
      message: 'No licence is installed. An administrator can install one under Administration → Licence. Your data is unaffected.',
      modules: [...ALWAYS_ON_MODULES], maxEmployees: 0, maxUsers: null, graceDays: 0,
    };
  }

  /* ------------------------------------------------------------- questions */

  async isOperational(orgId: string): Promise<boolean> {
    return (await this.getState(orgId)).operational;
  }

  async hasModule(orgId: string, module: LicensedModule): Promise<boolean> {
    const state = await this.getState(orgId);
    if (ALWAYS_ON_MODULES.includes(module)) return true;
    // A licence past its grace period keeps only the core, so an expired installation
    // stays readable and renewable rather than becoming a locked box.
    if (!state.operational) return false;
    return state.modules.includes(module);
  }

  /**
   * EMPLOYEE LIMIT SEMANTICS: ACTIVE employees only.
   *
   * A customer who has had staff leave should not be charged for them forever, and
   * counting historical rows would make the number drift upward on its own. Terminated
   * or archived people keep their feedback history and simply stop counting.
   */
  async activeEmployeeCount(orgId: string): Promise<number> {
    return this.prisma.employee.count({ where: { organizationId: orgId, status: 'active', deletedAt: null } });
  }

  async activeUserCount(orgId: string): Promise<number> {
    return this.prisma.user.count({ where: { organizationId: orgId, status: 'active', deletedAt: null } });
  }

  async getUsage(orgId: string): Promise<LicenseUsage> {
    const state = await this.getState(orgId);
    const [employees, users] = await Promise.all([this.activeEmployeeCount(orgId), this.activeUserCount(orgId)]);
    const max = state.maxEmployees;
    return {
      employees,
      maxEmployees: max,
      employeePercent: max > 0 ? Math.round((employees / max) * 100) : 0,
      users,
      maxUsers: state.maxUsers,
    };
  }

  /**
   * The gate for anything that adds people. Throws with a message an administrator can
   * act on — never silently truncates, which for a bulk import would mean a half-loaded
   * organisation nobody notices until reports look wrong.
   */
  async assertCanAddEmployees(orgId: string, count: number): Promise<void> {
    const state = await this.getState(orgId);
    if (!state.operational) {
      throw new BadRequestException(`${state.message} Adding employees is not possible until a valid licence is installed.`);
    }
    if (!state.maxEmployees) return; // unlimited
    const current = await this.activeEmployeeCount(orgId);
    if (current + count <= state.maxEmployees) return;
    const room = Math.max(0, state.maxEmployees - current);
    throw new BadRequestException(
      `This licence covers ${state.maxEmployees} active employees. ` +
      `You currently have ${current}, so there is room for ${room} more, but ${count} ` +
      `${count === 1 ? 'was' : 'were'} requested. Nothing has been added. ` +
      'Deactivate employees who have left, or upgrade the licence.',
    );
  }

  /* ------------------------------------------------------------- installing */

  private async read(orgId: string): Promise<{ licenseKey: string; installedAt?: string; suspended?: boolean } | null> {
    const row = await this.prisma.configuration.findFirst({
      where: { organizationId: orgId, module: MODULE, key: KEY, deletedAt: null },
      select: { value: true },
    });
    return (row?.value as { licenseKey: string; installedAt?: string; suspended?: boolean }) ?? null;
  }

  /**
   * Install or replace the licence. Verified BEFORE it is written, so a bad paste
   * cannot displace a working licence.
   */
  async install(orgId: string, userId: string | null, licenseKey: string): Promise<LicenseState> {
    const result = verifyLicense(licenseKey);
    if (!result.ok) {
      throw new BadRequestException(
        // On a customer build the key is compiled in, so there is nothing the
        // administrator can set to fix this — it means the build itself is wrong, and
        // the only honest instruction is to contact the supplier.
        result.reason === 'no-public-key'
          ? isInternalBuild()
            ? 'This development build has no licence verification key. Set LICENSE_PUBLIC_KEY and restart the API.'
            : 'This installation has no licence verification key, which means the build is faulty. Please contact your supplier — this cannot be fixed by configuration.'
          : 'That licence could not be verified. Check you pasted the whole licence, exactly as supplied.',
      );
    }
    const org = await this.prisma.organization.findUnique({ where: { id: orgId }, select: { slug: true } });
    if (org && result.payload.organizationSlug !== '*' && result.payload.organizationSlug !== org.slug) {
      throw new BadRequestException(
        `That licence was issued for the organisation "${result.payload.organizationSlug}", but this installation is "${org.slug}". ` +
        'Please ask your supplier for a licence issued to this organisation.',
      );
    }

    const value = { licenseKey: licenseKey.trim(), installedAt: new Date().toISOString(), installedBy: userId, suspended: false };
    const existing = await this.prisma.configuration.findFirst({
      where: { organizationId: orgId, module: MODULE, key: KEY, deletedAt: null },
      select: { id: true },
    });
    if (existing) {
      await this.prisma.configuration.update({ where: { id: existing.id }, data: { value: value as Prisma.InputJsonValue, updatedBy: userId } });
    } else {
      await this.prisma.configuration.create({
        data: { organizationId: orgId, module: MODULE, key: KEY, value: value as Prisma.InputJsonValue, createdBy: userId, updatedBy: userId },
      });
    }
    this.invalidate(orgId);
    return this.getState(orgId);
  }
}

/** Dates are shown to administrators, so format them like a person would write one. */
function fmt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
