import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { IsArray, IsBoolean, IsOptional, IsString, Length } from 'class-validator';
import { JwtAuthGuard } from '../common/auth/jwt-auth.guard';
import { PermissionsGuard } from '../common/auth/permissions.guard';
import { RequirePermissions } from '../common/auth/require-permissions.decorator';
import { CurrentUser, ReqContext, type AuthUser, type RequestContext } from '../common/auth/current-user';
import { RBAC_PERMISSIONS } from './rbac.permissions';
import { RbacService } from './rbac.service';

class SetRolesDto {
  @IsArray() @IsString({ each: true }) roleIds!: string[];
}
class SetActiveDto {
  @IsBoolean() active!: boolean;
}
class ResetPasswordDto {
  /** Optional admin-chosen temporary password; if omitted a strong one is generated. */
  @IsOptional() @IsString() @Length(8, 200) temporaryPassword?: string;
  /** Force the user to change it at next login (default true). */
  @IsOptional() @IsBoolean() requireChange?: boolean;
}

/**
 * RBAC administration — users, roles and assignments. Gated by `security.rbac.manage`
 * (held only by Super Admin). Authorization is enforced here on the API, not just in the UI.
 */
@Controller('rbac')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(RBAC_PERMISSIONS.manage)
export class RbacController {
  constructor(private readonly rbac: RbacService) {}

  @Get('roles')
  roles(@CurrentUser() user: AuthUser) {
    return this.rbac.roles(user.organizationId);
  }

  @Get('permissions')
  permissions() {
    return this.rbac.permissionCatalog();
  }

  @Get('matrix')
  matrix(@CurrentUser() user: AuthUser) {
    return this.rbac.matrix(user.organizationId);
  }

  @Get('users')
  users(
    @CurrentUser() user: AuthUser,
    @Query('search') search?: string,
    @Query('roleId') roleId?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.rbac.users(user.organizationId, search, roleId, status, { page: Number(page), pageSize: Number(pageSize) });
  }

  @Get('users/:id')
  user(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.rbac.userDetail(user.organizationId, id);
  }

  @Put('users/:id/roles')
  setRoles(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Param('id') id: string, @Body() dto: SetRolesDto) {
    return this.rbac.setUserRoles(user, ctx, id, dto.roleIds);
  }

  /**
   * Grant the default Employee role to every user that currently has no role (F-C1
   * repair path for people onboarded before default-role assignment existed).
   * Declared before ':id' routes so 'backfill-default-roles' isn't parsed as an id.
   */
  @Post('users/backfill-default-roles')
  @HttpCode(200)
  backfillDefaultRoles(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.rbac.backfillDefaultRoles(user, ctx);
  }

  @Post('users/:id/active')
  setActive(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Param('id') id: string, @Body() dto: SetActiveDto) {
    return this.rbac.setActive(user, ctx, id, dto.active);
  }

  /** Admin password reset: set/generate a temporary password (returned once) + optional force-change. */
  @Post('users/:id/reset-password')
  @HttpCode(200)
  resetPassword(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Param('id') id: string, @Body() dto: ResetPasswordDto) {
    return this.rbac.resetPassword(user, ctx, id, { temporaryPassword: dto.temporaryPassword, requireChange: dto.requireChange });
  }

  /** Email a set-password invitation instead of handing over a temporary password (F28). */
  @Post('users/:id/invite')
  @HttpCode(200)
  invite(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Param('id') id: string) {
    return this.rbac.sendInvitation(user, ctx, id);
  }
}
