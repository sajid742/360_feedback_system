import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '../generated/client';

/**
 * Realistic, internally-consistent sample data for the Mock SIS.
 * Central design: students are enrolled into TeachingAssignments (Teacher×Subject×
 * Class/Section×Session), never mapped to teachers directly. From an enrollment
 * we can derive the teacher, subject, class, section, semester and session.
 */
const prisma = new PrismaClient();

const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
const shuffle = <T>(arr: T[]): T[] => [...arr].sort(() => Math.random() - 0.5);
const pad = (n: number, w = 4): string => String(n).padStart(w, '0');

const FIRST = ['Ayesha', 'Bilal', 'Hamza', 'Daniyal', 'Sana', 'Faisal', 'Amna', 'Hassan', 'Iqra', 'Junaid', 'Kiran', 'Laila', 'Mahad', 'Nadia', 'Omar', 'Sadia', 'Qasim', 'Rabia', 'Saad', 'Tania', 'Usman', 'Uzma', 'Wajahat', 'Yusra', 'Zain', 'Aliya', 'Bushra', 'Danish', 'Erum', 'Farhan'];
const LAST = ['Khan', 'Ahmed', 'Malik', 'Siddiqui', 'Raza', 'Sheikh', 'Butt', 'Chaudhry', 'Qureshi', 'Baig', 'Hashmi', 'Farooqi', 'Zafar', 'Nawaz', 'Iqbal'];
const name = (): string => `${pick(FIRST)} ${pick(LAST)}`;

/**
 * Canonical roster shared with the 360 app sample data (apps/api/scripts/sample-data.ts).
 * The first teachers below reuse these exact names + employee codes, so a 360 admin can
 * map SIS teachers to HR employees by employee code (E1000-E1007) with names that match.
 */
const ROSTER = [
  { code: 'E1000', name: 'Imran Farooqi' },
  { code: 'E1001', name: 'Bilal Ahmed' },
  { code: 'E1002', name: 'Ayesha Siddiqui' },
  { code: 'E1003', name: 'Usman Malik' },
  { code: 'E1004', name: 'Sana Javed' },
  { code: 'E1005', name: 'Hamza Sheikh' },
  { code: 'E1006', name: 'Fatima Raza' },
  { code: 'E1007', name: 'Zainab Qureshi' },
];

const SUBJECT_POOL = ['Calculus', 'Linear Algebra', 'Data Structures', 'Algorithms', 'Databases', 'Operating Systems', 'Computer Networks', 'Software Engineering', 'Discrete Mathematics', 'Physics I', 'Physics II', 'Organic Chemistry', 'Cell Biology', 'Genetics', 'English Composition', 'Technical Writing', 'World History', 'Microeconomics', 'Macroeconomics', 'Principles of Management', 'Financial Accounting', 'Marketing', 'Statistics', 'Probability', 'Machine Learning', 'Artificial Intelligence', 'Web Development', 'Mobile Computing', 'Digital Logic', 'Thermodynamics', 'Electromagnetism', 'Analytical Chemistry', 'Molecular Biology', 'Ecology', 'Literary Theory', 'Public Speaking', 'Political Science', 'Development Economics', 'Corporate Finance', 'Operations Research', 'Cyber Security', 'Cloud Computing'];
const DESIGNATIONS = ['Lecturer', 'Assistant Professor', 'Associate Professor', 'Professor', 'Senior Lecturer'];
const RELATIONSHIPS = ['Father', 'Mother', 'Guardian'];

async function main(): Promise<void> {
  // Idempotency guard.
  const existing = await prisma.campus.count();
  if (existing > 0) {
    console.log('Mock SIS already seeded — nothing to do.');
    return;
  }

  const mobile = (): string => `+92-3${Math.floor(10 + Math.random() * 89)}-${pad(Math.floor(Math.random() * 9999999), 7)}`;

  // ---- Campuses ----
  const campuses = ['CARE Taxila Campus', 'CARE Rawalpindi Campus', 'CARE Wah Cantt Campus'].map((n, i) => ({ id: randomUUID(), code: `C${i + 1}`, name: n, city: pick(['Lahore', 'Karachi', 'Islamabad']) }));
  await prisma.campus.createMany({ data: campuses });

  // ---- Faculties (2 per campus) ----
  const facNames = ['Faculty of Science', 'Faculty of Arts & Social Sciences'];
  const faculties: { id: string; campusId: string; code: string; name: string }[] = [];
  campuses.forEach((c, ci) => facNames.forEach((fn, fi) => faculties.push({ id: randomUUID(), campusId: c.id, code: `F${ci + 1}${fi + 1}`, name: fn })));
  await prisma.faculty.createMany({ data: faculties });

  // ---- Departments (2 per faculty) ----
  const deptNames = [['Computer Science', 'Mathematics'], ['English', 'Economics']];
  const departments: { id: string; facultyId: string; campusId: string; code: string; name: string }[] = [];
  faculties.forEach((f, fi) => (fi % 2 === 0 ? deptNames[0] : deptNames[1]).forEach((dn, di) => departments.push({ id: randomUUID(), facultyId: f.id, campusId: f.campusId, code: `D${fi}${di}`, name: dn })));
  await prisma.department.createMany({ data: departments.map(({ campusId, ...d }) => d) });

  // ---- Programs (1 per department + a few extra) ----
  const programs: { id: string; departmentId: string; facultyId: string; campusId: string; code: string; name: string; level: string }[] = [];
  departments.forEach((d, i) => {
    programs.push({ id: randomUUID(), departmentId: d.id, facultyId: d.facultyId, campusId: d.campusId, code: `P${pad(i, 2)}`, name: `BS ${d.name}`, level: 'undergraduate' });
    if (i % 3 === 0) programs.push({ id: randomUUID(), departmentId: d.id, facultyId: d.facultyId, campusId: d.campusId, code: `PM${pad(i, 2)}`, name: `MS ${d.name}`, level: 'graduate' });
  });
  await prisma.program.createMany({ data: programs.map(({ facultyId, campusId, ...p }) => p) });

  // ---- Sessions + semesters ----
  const sessions = [
    { id: randomUUID(), code: '2023-2024', name: 'Academic Year 2023-2024', startDate: new Date('2023-09-01'), endDate: new Date('2024-06-30'), status: 'archived' },
    { id: randomUUID(), code: '2024-2025', name: 'Academic Year 2024-2025', startDate: new Date('2024-09-01'), endDate: new Date('2025-06-30'), status: 'active' },
  ];
  await prisma.academicSession.createMany({ data: sessions });
  const semesters: { id: string; sessionId: string; code: string; name: string; term: string }[] = [];
  sessions.forEach((s) => ['Fall', 'Spring'].forEach((t) => semesters.push({ id: randomUUID(), sessionId: s.id, code: `${s.code}-${t}`, name: `${t} ${s.code}`, term: t })));
  await prisma.semester.createMany({ data: semesters });
  const activeSession = sessions[1];
  const activeSemester = semesters.find((s) => s.sessionId === activeSession.id)!;

  // ---- Classes (2 per program) + sections (2 per class) ----
  const classes: { id: string; programId: string; code: string; name: string }[] = [];
  programs.forEach((p, i) => ['Year 1', 'Year 2'].forEach((yn, yi) => classes.push({ id: randomUUID(), programId: p.id, code: `CL${pad(i, 2)}${yi + 1}`, name: yn })));
  await prisma.gradeClass.createMany({ data: classes });
  const sections: { id: string; gradeClassId: string; programId: string; code: string; name: string; capacity: number }[] = [];
  classes.forEach((c) => ['A', 'B'].forEach((sc) => sections.push({ id: randomUUID(), gradeClassId: c.id, programId: c.programId, code: sc, name: `Section ${sc}`, capacity: 40 })));
  await prisma.section.createMany({ data: sections.map(({ programId, ...s }) => s) });

  // ---- Subjects (~40, each tied to a program; guarantee ≥2 per program) ----
  const subjects: { id: string; code: string; name: string; departmentId: string; programId: string; creditHours: number }[] = [];
  const shuffledSubjectNames = shuffle(SUBJECT_POOL);
  let si = 0;
  // 2 guaranteed per program
  programs.forEach((p) => {
    for (let k = 0; k < 2 && si < shuffledSubjectNames.length; k++, si++) {
      subjects.push({ id: randomUUID(), code: `SUBJ-${pad(subjects.length + 1, 3)}`, name: shuffledSubjectNames[si], departmentId: p.departmentId, programId: p.id, creditHours: pick([2, 3, 3, 4]) });
    }
  });
  // remaining subjects spread randomly
  while (si < shuffledSubjectNames.length && subjects.length < 40) {
    const p = pick(programs);
    subjects.push({ id: randomUUID(), code: `SUBJ-${pad(subjects.length + 1, 3)}`, name: shuffledSubjectNames[si], departmentId: p.departmentId, programId: p.id, creditHours: pick([2, 3, 4]) });
    si++;
  }
  await prisma.subject.createMany({ data: subjects });
  const subjectsByProgram = new Map<string, typeof subjects>();
  subjects.forEach((s) => { const l = subjectsByProgram.get(s.programId) ?? []; l.push(s); subjectsByProgram.set(s.programId, l); });

  // ---- Teachers (30) ----
  // The first ROSTER.length teachers mirror the 360 HR employees exactly (name +
  // employee code E1000-E1007) so the Teacher -> Employee mapping matches by code;
  // the rest are additional Pakistani-named faculty with their own EMP-* codes.
  const teachers: { id: string; employeeCode: string; name: string; designation: string; departmentId: string; facultyId: string; mobile: string; email: string }[] = [];
  for (let i = 0; i < 30; i++) {
    const d = pick(departments);
    const roster = ROSTER[i];
    const nm = roster ? roster.name : name();
    const code = roster ? roster.code : `EMP-${pad(i + 1, 3)}`;
    teachers.push({ id: randomUUID(), employeeCode: code, name: nm, designation: pick(DESIGNATIONS), departmentId: d.id, facultyId: d.facultyId, mobile: mobile(), email: `${nm.toLowerCase().replace(/[^a-z]/g, '.')}@faculty.mocksis.edu` });
  }
  await prisma.teacher.createMany({ data: teachers });

  // ---- Students (100) ----
  const students: { id: string; registrationNo: string; rollNo: string; name: string; gender: string; dateOfBirth: Date; programId: string; campusId: string; facultyId: string; departmentId: string; currentClassId: string; currentSectionId: string; sessionId: string; semesterId: string; admissionDate: Date; status: string }[] = [];
  for (let i = 0; i < 100; i++) {
    const sec = pick(sections);
    const cls = classes.find((c) => c.id === sec.gradeClassId)!;
    const prog = programs.find((p) => p.id === cls.programId)!;
    students.push({
      id: randomUUID(),
      registrationNo: `REG-2024-${pad(i + 1)}`,
      rollNo: `${prog.code}-${pad(i + 1, 3)}`,
      name: name(),
      gender: pick(['Male', 'Female']),
      dateOfBirth: new Date(2004 + Math.floor(Math.random() * 4), Math.floor(Math.random() * 12), 1 + Math.floor(Math.random() * 27)),
      programId: prog.id,
      campusId: prog.campusId,
      facultyId: prog.facultyId,
      departmentId: prog.departmentId,
      currentClassId: cls.id,
      currentSectionId: sec.id,
      sessionId: activeSession.id,
      semesterId: activeSemester.id,
      admissionDate: new Date('2024-09-01'),
      status: 'active',
    });
  }
  await prisma.student.createMany({ data: students });

  // ---- Parents (150: every student ≥1, half get 2) ----
  const parents: { id: string; studentId: string; name: string; relationship: string; mobile: string; whatsapp: string; email: string; preferredLanguage: string }[] = [];
  students.forEach((st, idx) => {
    const count = idx < 50 ? 2 : 1; // 50*2 + 50*1 = 150
    for (let k = 0; k < count; k++) {
      const rel = k === 0 ? RELATIONSHIPS[idx % 2] : RELATIONSHIPS[(idx + 1) % 2];
      const m = mobile();
      parents.push({ id: randomUUID(), studentId: st.id, name: name(), relationship: rel, mobile: m, whatsapp: m, email: `parent.${idx}.${k}@gmail.com`, preferredLanguage: pick(['en', 'en', 'ur']) });
    }
  });
  await prisma.parent.createMany({ data: parents });

  // ---- Teaching assignments (up to 3 subjects per section, round-robin teacher) ----
  const teachingAssignments: { id: string; teacherId: string; subjectId: string; sessionId: string; campusId: string; programId: string; semesterId: string; gradeClassId: string; sectionId: string; startDate: Date; endDate: Date; status: string }[] = [];
  let tRr = 0;
  for (const sec of sections) {
    const prog = programs.find((p) => p.id === sec.programId)!;
    const progSubjects = shuffle(subjectsByProgram.get(prog.id) ?? []).slice(0, 3);
    for (const sub of progSubjects) {
      teachingAssignments.push({
        id: randomUUID(),
        teacherId: teachers[tRr++ % teachers.length].id,
        subjectId: sub.id,
        sessionId: activeSession.id,
        campusId: prog.campusId,
        programId: prog.id,
        semesterId: activeSemester.id,
        gradeClassId: sec.gradeClassId,
        sectionId: sec.id,
        startDate: new Date('2024-09-01'),
        endDate: new Date('2025-01-15'),
        status: 'active',
      });
    }
  }
  await prisma.teachingAssignment.createMany({ data: teachingAssignments });
  const taBySection = new Map<string, typeof teachingAssignments>();
  teachingAssignments.forEach((ta) => { const l = taBySection.get(ta.sectionId) ?? []; l.push(ta); taBySection.set(ta.sectionId, l); });

  // ---- Enrollments (each student into all teaching assignments of their section) ----
  const enrollments: { id: string; studentId: string; teachingAssignmentId: string; enrollmentDate: Date; status: string }[] = [];
  for (const st of students) {
    for (const ta of taBySection.get(st.currentSectionId) ?? []) {
      enrollments.push({ id: randomUUID(), studentId: st.id, teachingAssignmentId: ta.id, enrollmentDate: new Date('2024-09-05'), status: 'active' });
    }
  }
  await prisma.studentEnrollment.createMany({ data: enrollments });

  console.log('Mock SIS seeded:');
  console.log(`  ${campuses.length} campuses · ${faculties.length} faculties · ${departments.length} departments · ${programs.length} programs`);
  console.log(`  ${sessions.length} sessions · ${semesters.length} semesters · ${classes.length} classes · ${sections.length} sections`);
  console.log(`  ${subjects.length} subjects · ${teachers.length} teachers · ${students.length} students · ${parents.length} parents`);
  console.log(`  ${teachingAssignments.length} teaching assignments · ${enrollments.length} enrollments`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
