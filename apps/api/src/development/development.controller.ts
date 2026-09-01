import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/auth/jwt-auth.guard';
import { PermissionsGuard } from '../common/auth/permissions.guard';
import { RequirePermissions } from '../common/auth/require-permissions.decorator';
import { CurrentUser, ReqContext, type AuthUser, type RequestContext } from '../common/auth/current-user';
import { DevelopmentService } from './development.service';
import { CreateActionDto, UpdateActionDto } from './dto/development.dto';
import { DEVELOPMENT_PERMISSIONS as P } from './development.permissions';

@Controller('development')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class DevelopmentController {
  constructor(private readonly development: DevelopmentService) {}

  @Get('actions')
  @RequirePermissions(P.read)
  list(@CurrentUser() user: AuthUser, @Query('employeeId') employeeId?: string) {
    return this.development.list(user, employeeId);
  }

  @Post('actions')
  @RequirePermissions(P.manage)
  create(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Body() dto: CreateActionDto) {
    return this.development.create(user, ctx, dto);
  }

  @Put('actions/:id')
  @RequirePermissions(P.manage)
  update(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateActionDto,
  ) {
    return this.development.update(user, ctx, id, dto);
  }

  @Delete('actions/:id')
  @RequirePermissions(P.manage)
  async remove(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.development.remove(user, ctx, id);
    return { id, deleted: true };
  }
}
