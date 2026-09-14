import { Body, Controller, Delete, Get, HttpCode, Post, Put, UseGuards } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString, Length } from 'class-validator';
import { JwtAuthGuard } from '../common/auth/jwt-auth.guard';
import { PermissionsGuard } from '../common/auth/permissions.guard';
import { RequirePermissions } from '../common/auth/require-permissions.decorator';
import { CurrentUser, ReqContext, type AuthUser, type RequestContext } from '../common/auth/current-user';
import { LicensedFeatureGuard, RequiresLicensedModule } from '../license/licensed-feature.guard';
import { CONFIG_PERMISSIONS } from '../config/config.permissions';
import { AiProviderService, type AiProviderView } from './services/ai-provider.service';

export class SaveAiProviderDto {
  /** Leave it out to keep the provider on; send false to keep the settings but stop using it. */
  @IsOptional() @IsBoolean() enabled?: boolean;

  @IsString() @Length(1, 300) baseUrl!: string;

  /**
   * Omit to keep the stored key. The screen cannot show it back, so requiring it on
   * every save would mean re-typing a secret to change a model name.
   */
  @IsOptional() @IsString() @Length(0, 300) apiKey?: string;

  @IsOptional() @IsString() @Length(0, 120) model?: string;
}

/**
 * The AI provider settings surface.
 *
 * SEPARATE FROM `AiController` ON PURPOSE, and gated differently.
 *
 * Viewing insights is `ai.read`, which Managers and Viewers hold. CONFIGURING a provider
 * is an administrative act that spends money and sends data outside the organisation, so
 * it takes `configuration.manage` — the same permission that gates Licence and Settings.
 *
 * It also deliberately does NOT sit behind `AiEnabledGuard`: an administrator has to be
 * able to set a provider up before, or while, the `ai_insights` feature flag is off. The
 * licence check stays, because there is no sense configuring a module you have not
 * bought.
 */
@RequiresLicensedModule('ai_insights')
@Controller('ai/provider')
@UseGuards(JwtAuthGuard, PermissionsGuard, LicensedFeatureGuard)
export class AiProviderController {
  constructor(private readonly provider: AiProviderService) {}

  /** The saved settings, with the key masked to its last four characters. */
  @Get()
  @RequirePermissions(CONFIG_PERMISSIONS.read)
  view(@CurrentUser() user: AuthUser): Promise<AiProviderView> {
    return this.provider.view(user.organizationId);
  }

  @Put()
  @RequirePermissions(CONFIG_PERMISSIONS.manage)
  save(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Body() dto: SaveAiProviderDto,
  ): Promise<AiProviderView> {
    return this.provider.save(user, ctx, dto);
  }

  @Delete()
  @RequirePermissions(CONFIG_PERMISSIONS.manage)
  remove(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext): Promise<AiProviderView> {
    return this.provider.remove(user, ctx);
  }

  /**
   * Send one trivial prompt to the saved provider and report what happened.
   *
   * The fallback to the built-in engine is designed to be invisible, which is precisely
   * what makes a wrong key hard to notice — without this, the first sign of a
   * misconfiguration is a manager quietly getting the heuristic paragraph for weeks.
   */
  @Post('test')
  @HttpCode(200)
  @RequirePermissions(CONFIG_PERMISSIONS.manage)
  test(@CurrentUser() user: AuthUser): Promise<{ ok: boolean; model: string | null; detail: string }> {
    return this.provider.test(user.organizationId);
  }
}
