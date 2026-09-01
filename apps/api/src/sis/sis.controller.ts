import { Controller, Get, Inject, Param, Query, UseGuards } from '@nestjs/common';
import { LicensedFeatureGuard, RequiresLicensedModule } from '../license/licensed-feature.guard';
import { JwtAuthGuard } from '../common/auth/jwt-auth.guard';
import { PermissionsGuard } from '../common/auth/permissions.guard';
import { RequirePermissions } from '../common/auth/require-permissions.decorator';
import { SIS_PROVIDER, type SisProvider } from './sis-provider.interface';
import { SIS_PERMISSIONS as P } from './sis.permissions';

/**
 * The 360 app's surface over the SIS. It delegates to the injected SisProvider,
 * so this controller (and everything else in the 360 app) is independent of
 * whether the data comes from the Mock SIS, a real SIS, or an ERP.
 */
@RequiresLicensedModule('sis_integration')
@Controller('sis')
@UseGuards(JwtAuthGuard, PermissionsGuard, LicensedFeatureGuard)
@RequirePermissions(P.read)
export class SisController {
  constructor(@Inject(SIS_PROVIDER) private readonly sis: SisProvider) {}

  @Get('campuses') campuses() { return this.sis.getCampuses(); }
  @Get('faculties') faculties() { return this.sis.getFaculties(); }
  @Get('departments') departments() { return this.sis.getDepartments(); }
  @Get('programs') programs() { return this.sis.getPrograms(); }
  @Get('sessions') sessions() { return this.sis.getSessions(); }
  @Get('semesters') semesters() { return this.sis.getSemesters(); }
  @Get('classes') classes() { return this.sis.getClasses(); }
  @Get('sections') sections() { return this.sis.getSections(); }

  /**
   * `search` matches name, registration number or roll number. It was added so the
   * Parent Evaluations picker can find a student without pulling the whole roster
   * and slicing it client-side — the behaviour that silently hid students past the
   * first 50. Callers that omit it behave exactly as before.
   */
  @Get('students')
  students(
    @Query('campusId') campusId?: string,
    @Query('programId') programId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('search') search?: string,
  ) {
    return this.sis.getStudents({ campusId, programId, search, limit: limit ? Number(limit) : undefined, offset: offset ? Number(offset) : undefined });
  }
  @Get('students/:id') student(@Param('id') id: string) { return this.sis.getStudent(id); }
  @Get('students/:id/parents') parents(@Param('id') id: string) { return this.sis.getParentsOfStudent(id); }
  @Get('students/:id/enrollments') enrollments(@Param('id') id: string) { return this.sis.getStudentEnrollments(id); }
  @Get('students/:id/teachers') teachersOfStudent(@Param('id') id: string) { return this.sis.getTeachersOfStudent(id); }

  @Get('teachers') teachers() { return this.sis.getTeachers(); }
  @Get('teachers/:id') teacher(@Param('id') id: string) { return this.sis.getTeacher(id); }
  @Get('teachers/:id/assignments') teacherAssignments(@Param('id') id: string) { return this.sis.getTeacherAssignments(id); }
  @Get('teachers/:id/students') studentsOfTeacher(@Param('id') id: string) { return this.sis.getStudentsOfTeacher(id); }

  @Get('subjects') subjects() { return this.sis.getSubjects(); }
  @Get('subjects/:id/students') studentsBySubject(@Param('id') id: string) { return this.sis.getStudentsBySubject(id); }

  @Get('teaching-assignments')
  assignments(@Query('teacherId') teacherId?: string, @Query('subjectId') subjectId?: string, @Query('sessionId') sessionId?: string) {
    return this.sis.getTeachingAssignments({ teacherId, subjectId, sessionId });
  }
  @Get('teaching-assignments/:id') assignment(@Param('id') id: string) { return this.sis.getTeachingAssignment(id); }
}
