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
import { CycleService } from './services/cycle.service';
import { CycleTemplateService } from './services/cycle-template.service';
import { SetupService } from './services/setup.service';
import { AssignmentService } from './services/assignment.service';
import { ScoringService } from './services/scoring.service';
import { ReminderService } from './services/reminder.service';
import { APPRAISAL_PERMISSIONS as P } from './appraisal.permissions';
import {
  AddParticipantDto,
  AddSourceDto,
  UpdateSourceDto,
  SetParentModeDto,
  SetSourceTemplateDto,
  ApplyCycleTemplateDto,
  CalibrateDto,
  CreateAssignmentDto,
  CreateCycleDto,
  UpdateCycleDto,
  ImportParticipantsDto,
  SaveCycleTemplateDto,
  SetPotentialDto,
  SubmitFeedbackDto,
  ReminderSettingsDto,
} from './appraisal.dto';

@Controller('appraisal')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AppraisalController {
  constructor(
    private readonly cycles: CycleService,
    private readonly cycleTemplates: CycleTemplateService,
    private readonly setup: SetupService,
    private readonly assignments: AssignmentService,
    private readonly scoring: ScoringService,
    private readonly reminders: ReminderService,
  ) {}

  /* Cycles */
  @Get('cycles')
  @RequirePermissions(P.read)
  listCycles(@CurrentUser() user: AuthUser) {
    return this.cycles.list(user);
  }

  @Get('cycles/:id')
  @RequirePermissions(P.read)
  getCycle(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.cycles.get(user, id);
  }

  @Post('cycles')
  @RequirePermissions(P.cycleManage)
  createCycle(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Body() dto: CreateCycleDto) {
    return this.cycles.create(user, ctx, dto);
  }

  /** Edit a draft or active cycle — notably to correct or extend its submission deadline. */
  @Put('cycles/:id')
  @RequirePermissions(P.cycleManage)
  updateCycle(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCycleDto,
  ) {
    return this.cycles.update(user, ctx, id, dto);
  }

  @Post('cycles/:id/activate')
  @HttpCode(200)
  @RequirePermissions(P.cycleManage)
  activate(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.cycles.setStatus(user, ctx, id, 'active');
  }

  @Post('cycles/:id/close')
  @HttpCode(200)
  @RequirePermissions(P.cycleManage)
  close(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.cycles.setStatus(user, ctx, id, 'closed');
  }

  @Post('cycles/:id/clone')
  @HttpCode(200)
  @RequirePermissions(P.cycleManage)
  clone(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.cycles.clone(user, ctx, id);
  }

  /* Reusable cycle templates (F31) */
  @Get('cycle-templates')
  @RequirePermissions(P.read)
  listCycleTemplates(@CurrentUser() user: AuthUser) {
    return this.cycleTemplates.list(user);
  }

  @Post('cycle-templates')
  @RequirePermissions(P.cycleManage)
  saveCycleTemplate(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Body() dto: SaveCycleTemplateDto) {
    return this.cycleTemplates.saveFromCycle(user, ctx, dto.fromCycleId, dto.name, dto.description);
  }

  @Delete('cycle-templates/:templateId')
  @HttpCode(200)
  @RequirePermissions(P.cycleManage)
  deleteCycleTemplate(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Param('templateId', ParseUUIDPipe) templateId: string) {
    return this.cycleTemplates.remove(user, ctx, templateId);
  }

  @Post('cycle-templates/:templateId/apply')
  @HttpCode(200)
  @RequirePermissions(P.cycleManage)
  applyCycleTemplate(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @Body() dto: ApplyCycleTemplateDto,
  ) {
    return this.cycleTemplates.apply(user, ctx, templateId, dto);
  }

  /* Sources */
  @Get('cycles/:id/sources')
  @RequirePermissions(P.read)
  listSources(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.setup.listSources(user, id);
  }

  @Post('cycles/:id/sources')
  @RequirePermissions(P.cycleManage)
  addSource(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddSourceDto) {
    return this.setup.addSource(user, ctx, id, dto);
  }

  /**
   * Set or clear the questionnaire used by ONE quadrant. Omitting templateId (or sending
   * null) restores the default of inheriting the cycle questionnaire.
   */
  /** Change a quadrant's label, weight, required count or anonymity. `code` is not editable. */
  @Put('cycles/:id/sources/:sourceId')
  @RequirePermissions(P.cycleManage)
  updateSource(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sourceId', ParseUUIDPipe) sourceId: string,
    @Body() dto: UpdateSourceDto,
  ) {
    return this.setup.updateSource(user, ctx, id, sourceId, dto);
  }

  @Put('cycles/:id/sources/:sourceId/template')
  @RequirePermissions(P.cycleManage)
  setSourceTemplate(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sourceId', ParseUUIDPipe) sourceId: string,
    @Body() dto: SetSourceTemplateDto,
  ) {
    return this.setup.setSourceTemplate(user, ctx, id, sourceId, dto.templateId ?? null);
  }

  /**
   * Choose how the Parents quadrant collects feedback: one form per teacher (the
   * default) or one consolidated form per student covering all of that student's
   * teachers. Each rating lands on the teacher's own assignment either way.
   */
  @Put('cycles/:id/sources/:sourceId/parent-mode')
  @RequirePermissions(P.cycleManage)
  setParentMode(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sourceId', ParseUUIDPipe) sourceId: string,
    @Body() dto: SetParentModeDto,
  ) {
    return this.setup.setParentMode(user, ctx, id, sourceId, dto.mode ?? null, dto.requireAll ?? false);
  }

  /**
   * Competency × quadrant coverage for a cycle, derived from the questionnaires attached
   * to each quadrant. Shows which competencies each evaluator group is asked about and
   * which are therefore comparable across groups. Configuration only — no scores.
   */
  @Get('cycles/:id/coverage')
  @RequirePermissions(P.read)
  coverage(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.setup.coverage(user, id);
  }

  @Delete('cycles/:id/sources/:sourceId')
  @HttpCode(200)
  @RequirePermissions(P.cycleManage)
  async removeSource(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Param('sourceId', ParseUUIDPipe) sourceId: string) {
    await this.setup.removeSource(user, ctx, id, sourceId);
    return { id: sourceId };
  }

  /* Participants */
  @Get('cycles/:id/participants')
  @RequirePermissions(P.read)
  listParticipants(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.setup.listParticipants(user, id);
  }

  @Post('cycles/:id/participants')
  @RequirePermissions(P.cycleManage)
  addParticipant(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddParticipantDto) {
    return this.setup.addParticipant(user, ctx, id, dto);
  }

  @Post('cycles/:id/participants/import')
  @HttpCode(200)
  @RequirePermissions(P.cycleManage)
  importParticipants(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ImportParticipantsDto) {
    return this.setup.importParticipants(user, ctx, id, dto.emails);
  }

  @Get('cycles/:id/participation')
  @RequirePermissions(P.read)
  participation(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.setup.participation(user, id);
  }

  @Delete('cycles/:id/participants/:participantId')
  @HttpCode(200)
  @RequirePermissions(P.cycleManage)
  async removeParticipant(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Param('participantId', ParseUUIDPipe) participantId: string) {
    await this.setup.removeParticipant(user, ctx, id, participantId);
    return { id: participantId };
  }

  @Post('cycles/:id/participants/:participantId/release')
  @HttpCode(200)
  @RequirePermissions(P.cycleManage)
  release(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('participantId', ParseUUIDPipe) participantId: string,
  ) {
    return this.setup.setRelease(user, ctx, id, participantId, true);
  }

  @Post('cycles/:id/participants/:participantId/retract')
  @HttpCode(200)
  @RequirePermissions(P.cycleManage)
  retract(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('participantId', ParseUUIDPipe) participantId: string,
  ) {
    return this.setup.setRelease(user, ctx, id, participantId, false);
  }

  /** Manually remind every outstanding reviewer in a cycle. */
  @Post('cycles/:id/remind')
  @HttpCode(200)
  @RequirePermissions(P.cycleManage)
  remind(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.reminders.remindCycle(user, id);
  }

  /* ---- Reminder settings (F6) ---- */
  @Get('reminder-settings')
  @RequirePermissions(P.read)
  reminderSettings(@CurrentUser() user: AuthUser) {
    return this.reminders.reminderSettings(user.organizationId);
  }

  @Put('reminder-settings')
  @RequirePermissions(P.cycleManage)
  setReminderSettings(@CurrentUser() user: AuthUser, @Body() dto: ReminderSettingsDto) {
    return this.reminders.setReminderSettings(user, dto);
  }

  @Post('participants/:participantId/potential')
  @HttpCode(200)
  @RequirePermissions(P.calibrate)
  setPotential(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Param('participantId', ParseUUIDPipe) participantId: string,
    @Body() dto: SetPotentialDto,
  ) {
    return this.scoring.setPotential(user, ctx, participantId, dto.potential);
  }

  @Post('participants/:participantId/calibrate')
  @HttpCode(200)
  @RequirePermissions(P.calibrate)
  calibrate(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Param('participantId', ParseUUIDPipe) participantId: string,
    @Body() dto: CalibrateDto,
  ) {
    return this.scoring.calibrate(user, ctx, participantId, dto.finalScore, dto.reason);
  }

  /* Assignments + feedback */
  /** Paginated reviewer assignments; `nominationStatus` narrows to the approval queue (F-P5). */
  @Get('cycles/:id/assignments')
  @RequirePermissions(P.read)
  listAssignments(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('nominationStatus') nominationStatus?: string,
  ) {
    return this.assignments.list(user, id, { page: Number(page), pageSize: Number(pageSize), nominationStatus });
  }

  @Post('cycles/:id/assignments')
  @RequirePermissions(P.assignManage)
  createAssignment(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateAssignmentDto) {
    return this.assignments.create(user, ctx, id, dto);
  }

  @Post('assignments/:id/nominate/approve')
  @HttpCode(200)
  @RequirePermissions(P.assignManage)
  approveNomination(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.assignments.setNomination(user, ctx, id, true);
  }

  @Post('assignments/:id/nominate/reject')
  @HttpCode(200)
  @RequirePermissions(P.assignManage)
  rejectNomination(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.assignments.setNomination(user, ctx, id, false);
  }

  @Post('assignments/:id/remind')
  @HttpCode(200)
  @RequirePermissions(P.cycleManage)
  remindAssignment(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.reminders.remindAssignment(user, id);
  }

  @Get('my-reviews')
  @RequirePermissions(P.read)
  myReviews(@CurrentUser() user: AuthUser) {
    return this.assignments.myReviews(user);
  }

  @Get('assignments/:id/form')
  @RequirePermissions(P.read)
  form(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.assignments.form(user, id);
  }

  @Post('assignments/:id/save')
  @HttpCode(200)
  @RequirePermissions(P.submitFeedback)
  saveDraft(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SubmitFeedbackDto) {
    return this.assignments.saveDraft(user, ctx, id, dto);
  }

  @Post('assignments/:id/submit')
  @HttpCode(200)
  @RequirePermissions(P.submitFeedback)
  submit(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SubmitFeedbackDto) {
    return this.assignments.submit(user, ctx, id, dto);
  }
}
