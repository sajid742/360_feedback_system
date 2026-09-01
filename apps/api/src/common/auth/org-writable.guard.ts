import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from './current-user';

/**
 * Makes organization master data (employees, departments, designations, campuses)
 * READ-ONLY when the tenant is in External HR mode — HR is then the source of
 * truth. Read requests (GET/HEAD/OPTIONS) always pass; mutating requests are
 * refused with a clear message. Applied at the controller level, so no business
 * logic changes. Reads the mode straight from the `configurations` table to avoid
 * any module coupling.
 */
@Injectable()
export class OrgWritableGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{ method: string; user?: AuthUser }>();
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
    const orgId = req.user?.organizationId;
    if (!orgId) return true; // auth guard runs first; nothing to gate without a tenant
    const row = await this.prisma.configuration.findFirst({
      where: { organizationId: orgId, module: 'hr_integration', key: 'settings', deletedAt: null },
      select: { value: true },
    });
    const mode = (row?.value as { mode?: string } | null)?.mode ?? 'internal';
    if (mode === 'external_hr') {
      throw new ForbiddenException('Organization data is managed by the external HR system and is read-only. Change the data source to Internal to edit it here.');
    }
    return true;
  }
}
