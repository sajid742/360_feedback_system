import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../common/auth/permissions.guard';
import { RequirePermissions } from '../../common/auth/require-permissions.decorator';
import {
  CurrentUser,
  ReqContext,
  type AuthUser,
  type RequestContext,
} from '../../common/auth/current-user';
import { IndicatorService } from '../services/indicator.service';
import { CreateIndicatorDto, UpdateIndicatorDto } from '../dto/indicator.dto';
import { COMPETENCY_PERMISSIONS } from '../competency.permissions';

@Controller('competency')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class IndicatorController {
  constructor(private readonly service: IndicatorService) {}

  @Get('versions/:versionId/indicators')
  @RequirePermissions(COMPETENCY_PERMISSIONS.indicatorRead)
  list(@CurrentUser() user: AuthUser, @Param('versionId', ParseUUIDPipe) versionId: string) {
    return this.service.list(user, versionId);
  }

  @Post('versions/:versionId/indicators')
  @RequirePermissions(COMPETENCY_PERMISSIONS.indicatorManage)
  add(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @Body() dto: CreateIndicatorDto,
  ) {
    return this.service.add(user, ctx, versionId, dto);
  }

  @Put('indicators/:indicatorId')
  @RequirePermissions(COMPETENCY_PERMISSIONS.indicatorManage)
  update(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Param('indicatorId', ParseUUIDPipe) indicatorId: string,
    @Body() dto: UpdateIndicatorDto,
  ) {
    return this.service.update(user, ctx, indicatorId, dto);
  }

  @Delete('indicators/:indicatorId')
  @HttpCode(200)
  @RequirePermissions(COMPETENCY_PERMISSIONS.indicatorManage)
  async remove(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Param('indicatorId', ParseUUIDPipe) indicatorId: string,
  ) {
    await this.service.remove(user, ctx, indicatorId);
    return { id: indicatorId };
  }
}
