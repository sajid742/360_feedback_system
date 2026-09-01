import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiKeyGuard } from './common/api-key.guard';
import { SisService } from './sis.service';

/** Students, parents, teachers and subjects (vendor SIS). */
@Controller()
@UseGuards(ApiKeyGuard)
export class DirectoryController {
  constructor(private readonly sis: SisService) {}

  @Get('students')
  students(
    @Query('campusId') campusId?: string,
    @Query('programId') programId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.sis.students(campusId, programId, limit ? Number(limit) : 50, offset ? Number(offset) : 0);
  }

  @Get('students/:id')
  student(@Param('id', ParseUUIDPipe) id: string) {
    return this.sis.studentDetails(id);
  }

  @Get('students/:id/parents')
  parents(@Param('id', ParseUUIDPipe) id: string) {
    return this.sis.parentsOfStudent(id);
  }

  @Get('students/:id/enrollments')
  enrollments(@Param('id', ParseUUIDPipe) id: string) {
    return this.sis.studentEnrollments(id);
  }

  @Get('students/:id/teachers')
  teachersOfStudent(@Param('id', ParseUUIDPipe) id: string) {
    return this.sis.teachersOfStudent(id);
  }

  @Get('teachers')
  teachers() {
    return this.sis.teachers();
  }

  @Get('teachers/:id')
  teacher(@Param('id', ParseUUIDPipe) id: string) {
    return this.sis.teacherDetails(id);
  }

  @Get('subjects')
  subjects() {
    return this.sis.subjects();
  }
}
