/**
 * Generates the SIS roster CSV for the performance dataset.
 *
 * Shape: one row per student x subject (the flat "Roster" format the importer
 * accepts), so a single file carries students, guardians, teachers, teaching
 * assignments and enrolments.
 *
 *   PERF_STUDENTS   default 8000
 *   PERF_SUBJECTS   default 4   -> 32,000 rows
 *   PERF_TEACHERS   default 400 -> matched to employee codes PERF0001..PERF0400
 *
 * All data is synthetic. Names are "Perf Student NNNN"; guardian numbers are in the
 * reserved +99 test range so they can never dial a real handset; e-mails are on .test.
 *
 * Usage: node perf/gen-roster.mjs > perf/data/roster.csv
 */
const STUDENTS = Number(process.env.PERF_STUDENTS ?? 8000);
const SUBJECTS = Number(process.env.PERF_SUBJECTS ?? 4);
const TEACHERS = Number(process.env.PERF_TEACHERS ?? 400);

const CAMPUSES = ['CARE Taxila Campus', 'CARE Rawalpindi Campus', 'CARE Islamabad Campus'];
const GRADES = ['Grade 6', 'Grade 7', 'Grade 8', 'Grade 9', 'Grade 10'];
const SECTIONS = ['A', 'B', 'C', 'D'];
const SUBJECT_LIST = [
  ['Mathematics', 'MTH'], ['Physics', 'PHY'], ['English', 'ENG'],
  ['Chemistry', 'CHM'], ['Biology', 'BIO'], ['Computer Science', 'CS'],
];
const SESSION = '2025-2026';

const out = [];
out.push([
  'Student ID', 'Student Name', 'Class', 'Section', 'Department', 'Campus', 'Session',
  'Gender', 'Status', 'Parent Name', 'Relationship', 'Parent Mobile', 'Parent WhatsApp', 'Parent Email',
  'Teacher Employee Code', 'Teacher Name', 'Subject', 'Subject Code',
].join(','));

for (let s = 1; s <= STUDENTS; s++) {
  const id = `PS${String(s).padStart(5, '0')}`;
  const name = `Perf Student ${String(s).padStart(5, '0')}`;
  const grade = GRADES[s % GRADES.length];
  const section = SECTIONS[s % SECTIONS.length];
  const campus = CAMPUSES[s % CAMPUSES.length];
  // Every 3rd student shares a guardian with the previous one — siblings, so the
  // importer's de-duplication and the "one parent, several children" path are both
  // exercised at scale rather than only in the happy case.
  const g = Math.ceil(s / 3);
  const guardian = `Perf Guardian ${String(g).padStart(5, '0')}`;
  // +99 is unassigned as a country code; these numbers cannot reach a real handset.
  const mobile = `+9900${String(1000000 + g).slice(-7)}`;
  const email = `perf.guardian${String(g).padStart(5, '0')}@perf.carepvtltd.test`;

  for (let k = 0; k < SUBJECTS; k++) {
    const [subject, code] = SUBJECT_LIST[(s + k) % SUBJECT_LIST.length];
    // Teacher chosen from the perf employee codes so autoMapTeachers links them to a
    // real 360 employee — without that link no parent feedback can be routed.
    const t = ((s + k) % TEACHERS) + 1;
    const teacherCode = `PERF${String(t).padStart(4, '0')}`;
    const teacherName = `Perf Employee ${String(t).padStart(4, '0')}`;
    out.push([
      id, name, grade, section, 'Science', campus, SESSION,
      s % 2 ? 'Male' : 'Female', 'active', guardian, 'Father', mobile, mobile, email,
      teacherCode, teacherName, subject, `${code}-${grade.split(' ')[1]}`,
    ].join(','));
  }
}

process.stdout.write(out.join('\n') + '\n');
process.stderr.write(`${out.length - 1} rows | ${STUDENTS} students | ${TEACHERS} teachers | ${SUBJECTS} subjects each\n`);
