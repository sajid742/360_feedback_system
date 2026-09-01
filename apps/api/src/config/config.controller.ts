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
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/auth/jwt-auth.guard';
import { PermissionsGuard } from '../common/auth/permissions.guard';
import { RequirePermissions } from '../common/auth/require-permissions.decorator';
import {
  CurrentUser,
  ReqContext,
  type AuthUser,
  type RequestContext,
} from '../common/auth/current-user';
import { ConfigurationService } from './services/configuration.service';
import { FeatureFlagService } from './services/feature-flag.service';
import { RatingScaleService } from './services/rating-scale.service';
import {
  CreateFeatureFlagDto,
  CreateRatingScaleDto,
  SetConfigurationDto,
  UpdateFeatureFlagDto,
  UpdateRatingScaleDto,
} from './dto/config.dto';
import { CONFIG_PERMISSIONS } from './config.permissions';

@Controller('configuration')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ConfigController {
  constructor(
    private readonly configurations: ConfigurationService,
    private readonly featureFlags: FeatureFlagService,
    private readonly ratingScales: RatingScaleService,
  ) {}

  /* Generic configuration */
  @Get()
  @RequirePermissions(CONFIG_PERMISSIONS.read)
  list(@CurrentUser() user: AuthUser, @Query('module') module?: string) {
    return this.configurations.list(user, module);
  }

  @Post()
  @RequirePermissions(CONFIG_PERMISSIONS.manage)
  set(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Body() dto: SetConfigurationDto,
  ) {
    return this.configurations.set(user, ctx, dto);
  }

  @Delete(':id')
  @HttpCode(200)
  @RequirePermissions(CONFIG_PERMISSIONS.manage)
  async remove(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.configurations.remove(user, ctx, id);
    return { id };
  }

  /* Feature flags */
  @Get('feature-flags')
  @RequirePermissions(CONFIG_PERMISSIONS.featureFlagRead)
  listFlags(@CurrentUser() user: AuthUser) {
    return this.featureFlags.list(user);
  }

  @Post('feature-flags')
  @RequirePermissions(CONFIG_PERMISSIONS.featureFlagManage)
  createFlag(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Body() dto: CreateFeatureFlagDto,
  ) {
    return this.featureFlags.create(user, ctx, dto);
  }

  @Put('feature-flags/:id')
  @RequirePermissions(CONFIG_PERMISSIONS.featureFlagManage)
  updateFlag(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateFeatureFlagDto,
  ) {
    return this.featureFlags.update(user, ctx, id, dto);
  }

  @Delete('feature-flags/:id')
  @HttpCode(200)
  @RequirePermissions(CONFIG_PERMISSIONS.featureFlagManage)
  async removeFlag(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.featureFlags.remove(user, ctx, id);
    return { id };
  }

  /* Rating scales */
  @Get('rating-scales')
  @RequirePermissions(CONFIG_PERMISSIONS.ratingScaleRead)
  listScales(@CurrentUser() user: AuthUser) {
    return this.ratingScales.list(user);
  }

  @Post('rating-scales')
  @RequirePermissions(CONFIG_PERMISSIONS.ratingScaleManage)
  createScale(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Body() dto: CreateRatingScaleDto,
  ) {
    return this.ratingScales.create(user, ctx, dto);
  }

  @Put('rating-scales/:id')
  @RequirePermissions(CONFIG_PERMISSIONS.ratingScaleManage)
  updateScale(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRatingScaleDto,
  ) {
    return this.ratingScales.update(user, ctx, id, dto);
  }

  @Delete('rating-scales/:id')
  @HttpCode(200)
  @RequirePermissions(CONFIG_PERMISSIONS.ratingScaleManage)
  async removeScale(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.ratingScales.remove(user, ctx, id);
    return { id };
  }
}
