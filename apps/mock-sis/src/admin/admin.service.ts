import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

type Dict = Record<string, unknown>;

/**
 * Write model for the Mock SIS admin tool. Uses the Prisma client directly (the
 * vendor read APIs stay raw-SQL). This powers the self-contained /admin data-entry
 * UI; it is intentionally simple and unauthenticated (local testing tool).
 */
@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  /* ------------------------------------------------------------------ */
  /* Lookups (for FK dropdowns).                                         */
  /* ------------------------------------------------------------------ */
  async lookups(): Promise<Dict> {
    const [campuses, faculties, departments, programs, sessions, semesters, classes, sections, subjects, teachers] =
      await Promise.all([
        this.prisma.campus.findMany({ orderBy: { name: 'asc' }, select: { id: true, code: true, name: true } }),
        this.prisma.faculty.findMany({ orderBy: { name: 'asc' }, select: { id: true, code: true, name: true, campusId: true } }),
        this.prisma.department.findMany({ orderBy: { name: 'asc' }, select: { id: true, code: true, name: true, facultyId: true } }),
        this.prisma.program.findMany({ orderBy: { name: 'asc' }, select: { id: true, code: true, name: true, departmentId: true } }),
        this.prisma.academicSession.findMany({ orderBy: { code: 'asc' }, select: { id: true, code: true, name: true } }),
        this.prisma.semester.findMany({ orderBy: { code: 'asc' }, select: { id: true, code: true, name: true, sessionId: true } }),
        this.prisma.gradeClass.findMany({ orderBy: { name: 'asc' }, select: { id: true, code: true, name: true, programId: true } }),
        this.prisma.section.findMany({ orderBy: { name: 'asc' }, select: { id: true, code: true, name: true, gradeClassId: true } }),
        this.prisma.subject.findMany({ orderBy: { code: 'asc' }, select: { id: true, code: true, name: true, departmentId: true, programId: true } }),
        this.prisma.teacher.findMany({ orderBy: { name: 'asc' }, select: { id: true, employeeCode: true, name: true, departmentId: true, facultyId: true } }),
      ]);
    return { campuses, faculties, departments, programs, sessions, semesters, classes, sections, subjects, teachers };
  }

  /* ------------------------------------------------------------------ */
  /* Students.                                                           */
  /* ------------------------------------------------------------------ */
  students(search?: string): Promise<Dict[]> {
    return this.prisma.student.findMany({
      where: search
        ? { OR: [{ name: { contains: search, mode: 'insensitive' } }, { registrationNo: { contains: search, mode: 'insensitive' } }, { rollNo: { contains: search, mode: 'insensitive' } }] }
        : undefined,
      orderBy: { name: 'asc' },
      take: 500,
    }) as unknown as Promise<Dict[]>;
  }

  async createStudent(b: Dict): Promise<Dict> {
    this.require(b, ['registrationNo', 'rollNo', 'name', 'gender', 'programId', 'campusId', 'facultyId', 'departmentId', 'currentClassId', 'currentSectionId', 'sessionId']);
    await this.assertUnique('student', 'registrationNo', b.registrationNo as string);
    return this.prisma.student.create({ data: this.studentData(b) }) as unknown as Promise<Dict>;
  }

  async updateStudent(id: string, b: Dict): Promise<Dict> {
    await this.mustExist('student', id);
    if (b.registrationNo) await this.assertUnique('student', 'registrationNo', b.registrationNo as string, id);
    return this.prisma.student.update({ where: { id }, data: this.studentData(b, true) }) as unknown as Promise<Dict>;
  }

  async deleteStudent(id: string): Promise<Dict> {
    await this.mustExist('student', id);
    // Cascade the child rows so the mock DB stays consistent.
    await this.prisma.studentEnrollment.deleteMany({ where: { studentId: id } });
    await this.prisma.parent.deleteMany({ where: { studentId: id } });
    await this.prisma.student.delete({ where: { id } });
    return { id, deleted: true };
  }

  private studentData(b: Dict, partial = false): any {
    const d: Dict = {
      registrationNo: b.registrationNo,
      rollNo: b.rollNo,
      name: b.name,
      gender: b.gender,
      dateOfBirth: this.date(b.dateOfBirth),
      programId: b.programId,
      campusId: b.campusId,
      facultyId: b.facultyId,
      departmentId: b.departmentId,
      currentClassId: b.currentClassId,
      currentSectionId: b.currentSectionId,
      sessionId: b.sessionId,
      semesterId: b.semesterId || null,
      admissionDate: this.date(b.admissionDate),
      status: b.status || 'active',
    };
    if (partial) for (const k of Object.keys(d)) if (b[k] === undefined) delete d[k];
    return d;
  }

  /* ------------------------------------------------------------------ */
  /* Parents / guardians (incl. WhatsApp).                               */
  /* ------------------------------------------------------------------ */
  parents(studentId?: string): Promise<Dict[]> {
    return this.prisma.parent.findMany({ where: studentId ? { studentId } : undefined, orderBy: { name: 'asc' }, take: 1000 }) as unknown as Promise<Dict[]>;
  }

  async createParent(b: Dict): Promise<Dict> {
    this.require(b, ['studentId', 'name', 'relationship']);
    await this.mustExist('student', b.studentId as string);
    return this.prisma.parent.create({ data: this.parentData(b) }) as unknown as Promise<Dict>;
  }

  async updateParent(id: string, b: Dict): Promise<Dict> {
    await this.mustExist('parent', id);
    return this.prisma.parent.update({ where: { id }, data: this.parentData(b, true) }) as unknown as Promise<Dict>;
  }

  async deleteParent(id: string): Promise<Dict> {
    await this.mustExist('parent', id);
    await this.prisma.parent.delete({ where: { id } });
    return { id, deleted: true };
  }

  private parentData(b: Dict, partial = false): any {
    const d: Dict = {
      studentId: b.studentId,
      name: b.name,
      relationship: b.relationship,
      mobile: b.mobile || null,
      whatsapp: b.whatsapp || null,
      email: b.email || null,
      preferredLanguage: b.preferredLanguage || 'en',
      active: b.active === undefined ? true : Boolean(b.active),
    };
    if (partial) for (const k of Object.keys(d)) if (b[k] === undefined) delete d[k];
    return d;
  }

  /* ------------------------------------------------------------------ */
  /* Teachers.                                                           */
  /* ------------------------------------------------------------------ */
  teachers(search?: string): Promise<Dict[]> {
    return this.prisma.teacher.findMany({
      where: search ? { OR: [{ name: { contains: search, mode: 'insensitive' } }, { employeeCode: { contains: search, mode: 'insensitive' } }] } : undefined,
      orderBy: { name: 'asc' },
      take: 500,
    }) as unknown as Promise<Dict[]>;
  }

  async createTeacher(b: Dict): Promise<Dict> {
    this.require(b, ['employeeCode', 'name', 'designation', 'departmentId', 'facultyId']);
    await this.assertUnique('teacher', 'employeeCode', b.employeeCode as string);
    return this.prisma.teacher.create({ data: this.teacherData(b) }) as unknown as Promise<Dict>;
  }

  async updateTeacher(id: string, b: Dict): Promise<Dict> {
    await this.mustExist('teacher', id);
    if (b.employeeCode) await this.assertUnique('teacher', 'employeeCode', b.employeeCode as string, id);
    return this.prisma.teacher.update({ where: { id }, data: this.teacherData(b, true) }) as unknown as Promise<Dict>;
  }

  async deleteTeacher(id: string): Promise<Dict> {
    await this.mustExist('teacher', id);
    const assignments = await this.prisma.teachingAssignment.count({ where: { teacherId: id } });
    if (assignments > 0) throw new ConflictException(`This teacher has ${assignments} teaching assignment(s). Remove them first.`);
    await this.prisma.teacher.delete({ where: { id } });
    return { id, deleted: true };
  }

  private teacherData(b: Dict, partial = false): any {
    const d: Dict = {
      employeeCode: b.employeeCode,
      name: b.name,
      designation: b.designation,
      departmentId: b.departmentId,
      facultyId: b.facultyId,
      mobile: b.mobile || null,
      email: b.email || null,
      status: b.status || 'active',
    };
    if (partial) for (const k of Object.keys(d)) if (b[k] === undefined) delete d[k];
    return d;
  }

  /* ------------------------------------------------------------------ */
  /* Subjects.                                                           */
  /* ------------------------------------------------------------------ */
  subjects(search?: string): Promise<Dict[]> {
    return this.prisma.subject.findMany({
      where: search ? { OR: [{ name: { contains: search, mode: 'insensitive' } }, { code: { contains: search, mode: 'insensitive' } }] } : undefined,
      orderBy: { code: 'asc' },
      take: 500,
    }) as unknown as Promise<Dict[]>;
  }

  async createSubject(b: Dict): Promise<Dict> {
    this.require(b, ['code', 'name', 'departmentId', 'programId']);
    await this.assertUnique('subject', 'code', b.code as string);
    return this.prisma.subject.create({ data: this.subjectData(b) }) as unknown as Promise<Dict>;
  }

  async updateSubject(id: string, b: Dict): Promise<Dict> {
    await this.mustExist('subject', id);
    if (b.code) await this.assertUnique('subject', 'code', b.code as string, id);
    return this.prisma.subject.update({ where: { id }, data: this.subjectData(b, true) }) as unknown as Promise<Dict>;
  }

  async deleteSubject(id: string): Promise<Dict> {
    await this.mustExist('subject', id);
    const assignments = await this.prisma.teachingAssignment.count({ where: { subjectId: id } });
    if (assignments > 0) throw new ConflictException(`This subject is used by ${assignments} teaching assignment(s). Remove them first.`);
    await this.prisma.subject.delete({ where: { id } });
    return { id, deleted: true };
  }

  private subjectData(b: Dict, partial = false): any {
    const d: Dict = {
      code: b.code,
      name: b.name,
      departmentId: b.departmentId,
      programId: b.programId,
      creditHours: b.creditHours === undefined ? 3 : Number(b.creditHours),
      status: b.status || 'active',
    };
    if (partial) for (const k of Object.keys(d)) if (b[k] === undefined) delete d[k];
    return d;
  }

  /* ------------------------------------------------------------------ */
  /* Teaching assignments.                                               */
  /* ------------------------------------------------------------------ */
  async teachingAssignments(teacherId?: string): Promise<Dict[]> {
    const rows = await this.prisma.teachingAssignment.findMany({ where: teacherId ? { teacherId } : undefined, orderBy: { startDate: 'desc' }, take: 1000 });
    // Enrich with names for the table (kept lightweight).
    const [teachers, subjects, sections, classes] = await Promise.all([
      this.prisma.teacher.findMany({ select: { id: true, name: true, employeeCode: true } }),
      this.prisma.subject.findMany({ select: { id: true, name: true, code: true } }),
      this.prisma.section.findMany({ select: { id: true, name: true } }),
      this.prisma.gradeClass.findMany({ select: { id: true, name: true } }),
    ]);
    const tById = new Map(teachers.map((t) => [t.id, t]));
    const sById = new Map(subjects.map((s) => [s.id, s]));
    const secById = new Map(sections.map((s) => [s.id, s.name]));
    const clById = new Map(classes.map((c) => [c.id, c.name]));
    return rows.map((r) => ({
      ...r,
      teacherName: tById.get(r.teacherId)?.name ?? null,
      employeeCode: tById.get(r.teacherId)?.employeeCode ?? null,
      subjectName: sById.get(r.subjectId)?.name ?? null,
      subjectCode: sById.get(r.subjectId)?.code ?? null,
      className: clById.get(r.gradeClassId) ?? null,
      sectionName: secById.get(r.sectionId) ?? null,
    })) as unknown as Dict[];
  }

  async createTeachingAssignment(b: Dict): Promise<Dict> {
    this.require(b, ['teacherId', 'subjectId', 'sessionId', 'campusId', 'programId', 'semesterId', 'gradeClassId', 'sectionId']);
    return this.prisma.teachingAssignment.create({ data: this.taData(b) }) as unknown as Promise<Dict>;
  }

  async updateTeachingAssignment(id: string, b: Dict): Promise<Dict> {
    await this.mustExist('teachingAssignment', id);
    return this.prisma.teachingAssignment.update({ where: { id }, data: this.taData(b, true) }) as unknown as Promise<Dict>;
  }

  async deleteTeachingAssignment(id: string): Promise<Dict> {
    await this.mustExist('teachingAssignment', id);
    await this.prisma.studentEnrollment.deleteMany({ where: { teachingAssignmentId: id } });
    await this.prisma.teachingAssignment.delete({ where: { id } });
    return { id, deleted: true };
  }

  private taData(b: Dict, partial = false): any {
    const d: Dict = {
      teacherId: b.teacherId,
      subjectId: b.subjectId,
      sessionId: b.sessionId,
      campusId: b.campusId,
      programId: b.programId,
      semesterId: b.semesterId,
      gradeClassId: b.gradeClassId,
      sectionId: b.sectionId,
      startDate: this.date(b.startDate),
      endDate: this.date(b.endDate),
      status: b.status || 'active',
    };
    if (partial) for (const k of Object.keys(d)) if (b[k] === undefined) delete d[k];
    return d;
  }

  /* ------------------------------------------------------------------ */
  /* Student enrollments.                                                */
  /* ------------------------------------------------------------------ */
  async enrollments(studentId?: string): Promise<Dict[]> {
    const rows = await this.prisma.studentEnrollment.findMany({ where: studentId ? { studentId } : undefined, orderBy: { enrollmentDate: 'desc' }, take: 1000 });
    const [students, tas, teachers, subjects] = await Promise.all([
      this.prisma.student.findMany({ select: { id: true, name: true, registrationNo: true } }),
      this.prisma.teachingAssignment.findMany({ select: { id: true, teacherId: true, subjectId: true } }),
      this.prisma.teacher.findMany({ select: { id: true, name: true } }),
      this.prisma.subject.findMany({ select: { id: true, name: true, code: true } }),
    ]);
    const stById = new Map(students.map((s) => [s.id, s]));
    const taById = new Map(tas.map((t) => [t.id, t]));
    const teById = new Map(teachers.map((t) => [t.id, t.name]));
    const subById = new Map(subjects.map((s) => [s.id, s]));
    return rows.map((r) => {
      const ta = taById.get(r.teachingAssignmentId);
      return {
        ...r,
        studentName: stById.get(r.studentId)?.name ?? null,
        registrationNo: stById.get(r.studentId)?.registrationNo ?? null,
        teacherName: ta ? teById.get(ta.teacherId) ?? null : null,
        subjectName: ta ? subById.get(ta.subjectId)?.name ?? null : null,
        subjectCode: ta ? subById.get(ta.subjectId)?.code ?? null : null,
      };
    }) as unknown as Dict[];
  }

  async createEnrollment(b: Dict): Promise<Dict> {
    this.require(b, ['studentId', 'teachingAssignmentId']);
    await this.mustExist('student', b.studentId as string);
    await this.mustExist('teachingAssignment', b.teachingAssignmentId as string);
    const dup = await this.prisma.studentEnrollment.findFirst({ where: { studentId: b.studentId as string, teachingAssignmentId: b.teachingAssignmentId as string } });
    if (dup) throw new ConflictException('This student is already enrolled in that teaching assignment.');
    return this.prisma.studentEnrollment.create({
      data: { studentId: b.studentId as string, teachingAssignmentId: b.teachingAssignmentId as string, enrollmentDate: this.date(b.enrollmentDate) ?? new Date(), status: (b.status as string) || 'active' },
    }) as unknown as Promise<Dict>;
  }

  async updateEnrollment(id: string, b: Dict): Promise<Dict> {
    await this.mustExist('studentEnrollment', id);
    const d: any = {};
    if (b.status !== undefined) d.status = b.status;
    if (b.enrollmentDate !== undefined) d.enrollmentDate = this.date(b.enrollmentDate);
    return this.prisma.studentEnrollment.update({ where: { id }, data: d }) as unknown as Promise<Dict>;
  }

  async deleteEnrollment(id: string): Promise<Dict> {
    await this.mustExist('studentEnrollment', id);
    await this.prisma.studentEnrollment.delete({ where: { id } });
    return { id, deleted: true };
  }

  /* ------------------------------------------------------------------ */
  /* Helpers.                                                            */
  /* ------------------------------------------------------------------ */
  private require(b: Dict, fields: string[]): void {
    const missing = fields.filter((f) => b[f] === undefined || b[f] === null || b[f] === '');
    if (missing.length) throw new BadRequestException(`Missing required field(s): ${missing.join(', ')}.`);
  }

  private date(v: unknown): Date | null {
    if (!v) return null;
    const d = new Date(v as string);
    return isNaN(d.getTime()) ? null : d;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async assertUnique(model: string, field: string, value: string, exceptId?: string): Promise<void> {
    const existing = await (this.prisma as any)[model].findFirst({ where: { [field]: value }, select: { id: true } });
    if (existing && existing.id !== exceptId) throw new ConflictException(`${field} "${value}" already exists.`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async mustExist(model: string, id: string): Promise<void> {
    const row = await (this.prisma as any)[model].findUnique({ where: { id }, select: { id: true } });
    if (!row) throw new NotFoundException(`${model} not found.`);
  }
}
