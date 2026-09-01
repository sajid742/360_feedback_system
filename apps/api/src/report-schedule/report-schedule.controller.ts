import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/auth/jwt-auth.guard';
import { PermissionsGuard } from '../common/auth/permissions.guard';
import { RequirePermissions } from '../common/auth/require-permissions.decorator';
import { CurrentUser, type AuthUser } from '../common/auth/current-user';
import { ReportScheduleService } from './report-schedule.service';
import { CreateScheduleDto } from './report-schedule.dto';
import { REPORTS_PERMISSIONS as P } from '../reports/reports.permissions';

@Controller('reports/schedules')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ReportScheduleController {
  constructor(private readonly schedules: ReportScheduleService) {}

  @Get()
  @RequirePermissions(P.read)
  list(@CurrentUser() user: AuthUser) {
    return this.schedules.list(user);
  }

  @Post()
  @RequirePermissions(P.manage)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateScheduleDto) {
    return this.schedules.create(user, dto);
  }

  @Delete(':id')
  @RequirePermissions(P.manage)
  async remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.schedules.remove(user, id);
    return { id, deleted: true };
  }

  @Post(':id/run')
  @RequirePermissions(P.manage)
  run(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.schedules.runNow(user, id);
  }
}
