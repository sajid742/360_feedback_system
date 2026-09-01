import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { LicensedFeatureGuard, RequiresLicensedModule } from '../license/licensed-feature.guard';
import { JwtAuthGuard } from '../common/auth/jwt-auth.guard';
import { PermissionsGuard } from '../common/auth/permissions.guard';
import { RequirePermissions } from '../common/auth/require-permissions.decorator';
import { CurrentUser, type AuthUser } from '../common/auth/current-user';
import { SIS_PERMISSIONS } from '../sis/sis.permissions';
import { SIS_INTEGRATION_PERMISSIONS } from './sis-integration.permissions';
import { SisMaintenanceService } from './sis-maintenance.service';
import {
  CreateSisParentDto, CreateSisStudentDto, SisEnrollmentDto, SisStudentQueryDto,
  UpdateSisParentDto, UpdateSisStudentDto,
} from './sis-maintenance.dto';

/**
 * Roster browse and maintenance — `/sis-integration/roster/*`.
 *
 * Two permission levels on purpose, and they are the ones that already exist:
 *   READ  `sis.read`                 — Super Admin, HR/Admin and Viewer. Browsing
 *                                      students, guardians and teachers stays
 *                                      available to read-only users.
 *   WRITE `organization.sis.manage`  — Super Admin and HR/Admin only. The same
 *                                      permission that already gates import and
 *                                      sync, because correcting the roster by hand
 *                                      is the same kind of act.
 * No new permission was introduced.
 */
@RequiresLicensedModule('sis_integration')
@Controller('sis-integration/roster')
@UseGuards(JwtAuthGuard, PermissionsGuard, LicensedFeatureGuard)
export class SisMaintenanceController {
  constructor(private readonly roster: SisMaintenanceService) {}

  private actor(user: AuthUser): { userId: string | null; name: string | null } {
    return { userId: user.userId, name: user.email };
  }

  /* ------------------------------------------------------------------ read */

  @Get('students')
  @RequirePermissions(SIS_PERMISSIONS.read)
  students(@CurrentUser() user: AuthUser, @Query() q: SisStudentQueryDto) {
    return this.roster.listStudents(user.organizationId, q);
  }

  @Get('students/:studentId')
  @RequirePermissions(SIS_PERMISSIONS.read)
  student(@CurrentUser() user: AuthUser, @Param('studentId') studentId: string) {
    return this.roster.studentDetail(user.organizationId, studentId);
  }

  @Get('options')
  @RequirePermissions(SIS_PERMISSIONS.read)
  options(@CurrentUser() user: AuthUser) {
    return this.roster.options(user.organizationId);
  }

  @Get('teaching-assignments')
  @RequirePermissions(SIS_PERMISSIONS.read)
  assignments(@CurrentUser() user: AuthUser, @Query('search') search?: string) {
    return this.roster.teachingAssignments(user.organizationId, search);
  }

  @Get('teachers')
  @RequirePermissions(SIS_PERMISSIONS.read)
  teachers(@CurrentUser() user: AuthUser) {
    return this.roster.teachers(user.organizationId);
  }

  /* ----------------------------------------------------------------- write */

  @Post('students')
  @RequirePermissions(SIS_INTEGRATION_PERMISSIONS.manage)
  createStudent(@CurrentUser() user: AuthUser, @Body() dto: CreateSisStudentDto) {
    return this.roster.createStudent(user.organizationId, this.actor(user), { ...dto });
  }

  @Put('students/:studentId')
  @RequirePermissions(SIS_INTEGRATION_PERMISSIONS.manage)
  updateStudent(@CurrentUser() user: AuthUser, @Param('studentId') studentId: string, @Body() dto: UpdateSisStudentDto) {
    return this.roster.updateStudent(user.organizationId, this.actor(user), studentId, { ...dto });
  }

  @Post('students/:studentId/status')
  @RequirePermissions(SIS_INTEGRATION_PERMISSIONS.manage)
  setStatus(@CurrentUser() user: AuthUser, @Param('studentId') studentId: string, @Body() body: { status: string }) {
    return this.roster.setStudentStatus(user.organizationId, this.actor(user), studentId, body?.status);
  }

  @Post('students/:studentId/parents')
  @RequirePermissions(SIS_INTEGRATION_PERMISSIONS.manage)
  createParent(@CurrentUser() user: AuthUser, @Param('studentId') studentId: string, @Body() dto: CreateSisParentDto) {
    return this.roster.createParent(user.organizationId, this.actor(user), studentId, { ...dto });
  }

  @Put('parents/:parentId')
  @RequirePermissions(SIS_INTEGRATION_PERMISSIONS.manage)
  updateParent(@CurrentUser() user: AuthUser, @Param('parentId') parentId: string, @Body() dto: UpdateSisParentDto) {
    return this.roster.updateParent(user.organizationId, this.actor(user), parentId, { ...dto });
  }

  @Delete('parents/:parentId')
  @RequirePermissions(SIS_INTEGRATION_PERMISSIONS.manage)
  removeParent(@CurrentUser() user: AuthUser, @Param('parentId') parentId: string) {
    return this.roster.removeParent(user.organizationId, this.actor(user), parentId);
  }

  @Post('students/:studentId/enrollments')
  @RequirePermissions(SIS_INTEGRATION_PERMISSIONS.manage)
  addEnrollment(@CurrentUser() user: AuthUser, @Param('studentId') studentId: string, @Body() dto: SisEnrollmentDto) {
    return this.roster.addEnrollment(user.organizationId, this.actor(user), studentId, dto.teachingAssignmentId);
  }

  @Delete('students/:studentId/enrollments/:teachingAssignmentId')
  @RequirePermissions(SIS_INTEGRATION_PERMISSIONS.manage)
  removeEnrollment(@CurrentUser() user: AuthUser, @Param('studentId') studentId: string, @Param('teachingAssignmentId') taId: string) {
    return this.roster.removeEnrollment(user.organizationId, this.actor(user), studentId, taId);
  }
}
