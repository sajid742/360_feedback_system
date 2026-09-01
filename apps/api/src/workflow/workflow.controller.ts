import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/auth/jwt-auth.guard';
import { PermissionsGuard } from '../common/auth/permissions.guard';
import { RequirePermissions } from '../common/auth/require-permissions.decorator';
import { CurrentUser, ReqContext, type AuthUser, type RequestContext } from '../common/auth/current-user';
import { DefinitionService } from './services/definition.service';
import { EngineService } from './services/engine.service';
import { WORKFLOW_PERMISSIONS as P } from './workflow.permissions';
import { ActDto, CreateDefinitionDto, DelegateDto, StartInstanceDto } from './workflow.dto';

@Controller('workflow')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class WorkflowController {
  constructor(
    private readonly definitions: DefinitionService,
    private readonly engine: EngineService,
  ) {}

  @Get('definitions')
  @RequirePermissions(P.read)
  list(@CurrentUser() user: AuthUser, @Query('entityType') entityType?: string) {
    return this.definitions.list(user, entityType);
  }

  @Get('definitions/:id')
  @RequirePermissions(P.read)
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.definitions.get(user, id);
  }

  @Post('definitions')
  @RequirePermissions(P.manage)
  create(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Body() dto: CreateDefinitionDto) {
    return this.definitions.create(user, ctx, dto);
  }

  @Delete('definitions/:id')
  @HttpCode(200)
  @RequirePermissions(P.manage)
  async remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.definitions.remove(user, id);
    return { id };
  }

  @Post('instances')
  @RequirePermissions(P.manage)
  start(@CurrentUser() user: AuthUser, @Body() dto: StartInstanceDto) {
    return this.engine.start(user.organizationId, user.userId, dto.definitionId, dto.entityType, dto.entityId);
  }

  @Get('instances/:id')
  @RequirePermissions(P.read)
  instance(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.engine.instance(user, id);
  }

  @Get('my-tasks')
  @RequirePermissions(P.read)
  myTasks(@CurrentUser() user: AuthUser) {
    return this.engine.myTasks(user);
  }

  @Post('tasks/:id/act')
  @HttpCode(200)
  @RequirePermissions(P.act)
  act(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ActDto,
  ) {
    return this.engine.act(user, ctx, id, dto.decision, dto.comment);
  }

  @Post('tasks/:id/delegate')
  @HttpCode(200)
  @RequirePermissions(P.act)
  async delegate(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DelegateDto) {
    await this.engine.delegate(user, id, dto.toUserId);
    return { id };
  }
}
