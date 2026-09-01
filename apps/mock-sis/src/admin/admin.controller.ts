import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { AdminService } from './admin.service';

type Dict = Record<string, unknown>;

/**
 * Admin CRUD for the Mock SIS data-entry UI. Deliberately NOT behind the vendor
 * API-key guard: this is a local testing/administration tool, separate from the
 * vendor read APIs the 360 system consumes. Routes are excluded from the global
 * `api/v1` prefix (see main.ts), so they live under `/admin/api/*`.
 */
@Controller('admin/api')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('lookups') lookups() { return this.admin.lookups(); }

  // Students
  @Get('students') students(@Query('search') s?: string) { return this.admin.students(s); }
  @Post('students') createStudent(@Body() b: Dict) { return this.admin.createStudent(b); }
  @Put('students/:id') updateStudent(@Param('id') id: string, @Body() b: Dict) { return this.admin.updateStudent(id, b); }
  @Delete('students/:id') deleteStudent(@Param('id') id: string) { return this.admin.deleteStudent(id); }

  // Parents / guardians
  @Get('parents') parents(@Query('studentId') sid?: string) { return this.admin.parents(sid); }
  @Post('parents') createParent(@Body() b: Dict) { return this.admin.createParent(b); }
  @Put('parents/:id') updateParent(@Param('id') id: string, @Body() b: Dict) { return this.admin.updateParent(id, b); }
  @Delete('parents/:id') deleteParent(@Param('id') id: string) { return this.admin.deleteParent(id); }

  // Teachers
  @Get('teachers') teachers(@Query('search') s?: string) { return this.admin.teachers(s); }
  @Post('teachers') createTeacher(@Body() b: Dict) { return this.admin.createTeacher(b); }
  @Put('teachers/:id') updateTeacher(@Param('id') id: string, @Body() b: Dict) { return this.admin.updateTeacher(id, b); }
  @Delete('teachers/:id') deleteTeacher(@Param('id') id: string) { return this.admin.deleteTeacher(id); }

  // Subjects
  @Get('subjects') subjects(@Query('search') s?: string) { return this.admin.subjects(s); }
  @Post('subjects') createSubject(@Body() b: Dict) { return this.admin.createSubject(b); }
  @Put('subjects/:id') updateSubject(@Param('id') id: string, @Body() b: Dict) { return this.admin.updateSubject(id, b); }
  @Delete('subjects/:id') deleteSubject(@Param('id') id: string) { return this.admin.deleteSubject(id); }

  // Teaching assignments
  @Get('teaching-assignments') tas(@Query('teacherId') t?: string) { return this.admin.teachingAssignments(t); }
  @Post('teaching-assignments') createTa(@Body() b: Dict) { return this.admin.createTeachingAssignment(b); }
  @Put('teaching-assignments/:id') updateTa(@Param('id') id: string, @Body() b: Dict) { return this.admin.updateTeachingAssignment(id, b); }
  @Delete('teaching-assignments/:id') deleteTa(@Param('id') id: string) { return this.admin.deleteTeachingAssignment(id); }

  // Student enrollments
  @Get('enrollments') enrollments(@Query('studentId') sid?: string) { return this.admin.enrollments(sid); }
  @Post('enrollments') createEnrollment(@Body() b: Dict) { return this.admin.createEnrollment(b); }
  @Put('enrollments/:id') updateEnrollment(@Param('id') id: string, @Body() b: Dict) { return this.admin.updateEnrollment(id, b); }
  @Delete('enrollments/:id') deleteEnrollment(@Param('id') id: string) { return this.admin.deleteEnrollment(id); }
}
