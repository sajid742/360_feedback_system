import { CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type { AuthUser } from '../common/auth/current-user';

/**
 * The vendor's own operators.
 *
 * WHY THIS IS NOT A ROLE. Every tenant's Super Admin holds `security.rbac.manage`, so
 * a "Platform Admin" row in the `roles` table could be self-assigned — one customer's
 * administrator would become an operator of every customer. The boundary between a
 * tenant and the platform has to be structural, not another permission in the same
 * catalogue, so membership lives in its own table that no tenant-facing endpoint writes.
 *
 * WHY A DATABASE LOOKUP RATHER THAN A JWT CLAIM. A claim is fixed for the life of the
 * token, so revoking an operator would leave them in control until it expired. This
 * costs one indexed read on platform routes only, which are used by a handful of people
 * a handful of times a day.
 *
 * Platform membership grants NOTHING inside a tenant: these routes never read or write
 * a tenant's feedback data, and tenant permissions grant nothing here.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const user = context.switchToHttp().getRequest<{ user?: AuthUser }>().user;
    if (!user?.userId) throw new ForbiddenException('Platform administration requires a signed-in operator.');
    const row = await this.prisma.platformAdmin.findFirst({
      where: { userId: user.userId, deletedAt: null },
      select: { id: true },
    });
    if (!row) throw new ForbiddenException('This account is not a platform administrator.');
    return true;
  }
}
