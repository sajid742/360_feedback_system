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
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../common/auth/permissions.guard';
import { RequirePermissions } from '../../common/auth/require-permissions.decorator';
import {
  CurrentUser,
  ReqContext,
  type AuthUser,
  type RequestContext,
} from '../../common/auth/current-user';
import { CompetencyService } from '../services/competency.service';
import { VersionService } from '../services/version.service';
import { StatsService } from '../services/stats.service';
import { CompetencyQueryDto, CreateCompetencyDto, UpdateCompetencyDto } from '../dto/competency.dto';
import { COMPETENCY_PERMISSIONS } from '../competency.permissions';

@Controller('competency')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class CompetencyController {
  constructor(
    private readonly competencies: CompetencyService,
    private readonly versions: VersionService,
    private readonly stats: StatsService,
  ) {}

  @Get('stats')
  @RequirePermissions(COMPETENCY_PERMISSIONS.read)
  getStats(@CurrentUser() user: AuthUser) {
    return this.stats.summary(user);
  }

  @Get('competencies')
  @RequirePermissions(COMPETENCY_PERMISSIONS.read)
  list(@CurrentUser() user: AuthUser, @Query() query: CompetencyQueryDto) {
    return this.competencies.list(user, query);
  }

  @Get('competencies/:id')
  @RequirePermissions(COMPETENCY_PERMISSIONS.read)
  getOne(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.competencies.getById(user, id);
  }

  @Post('competencies')
  @RequirePermissions(COMPETENCY_PERMISSIONS.create)
  create(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Body() dto: CreateCompetencyDto,
  ) {
    return this.competencies.create(user, ctx, dto);
  }

  @Put('competencies/:id')
  @RequirePermissions(COMPETENCY_PERMISSIONS.update)
  update(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCompetencyDto,
  ) {
    return this.competencies.update(user, ctx, id, dto);
  }

  @Delete('competencies/:id')
  @HttpCode(200)
  @RequirePermissions(COMPETENCY_PERMISSIONS.archive)
  async archive(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.competencies.archive(user, ctx, id);
    return { id };
  }

  @Post('competencies/:id/versions')
  @RequirePermissions(COMPETENCY_PERMISSIONS.versionManage)
  cloneDraft(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.versions.cloneDraft(user, ctx, id);
  }

  @Post('versions/:versionId/activate')
  @RequirePermissions(COMPETENCY_PERMISSIONS.versionManage)
  activate(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Param('versionId', ParseUUIDPipe) versionId: string,
  ) {
    return this.versions.activate(user, ctx, versionId);
  }
}
