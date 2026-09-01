import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../common/prisma/prisma.service';
import { provisionTenant, type ProvisionTenantResult } from './tenant-provisioning';

export interface ProvisioningStatus {
  /** True when the installation has no organisation yet — the first-run wizard applies. */
  needsSetup: boolean;
  /** True when provisioning is possible right now (first run, or a platform key is configured). */
  canProvision: boolean;
  /** True when a platform key is configured, so an operator can create further tenants. */
  keyConfigured: boolean;
  organizations: number;
}

export interface CreateOrganizationInput {
  orgName: string;
  slug: string;
  email: string;
  password: string;
  withStarterContent?: boolean;
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,118}[a-z0-9]$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * In-app organisation provisioning (F22).
 *
 * Creating a tenant used to require running `dist/provisioning/bootstrap.cli.js`
 * on the server, which meant no customer could be onboarded without a developer —
 * the single biggest barrier to operating this product independently. This service
 * exposes the SAME `provisionTenant()` routine over HTTP, behind two deliberately
 * narrow gates:
 *
 *  - **First run.** While the installation contains zero organisations, the setup
 *    wizard is open. There is nothing to protect yet, and requiring a secret to
 *    create the very first tenant would just move the CLI problem elsewhere.
 *  - **After that.** Every further organisation requires the platform provisioning
 *    key (`PLATFORM_PROVISIONING_KEY`), presented as `X-Provisioning-Key`. This is
 *    an operator credential, deliberately NOT a tenant permission: no signed-in
 *    user of organisation A should ever be able to create organisation B, so this
 *    surface is outside the RBAC system entirely.
 *
 * Fail-closed: if the key is unset once organisations exist, provisioning is
 * refused outright rather than falling back to something weaker.
 */
@Injectable()
export class ProvisioningService {
  private readonly logger = new Logger(ProvisioningService.name);

  constructor(private readonly prisma: PrismaService) {}

  private platformKey(): string {
    return process.env.PLATFORM_PROVISIONING_KEY ?? '';
  }

  async status(): Promise<ProvisioningStatus> {
    const organizations = await this.prisma.organization.count({ where: { deletedAt: null } });
    const keyConfigured = this.platformKey().length > 0;
    return {
      needsSetup: organizations === 0,
      canProvision: organizations === 0 || keyConfigured,
      keyConfigured,
      organizations,
    };
  }

  async create(input: CreateOrganizationInput, presentedKey: string | undefined): Promise<ProvisionTenantResult> {
    const orgCount = await this.prisma.organization.count({ where: { deletedAt: null } });
    this.assertAuthorized(orgCount, presentedKey);

    const orgName = (input.orgName ?? '').trim();
    const slug = (input.slug ?? '').trim().toLowerCase();
    const email = (input.email ?? '').trim().toLowerCase();

    if (orgName.length < 2) throw new BadRequestException('Organisation name is required.');
    if (!SLUG_PATTERN.test(slug)) {
      throw new BadRequestException(
        'Sign-in code must be 3–120 characters, lowercase letters, numbers and hyphens, and cannot start or end with a hyphen.',
      );
    }
    if (!EMAIL_PATTERN.test(email)) throw new BadRequestException('A valid administrator email address is required.');
    // The first admin's password is the only credential for a brand-new tenant and
    // is set before any org password policy exists, so enforce a floor here.
    if ((input.password ?? '').length < 10) {
      throw new BadRequestException('Administrator password must be at least 10 characters.');
    }

    const existing = await this.prisma.organization.findFirst({ where: { slug }, select: { id: true } });
    if (existing) throw new BadRequestException(`The sign-in code "${slug}" is already in use.`);

    // Re-check immediately before writing: two concurrent first-run requests could
    // both have observed an empty installation above.
    if (orgCount === 0 && (await this.prisma.organization.count({ where: { deletedAt: null } })) > 0) {
      throw new ForbiddenException('This installation has already been set up. A provisioning key is now required.');
    }

    const result = await provisionTenant(this.prisma, {
      orgName,
      slug,
      email,
      password: input.password,
      withStarterContent: input.withStarterContent !== false,
    });
    this.logger.log(
      `Provisioned organization "${slug}" (${result.created ? 'new admin' : 'existing admin reused'}), ` +
        `${result.rolesSeeded} roles, first-run=${orgCount === 0}`,
    );
    return result;
  }

  /** Open on first run; platform-key-only afterwards. Key comparison is timing-safe. */
  private assertAuthorized(orgCount: number, presentedKey: string | undefined): void {
    if (orgCount === 0) return;
    const expected = this.platformKey();
    if (!expected) {
      this.logger.warn('Provisioning refused: PLATFORM_PROVISIONING_KEY is not configured.');
      throw new ForbiddenException(
        'Organisation provisioning is disabled. Set PLATFORM_PROVISIONING_KEY on the server to enable it.',
      );
    }
    const a = Buffer.from(presentedKey ?? '', 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      this.logger.warn('Provisioning refused: invalid provisioning key.');
      throw new ForbiddenException('Invalid provisioning key.');
    }
  }
}
