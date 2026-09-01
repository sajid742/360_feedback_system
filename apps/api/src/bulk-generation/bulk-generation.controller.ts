import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/auth/jwt-auth.guard';
import { PermissionsGuard } from '../common/auth/permissions.guard';
import { RequirePermissions } from '../common/auth/require-permissions.decorator';
import { CurrentUser, ReqContext, type AuthUser, type RequestContext } from '../common/auth/current-user';
import { APPRAISAL_PERMISSIONS } from '../appraisal/appraisal.permissions';
import { BulkGenerationService } from './services/bulk-generation.service';
import { GenerateDto, PreviewDto } from './bulk-generation.dto';

/**
 * Bulk Feedback Cycle / Parent Feedback generation. Reuses the existing employee
 * hierarchy, Feedback Cycle, Reviewer, SIS, and Communication modules — it does not
 * introduce any parallel structure. Gated by the standard cycle-management permission.
 */
@Controller('appraisal/bulk')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(APPRAISAL_PERMISSIONS.cycleManage)
export class BulkGenerationController {
  constructor(private readonly bulk: BulkGenerationService) {}

  @Get('scopes')
  scopes(@CurrentUser() user: AuthUser) {
    return this.bulk.scopes(user.organizationId);
  }

  @Post('preview')
  preview(@CurrentUser() user: AuthUser, @Body() dto: PreviewDto) {
    return this.bulk.preview(user.organizationId, dto);
  }

  @Post('generate')
  generate(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Body() dto: GenerateDto) {
    return this.bulk.generate(user, ctx, dto);
  }

  @Get('runs')
  runs(@CurrentUser() user: AuthUser) {
    return this.bulk.listRuns(user.organizationId);
  }

  @Get('runs/:id')
  run(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.bulk.getRun(user.organizationId, id);
  }
}
