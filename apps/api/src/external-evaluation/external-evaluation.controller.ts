import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { LicensedFeatureGuard, RequiresLicensedModule } from '../license/licensed-feature.guard';
import { JwtAuthGuard } from '../common/auth/jwt-auth.guard';
import { PermissionsGuard } from '../common/auth/permissions.guard';
import { RequirePermissions } from '../common/auth/require-permissions.decorator';
import { CurrentUser, ReqContext, type AuthUser, type RequestContext } from '../common/auth/current-user';
import { EvaluationLinkService } from './services/evaluation-link.service';
import { EXTERNAL_EVAL_PERMISSIONS } from './external-evaluation.permissions';
import { CreateConsolidatedLinkDto, CreateEvaluationLinkDto, SendEvaluationLinkDto } from './external-evaluation.dto';

@RequiresLicensedModule('parent_feedback')
@Controller('external-evaluation')
@UseGuards(JwtAuthGuard, PermissionsGuard, LicensedFeatureGuard)
@RequirePermissions(EXTERNAL_EVAL_PERMISSIONS.manage)
export class ExternalEvaluationController {
  constructor(private readonly links: EvaluationLinkService) {}

  @Post()
  create(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Body() dto: CreateEvaluationLinkDto) {
    return this.links.create(user, dto, dto.cycleId, ctx);
  }

  /** One consolidated form per student, covering every teacher that student has. */
  @Post('consolidated')
  createConsolidated(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Body() dto: CreateConsolidatedLinkDto) {
    return this.links.createConsolidated(user, dto, ctx);
  }

  /** Which parent feedback mode a cycle is configured for — drives the admin UI. */
  @Get('mode')
  mode(@CurrentUser() user: AuthUser, @Query('cycleId') cycleId?: string) {
    return this.links.parentModeOf(user.organizationId, cycleId);
  }

  /**
   * The cycles this page can target, and the names of the ones it cannot.
   *
   * Declared BEFORE `@Get(':id')`: Nest matches in declaration order, so below it
   * `cycles` would be swallowed by the id route and rejected by its UUID pipe.
   */
  @Get('cycles')
  cycles(@CurrentUser() user: AuthUser) {
    return this.links.cycles(user.organizationId);
  }

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('studentId') studentId?: string) {
    return this.links.list(user, studentId);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.links.get(user, id);
  }

  @Post(':id/revoke')
  @HttpCode(200)
  revoke(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.links.revoke(user, id, ctx);
  }

  @Post(':id/regenerate')
  @HttpCode(200)
  regenerate(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SendEvaluationLinkDto) {
    return this.links.regenerate(user, id, dto, ctx);
  }
}
