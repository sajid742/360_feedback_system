import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/auth/jwt-auth.guard';
import { PermissionsGuard } from '../common/auth/permissions.guard';
import { RequirePermissions } from '../common/auth/require-permissions.decorator';
import { CurrentUser, type AuthUser } from '../common/auth/current-user';
import { IdentityMapService } from './identity-map.service';
import { IDENTITY_PERMISSIONS } from './identity.permissions';
import { UpsertIdentityMapDto } from './identity.dto';

@Controller('identity')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(IDENTITY_PERMISSIONS.manage)
export class IdentityController {
  constructor(private readonly identity: IdentityMapService) {}

  @Get('maps')
  list(@CurrentUser() user: AuthUser, @Query('type') type?: string, @Query('limit') limit?: string) {
    return this.identity.list(user.organizationId, type, Number(limit));
  }

  @Post('maps')
  upsert(@CurrentUser() user: AuthUser, @Body() dto: UpsertIdentityMapDto) {
    return this.identity.upsert(user, dto);
  }

  @Delete('maps/:id')
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.identity.remove(user.organizationId, id);
  }

  @Post('maps/unmap')
  unmap(@CurrentUser() user: AuthUser, @Body() body: { externalType: string; externalId: string }) {
    return this.identity.unmap(user.organizationId, body.externalType, body.externalId);
  }

  @Get('employees')
  employees(@CurrentUser() user: AuthUser, @Query('search') search?: string, @Query('limit') limit?: string) {
    return this.identity.employees(user.organizationId, { search, limit: Number(limit) });
  }

  /** SIS teachers with current mapping + code-matched suggestion. */
  @Get('teacher-mapping')
  teacherMapping(@CurrentUser() user: AuthUser) {
    return this.identity.suggestTeachers(user.organizationId);
  }
}
