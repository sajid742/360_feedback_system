import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiKeyGuard } from './common/api-key.guard';
import { SisService } from './sis.service';

/** Teaching assignments, enrollments and the derived teacher↔student views. */
@Controller()
@UseGuards(ApiKeyGuard)
export class TeachingController {
  constructor(private readonly sis: SisService) {}

  @Get('teaching-assignments')
  assignments(
    @Query('teacherId') teacherId?: string,
    @Query('subjectId') subjectId?: string,
    @Query('sessionId') sessionId?: string,
  ) {
    return this.sis.teachingAssignments(teacherId, subjectId, sessionId);
  }

  @Get('teaching-assignments/:id')
  assignment(@Param('id', ParseUUIDPipe) id: string) {
    return this.sis.teachingAssignmentDetails(id);
  }

  @Get('teachers/:id/assignments')
  teacherAssignments(@Param('id', ParseUUIDPipe) id: string) {
    return this.sis.teacherAssignments(id);
  }

  @Get('teachers/:id/students')
  studentsOfTeacher(@Param('id', ParseUUIDPipe) id: string) {
    return this.sis.studentsOfTeacher(id);
  }

  @Get('subjects/:id/students')
  studentsBySubject(@Param('id', ParseUUIDPipe) id: string) {
    return this.sis.studentsBySubject(id);
  }
}
