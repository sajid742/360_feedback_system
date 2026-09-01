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
import { CurrentUser, ReqContext, type AuthUser, type RequestContext } from '../common/auth/current-user';
import { QuestionService } from './services/question.service';
import { TemplateService } from './services/template.service';
import { RubricService } from './services/rubric.service';
import { QUESTIONNAIRE_PERMISSIONS as P } from './questionnaire.permissions';
import {
  AddSectionDto,
  AddSectionQuestionDto,
  CreateQuestionDto,
  CreateRubricDto,
  CreateTemplateDto,
  QuestionQueryDto,
  UpdateQuestionDto,
} from './questionnaire.dto';

@Controller('questionnaire')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class QuestionnaireController {
  constructor(
    private readonly questions: QuestionService,
    private readonly templates: TemplateService,
    private readonly rubrics: RubricService,
  ) {}

  /* Question bank */
  @Get('questions')
  @RequirePermissions(P.read)
  listQuestions(@CurrentUser() user: AuthUser, @Query() query: QuestionQueryDto) {
    return this.questions.list(user, query);
  }

  @Post('questions')
  @RequirePermissions(P.questionManage)
  createQuestion(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Body() dto: CreateQuestionDto) {
    return this.questions.create(user, ctx, dto);
  }

  @Put('questions/:id')
  @RequirePermissions(P.questionManage)
  updateQuestion(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateQuestionDto,
  ) {
    return this.questions.update(user, ctx, id, dto);
  }

  @Delete('questions/:id')
  @HttpCode(200)
  @RequirePermissions(P.questionManage)
  async removeQuestion(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.questions.remove(user, ctx, id);
    return { id };
  }

  /* Templates */
  @Get('templates')
  @RequirePermissions(P.read)
  listTemplates(@CurrentUser() user: AuthUser) {
    return this.templates.list(user);
  }

  @Get('templates/:id')
  @RequirePermissions(P.read)
  getTemplate(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.templates.get(user, id);
  }

  @Post('templates')
  @RequirePermissions(P.templateManage)
  createTemplate(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Body() dto: CreateTemplateDto) {
    return this.templates.create(user, ctx, dto);
  }

  @Post('templates/:id/sections')
  @RequirePermissions(P.templateManage)
  addSection(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddSectionDto) {
    return this.templates.addSection(user, id, dto);
  }

  @Delete('templates/:id/sections/:sectionId')
  @RequirePermissions(P.templateManage)
  removeSection(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sectionId', ParseUUIDPipe) sectionId: string,
  ) {
    return this.templates.removeSection(user, id, sectionId);
  }

  @Post('templates/:id/sections/:sectionId/questions')
  @RequirePermissions(P.templateManage)
  addQuestion(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sectionId', ParseUUIDPipe) sectionId: string,
    @Body() dto: AddSectionQuestionDto,
  ) {
    return this.templates.addQuestion(user, id, sectionId, dto);
  }

  @Delete('templates/:id/section-questions/:sectionQuestionId')
  @RequirePermissions(P.templateManage)
  removeSectionQuestion(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sectionQuestionId', ParseUUIDPipe) sectionQuestionId: string,
  ) {
    return this.templates.removeQuestion(user, id, sectionQuestionId);
  }

  @Post('templates/:id/publish')
  @HttpCode(200)
  @RequirePermissions(P.templateManage)
  publish(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.templates.publish(user, ctx, id);
  }

  @Post('templates/:id/clone')
  @RequirePermissions(P.templateManage)
  clone(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.templates.clone(user, ctx, id);
  }

  /* Rubrics */
  @Get('rubrics')
  @RequirePermissions(P.read)
  listRubrics(@CurrentUser() user: AuthUser) {
    return this.rubrics.list(user);
  }

  @Post('rubrics')
  @RequirePermissions(P.rubricManage)
  createRubric(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Body() dto: CreateRubricDto) {
    return this.rubrics.create(user, ctx, dto);
  }

  @Delete('rubrics/:id')
  @HttpCode(200)
  @RequirePermissions(P.rubricManage)
  async removeRubric(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.rubrics.remove(user, ctx, id);
    return { id };
  }
}
