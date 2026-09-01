import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiKeyGuard } from './common/api-key.guard';
import { SisService } from './sis.service';

/** Academic structure master data (vendor SIS). */
@Controller()
@UseGuards(ApiKeyGuard)
export class AcademicController {
  constructor(private readonly sis: SisService) {}

  @Get('campuses') campuses() { return this.sis.campuses(); }
  @Get('faculties') faculties() { return this.sis.faculties(); }
  @Get('departments') departments() { return this.sis.departments(); }
  @Get('programs') programs() { return this.sis.programs(); }
  @Get('sessions') sessions() { return this.sis.sessions(); }
  @Get('semesters') semesters() { return this.sis.semesters(); }
  @Get('classes') classes() { return this.sis.classes(); }
  @Get('sections') sections() { return this.sis.sections(); }
}
