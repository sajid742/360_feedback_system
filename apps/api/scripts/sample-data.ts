import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

/**
 * Populates an organization with a realistic demo dataset so the app is
 * explorable out of the box. Idempotent: if the sample-data marker (the "CARE Head Office"
 * root department) already exists, it does nothing.
 *
 * The organization models an education group (CARE Pvt. Ltd.) with the exact
 * department hierarchy below and a realistic multi-tier reporting tree
 * (Chairman → Directors → Heads → Principals/Managers → Coordinators/Officers →
 * Teachers/Support). Employee codes/names E1000–E1007 are preserved so the Mock
 * SIS teacher mirror (apps/mock-sis) still matches by code.
 *
 * Run AFTER `db:seed` + `db:bootstrap-tenant`:  npm run db:sample
 * Optional: SAMPLE_ORG_SLUG (default "care"), SAMPLE_PASSWORD (default "Password123!").
 */
const prisma = new PrismaClient();
const SLUG = (process.env.SAMPLE_ORG_SLUG ?? 'care').toLowerCase();
const PASSWORD = process.env.SAMPLE_PASSWORD ?? 'Password123!';

/** Department hierarchy — exactly the provided IDs/parents. CARE Head Office is the root. */
const DEPARTMENTS: { name: string; parent: string | null; unitType?: string }[] = [
  { name: 'CARE Head Office', parent: null, unitType: 'division' },
  { name: 'CARE University', parent: 'CARE Head Office', unitType: 'division' },
  { name: 'CARE Institute of Health Sciences', parent: 'CARE Head Office', unitType: 'division' },
  { name: 'CARE Dental College', parent: 'CARE Head Office', unitType: 'division' },
  { name: 'Security', parent: 'CARE Head Office', unitType: 'department' },
  { name: 'Schools & Colleges', parent: 'CARE Head Office', unitType: 'division' },
  { name: 'Academics & Staff Development', parent: 'Schools & Colleges', unitType: 'division' },
  { name: 'Administration & HR', parent: 'Schools & Colleges', unitType: 'division' },
  // Acad & HRD → schools/units
  { name: 'Admissions', parent: 'Academics & Staff Development' },
  { name: 'Pre-School', parent: 'Academics & Staff Development' },
  { name: 'Junior School', parent: 'Academics & Staff Development' },
  { name: 'CARE School for Girls', parent: 'Academics & Staff Development' },
  { name: 'Margalla Branch', parent: 'Academics & Staff Development' },
  { name: 'CARE School for Boys', parent: 'Academics & Staff Development' },
  { name: 'Day Care Centre', parent: 'Academics & Staff Development' },
  { name: 'Examinations Cell', parent: 'Academics & Staff Development' },
  // Adm & HRM → administrative units
  { name: 'Maintenance & Horticulture', parent: 'Administration & HR' },
  { name: 'Procurement', parent: 'Administration & HR' },
  { name: 'Transport', parent: 'Administration & HR' },
  { name: 'Administration', parent: 'Administration & HR' },
  { name: 'HR', parent: 'Administration & HR' },
  { name: 'IT', parent: 'Administration & HR' },
  { name: 'Accounts', parent: 'Administration & HR' },
];

/** Realistic designation catalogue (name → level, optional promotion target). */
const DESIGNATIONS: { name: string; level: number; promotesTo?: string }[] = [
  { name: 'Chairman', level: 10 },
  { name: 'Vice Chancellor', level: 9 },
  { name: 'Director', level: 9 },
  { name: 'Registrar', level: 8 },
  { name: 'Dean', level: 8 },
  { name: 'Director Academics', level: 8, promotesTo: 'Director' },
  { name: 'Director Administration', level: 8, promotesTo: 'Director' },
  { name: 'Principal', level: 8, promotesTo: 'Director Academics' },
  { name: 'Chief Security Officer', level: 8 },
  { name: 'Head of Department', level: 7 },
  { name: 'HOD', level: 7 },
  { name: 'Vice Principal', level: 7, promotesTo: 'Principal' },
  { name: 'Daycare Incharge', level: 6 },
  { name: 'Assistant Professor', level: 6 },
  { name: 'Admissions Manager', level: 6 },
  { name: 'Institute Manager', level: 6 },
  { name: 'IT Manager', level: 6, promotesTo: 'Director Administration' },
  { name: 'HR Manager', level: 6, promotesTo: 'Director Administration' },
  { name: 'Accounts Manager', level: 6, promotesTo: 'Director Administration' },
  { name: 'Admin Manager', level: 6, promotesTo: 'Director Administration' },
  { name: 'Procurement Manager', level: 6, promotesTo: 'Director Administration' },
  { name: 'Transport Manager', level: 6, promotesTo: 'Director Administration' },
  { name: 'Maintenance Manager', level: 6, promotesTo: 'Director Administration' },
  { name: 'Academic Coordinator', level: 5, promotesTo: 'Director Academics' },
  { name: 'Coordinator', level: 5, promotesTo: 'Vice Principal' },
  { name: 'Senior Teacher', level: 4, promotesTo: 'Coordinator' },
  { name: 'Teacher', level: 3, promotesTo: 'Senior Teacher' },
  { name: 'Dental Faculty', level: 4, promotesTo: 'HOD' },
  { name: 'Security Supervisor', level: 4, promotesTo: 'Chief Security Officer' },
  { name: 'Admissions Officer', level: 3, promotesTo: 'Admissions Manager' },
  { name: 'Institute Officer', level: 3, promotesTo: 'Institute Manager' },
  { name: 'IT Support Officer', level: 3, promotesTo: 'IT Manager' },
  { name: 'HR Officer', level: 3, promotesTo: 'HR Manager' },
  { name: 'Accountant', level: 3, promotesTo: 'Accounts Manager' },
  { name: 'Admin Officer', level: 3, promotesTo: 'Admin Manager' },
  { name: 'Procurement Officer', level: 3, promotesTo: 'Procurement Manager' },
  { name: 'Transport Supervisor', level: 3, promotesTo: 'Transport Manager' },
  { name: 'Horticulture Supervisor', level: 3, promotesTo: 'Maintenance Manager' },
  { name: 'Security Guard', level: 2, promotesTo: 'Security Supervisor' },
];

/** Employees: [code, name, designation, department, managerCode|null]. E1000 is the
 *  single top-of-organization (Chairman). Every other employee reports to a valid,
 *  higher-level manager — a strict tree (no self-reports, no cycles). */
const ROSTER: [string, string, string, string, string | null][] = [
  // Trust leadership
  ['E1000', 'Imran Farooqi', 'Chairman', 'CARE Head Office', null],
  ['E1001', 'Bilal Ahmed', 'Director', 'Schools & Colleges', 'E1000'],
  ['E1008', 'Tariq Mahmood', 'Vice Chancellor', 'CARE University', 'E1000'],
  ['E1009', 'Nadia Hussain', 'Director', 'CARE Institute of Health Sciences', 'E1000'],
  ['E1010', 'Kamran Yousaf', 'Principal', 'CARE Dental College', 'E1000'],
  ['E1011', 'Asif Raza', 'Chief Security Officer', 'Security', 'E1000'],
  // Schools & Colleges → two heads
  ['E1002', 'Ayesha Siddiqui', 'Director Academics', 'Academics & Staff Development', 'E1001'],
  ['E1003', 'Usman Malik', 'Director Administration', 'Administration & HR', 'E1001'],
  // Academics: principals & unit heads under the Director Academics
  ['E1004', 'Sana Javed', 'Principal', 'CARE School for Girls', 'E1002'],
  ['E1007', 'Zainab Qureshi', 'Principal', 'Junior School', 'E1002'],
  ['E1012', 'Hina Akhtar', 'Principal', 'Pre-School', 'E1002'],
  ['E1013', 'Bilal Nawaz', 'Principal', 'CARE School for Boys', 'E1002'],
  ['E1014', 'Rabia Saleem', 'Principal', 'Margalla Branch', 'E1002'],
  ['E1015', 'Saima Riaz', 'Daycare Incharge', 'Day Care Centre', 'E1002'],
  ['E1016', 'Faisal Iqbal', 'Head of Department', 'Examinations Cell', 'E1002'],
  ['E1017', 'Maria Khan', 'Admissions Manager', 'Admissions', 'E1002'],
  ['E1018', 'Adeel Anwar', 'Academic Coordinator', 'Academics & Staff Development', 'E1002'],
  // CARE School for Girls staff
  ['E1019', 'Sadia Yasin', 'Coordinator', 'CARE School for Girls', 'E1004'],
  ['E1020', 'Nimra Aslam', 'Senior Teacher', 'CARE School for Girls', 'E1019'],
  ['E1021', 'Aqsa Bibi', 'Teacher', 'CARE School for Girls', 'E1019'],
  // Junior School staff
  ['E1022', 'Farhan Ali', 'Coordinator', 'Junior School', 'E1007'],
  ['E1023', 'Iqra Naveed', 'Teacher', 'Junior School', 'E1022'],
  ['E1024', 'Hassan Tariq', 'Teacher', 'Junior School', 'E1022'],
  // CARE School for Boys & Pre-School staff
  ['E1025', 'Waqas Ahmed', 'Coordinator', 'CARE School for Boys', 'E1013'],
  ['E1026', 'Zohaib Hassan', 'Teacher', 'CARE School for Boys', 'E1025'],
  ['E1027', 'Amina Shah', 'Teacher', 'Pre-School', 'E1012'],
  ['E1028', 'Bushra Malik', 'Admissions Officer', 'Admissions', 'E1017'],
  // Administration & HRM: department managers under the Director Administration
  ['E1005', 'Hamza Sheikh', 'IT Manager', 'IT', 'E1003'],
  ['E1006', 'Fatima Raza', 'HR Manager', 'HR', 'E1003'],
  ['E1029', 'Junaid Akram', 'Accounts Manager', 'Accounts', 'E1003'],
  ['E1030', 'Sobia Kanwal', 'Admin Manager', 'Administration', 'E1003'],
  ['E1031', 'Rizwan Haider', 'Procurement Manager', 'Procurement', 'E1003'],
  ['E1032', 'Naveed Iqbal', 'Transport Manager', 'Transport', 'E1003'],
  ['E1033', 'Shahid Mehmood', 'Maintenance Manager', 'Maintenance & Horticulture', 'E1003'],
  // Officers under the administrative managers
  ['E1034', 'Ali Raza', 'IT Support Officer', 'IT', 'E1005'],
  ['E1035', 'Sadaf Noor', 'HR Officer', 'HR', 'E1006'],
  ['E1036', 'Umar Draz', 'Accountant', 'Accounts', 'E1029'],
  ['E1037', 'Kiran Shahzad', 'Admin Officer', 'Administration', 'E1030'],
  ['E1038', 'Tahir Mehmood', 'Procurement Officer', 'Procurement', 'E1031'],
  ['E1039', 'Imtiaz Ali', 'Transport Supervisor', 'Transport', 'E1032'],
  ['E1040', 'Gulzar Ahmed', 'Horticulture Supervisor', 'Maintenance & Horticulture', 'E1033'],
  // CARE University
  ['E1041', 'Shazia Kausar', 'Registrar', 'CARE University', 'E1008'],
  ['E1042', 'Yasir Hameed', 'Dean', 'CARE University', 'E1008'],
  ['E1043', 'Nabeel Ahmed', 'Assistant Professor', 'CARE University', 'E1042'],
  // IMS
  ['E1044', 'Sameer Baig', 'Institute Manager', 'CARE Institute of Health Sciences', 'E1009'],
  ['E1045', 'Hira Batool', 'Institute Officer', 'CARE Institute of Health Sciences', 'E1044'],
  // Dental College
  ['E1046', 'Ahsan Raza', 'HOD', 'CARE Dental College', 'E1010'],
  ['E1047', 'Mahnoor Fatima', 'Dental Faculty', 'CARE Dental College', 'E1046'],
  // Security
  ['E1048', 'Jamil Khan', 'Security Supervisor', 'Security', 'E1011'],
  ['E1049', 'Riaz Masih', 'Security Guard', 'Security', 'E1048'],
];

function emailOf(name: string): string {
  return name.toLowerCase().replace(/^dr\.?\s+/, '').trim().split(/\s+/).join('.') + '@carepvtltd.com';
}

async function main(): Promise<void> {
  const org = await prisma.organization.findUnique({ where: { slug: SLUG } });
  if (!org) throw new Error(`Organization '${SLUG}' not found. Run 'npm run db:bootstrap-tenant' first.`);
  const organizationId = org.id;

  const marker = await prisma.department.findFirst({ where: { organizationId, name: 'CARE Head Office' } });
  if (marker) { console.log(`Sample data already present for '${SLUG}' — nothing to do.`); return; }

  const hash = await bcrypt.hash(PASSWORD, 10);

  // ---- Rating scale ----
  const scale = await prisma.ratingScale.create({
    data: {
      organizationId, name: 'Standard 5-Point', scaleType: '5_point', minValue: 1, maxValue: 5,
      levels: { create: [
        { value: 1, label: 'Poor', sortOrder: 1, color: '#ef4444' },
        { value: 2, label: 'Below Average', sortOrder: 2, color: '#f59e0b' },
        { value: 3, label: 'Meets Expectations', sortOrder: 3, color: '#eab308' },
        { value: 4, label: 'Exceeds', sortOrder: 4, color: '#84cc16' },
        { value: 5, label: 'Outstanding', sortOrder: 5, color: '#10b981' },
      ] },
    },
  });

  // ---- Departments (create parents before children) ----
  const deptId = new Map<string, string>();
  for (const d of DEPARTMENTS) {
    const row = await prisma.department.create({ data: { organizationId, name: d.name, unitType: d.unitType ?? 'department', parentId: d.parent ? deptId.get(d.parent)! : null } });
    deptId.set(d.name, row.id);
  }

  // ---- Designations (then link promotion paths) ----
  const desigId = new Map<string, string>();
  for (const d of DESIGNATIONS) {
    const row = await prisma.designation.create({ data: { organizationId, name: d.name, level: d.level } });
    desigId.set(d.name, row.id);
  }
  for (const d of DESIGNATIONS) {
    if (d.promotesTo) await prisma.designation.update({ where: { id: desigId.get(d.name)! }, data: { promotionToId: desigId.get(d.promotesTo)! } });
  }

  // ---- Employees (create all, then wire Reporting To) ----
  const empId = new Map<string, string>();
  const userId = new Map<string, string>();
  for (const [code, name, desig, dept] of ROSTER) {
    const user = await prisma.user.create({ data: { organizationId, email: emailOf(name), fullName: name, passwordHash: hash } });
    const e = await prisma.employee.create({ data: { organizationId, userId: user.id, employeeCode: code, departmentId: deptId.get(dept)!, designationId: desigId.get(desig)!, status: 'active', joinDate: new Date('2023-01-15') } });
    empId.set(code, e.id); userId.set(code, user.id);
  }
  for (const [code, , , , mgr] of ROSTER) {
    if (mgr) await prisma.employee.update({ where: { id: empId.get(code)! }, data: { lineManagerId: empId.get(mgr)! } });
  }
  const E = (c: string): string => empId.get(c)!;

  // Matrix (dotted-line) managers — a couple realistic cross-links for testing.
  await prisma.employeeMatrixManager.create({ data: { employeeId: E('E1018'), managerId: E('E1004') } }); // Academic Coordinator ↔ a Principal
  await prisma.employeeMatrixManager.create({ data: { employeeId: E('E1034'), managerId: E('E1003') } }); // IT Officer dotted to the Director Administration

  // ---- Competencies ----
  async function competency(categoryName: string, name: string, description: string, indicators: { type: 'positive' | 'negative'; text: string }[]) {
    let category = await prisma.competencyCategory.findFirst({ where: { organizationId, name: categoryName } });
    if (!category) category = await prisma.competencyCategory.create({ data: { organizationId, name: categoryName } });
    const comp = await prisma.competency.create({ data: { organizationId, categoryId: category.id, name, description } });
    const version = await prisma.competencyVersion.create({
      data: { organizationId, competencyId: comp.id, versionLabel: 'v1', status: 'active',
        proficiencyLevels: { create: [
          { organizationId, level: 1, name: 'Basic' }, { organizationId, level: 2, name: 'Developing' },
          { organizationId, level: 3, name: 'Proficient' }, { organizationId, level: 4, name: 'Advanced' },
          { organizationId, level: 5, name: 'Expert' },
        ] } },
    });
    let order = 0;
    for (const ind of indicators) await prisma.behaviourIndicator.create({ data: { organizationId, versionId: version.id, type: ind.type, text: ind.text, sortOrder: order++ } });
    return comp;
  }
  const leadership = await competency('Leadership', 'Strategic Leadership', 'Sets vision and direction for the unit.', [
    { type: 'positive', text: 'Communicates a clear, compelling vision' },
    { type: 'positive', text: 'Empowers and develops team members' },
    { type: 'negative', text: 'Micromanages day-to-day work' },
  ]);
  const communication = await competency('Communication', 'Effective Communication', 'Communicates clearly with students, parents and staff.', [
    { type: 'positive', text: 'Listens actively and seeks to understand' },
    { type: 'negative', text: 'Interrupts or dismisses others' },
  ]);
  const teaching = await competency('Teaching', 'Teaching & Delivery Excellence', 'Plans and delivers high-quality lessons/service.', [
    { type: 'positive', text: 'Prepares engaging, well-structured lessons' },
    { type: 'positive', text: 'Mentors and supports colleagues' },
  ]);

  await prisma.competencyDesignationMapping.createMany({
    data: [
      { organizationId, competencyId: leadership.id, designationId: desigId.get('Principal')!, weight: 40, isMandatory: true },
      { organizationId, competencyId: communication.id, designationId: desigId.get('Coordinator')!, weight: 30 },
      { organizationId, competencyId: teaching.id, designationId: desigId.get('Teacher')!, weight: 60, isMandatory: true },
    ],
  });

  // ---- Questionnaire (bank + template) ----
  const q1 = await prisma.question.create({ data: { organizationId, text: 'Demonstrates strong leadership and ownership', type: 'rating', category: 'Leadership', ratingScaleId: scale.id, competencyId: leadership.id } });
  const q2 = await prisma.question.create({ data: { organizationId, text: 'Communicates clearly with the team, students and parents', type: 'rating', category: 'Communication', ratingScaleId: scale.id, competencyId: communication.id } });
  const q3 = await prisma.question.create({ data: { organizationId, text: 'Delivers high-quality teaching / service', type: 'rating', category: 'Teaching', ratingScaleId: scale.id, competencyId: teaching.id } });
  const q4 = await prisma.question.create({ data: { organizationId, text: 'What are this person’s key strengths?', type: 'text', category: 'Open' } });

  const template = await prisma.questionnaireTemplate.create({ data: { organizationId, name: 'Standard 360 Review', description: 'Default review form', status: 'published' } });
  const secCore = await prisma.templateSection.create({ data: { templateId: template.id, title: 'Core Competencies', sortOrder: 0 } });
  const secOpen = await prisma.templateSection.create({ data: { templateId: template.id, title: 'Open Feedback', sortOrder: 1 } });
  await prisma.sectionQuestion.createMany({ data: [
    { sectionId: secCore.id, questionId: q1.id, sortOrder: 0 },
    { sectionId: secCore.id, questionId: q2.id, sortOrder: 1 },
    { sectionId: secCore.id, questionId: q3.id, sortOrder: 2 },
    { sectionId: secOpen.id, questionId: q4.id, sortOrder: 0 },
  ] });

  // ---- Workflow definition (appraisal approval) ----
  const superRole = await prisma.role.findFirst({ where: { organizationId, name: 'Super Admin' } });
  await prisma.workflowDefinition.create({
    data: { organizationId, name: 'Appraisal Approval', entityType: 'appraisal', mode: 'sequential',
      steps: { create: [
        { name: 'Manager Review', stepOrder: 1, assigneeType: 'user', assigneeValue: userId.get('E1002')! },
        ...(superRole ? [{ name: 'HR Sign-off', stepOrder: 2, assigneeType: 'role', assigneeValue: superRole.id }] : []),
      ] } },
  });

  // ---- Appraisal cycle (with scored feedback so dashboards have data) ----
  const cycle = await prisma.appraisalCycle.create({ data: { organizationId, name: 'Annual Review 2026', startDate: new Date('2026-01-01'), endDate: new Date('2026-12-31'), status: 'active', templateId: template.id, ratingScaleId: scale.id } });
  const sSelf = await prisma.feedbackSource.create({ data: { cycleId: cycle.id, code: 'self', label: 'Self', weight: 20, requiredCount: 1 } });
  const sPeer = await prisma.feedbackSource.create({ data: { cycleId: cycle.id, code: 'peer', label: 'Peer', weight: 30, requiredCount: 2 } });
  const sMgr = await prisma.feedbackSource.create({ data: { cycleId: cycle.id, code: 'manager', label: 'Line Manager', weight: 50, requiredCount: 1 } });

  // Appraise a teacher (Nimra, CARE School for Girls): self + peer (Aqsa) + line manager (Sadia, Coordinator).
  const pNimra = await prisma.appraisalParticipant.create({ data: { cycleId: cycle.id, employeeId: E('E1020') } });
  const pIqra = await prisma.appraisalParticipant.create({ data: { cycleId: cycle.id, employeeId: E('E1023') } });
  const pSadaf = await prisma.appraisalParticipant.create({ data: { cycleId: cycle.id, employeeId: E('E1035') } });

  const aSelf = await prisma.reviewerAssignment.create({ data: { organizationId, cycleId: cycle.id, participantId: pNimra.id, sourceId: sSelf.id, reviewerEmployeeId: E('E1020') } });
  const aPeer = await prisma.reviewerAssignment.create({ data: { organizationId, cycleId: cycle.id, participantId: pNimra.id, sourceId: sPeer.id, reviewerEmployeeId: E('E1021') } });
  const aMgr = await prisma.reviewerAssignment.create({ data: { organizationId, cycleId: cycle.id, participantId: pNimra.id, sourceId: sMgr.id, reviewerEmployeeId: E('E1019') } });
  // Pending manager reviews (for coordinators/managers to see in "My Reviews").
  await prisma.reviewerAssignment.create({ data: { organizationId, cycleId: cycle.id, participantId: pIqra.id, sourceId: sMgr.id, reviewerEmployeeId: E('E1022') } });
  await prisma.reviewerAssignment.create({ data: { organizationId, cycleId: cycle.id, participantId: pSadaf.id, sourceId: sMgr.id, reviewerEmployeeId: E('E1006') } });

  async function submit(assignmentId: string, ratings: [string, number, string?][]) {
    await prisma.feedbackResponse.createMany({ data: ratings.map(([questionId, ratingValue, textValue]) => ({ assignmentId, questionId, ratingValue, textValue: textValue ?? null })) });
    await prisma.reviewerAssignment.update({ where: { id: assignmentId }, data: { status: 'submitted', submittedAt: new Date() } });
  }
  await submit(aSelf.id, [[q1.id, 4], [q2.id, 4], [q3.id, 5]]);
  await submit(aPeer.id, [
    [q1.id, 3, 'A reliable colleague, always willing to help; could take the lead more during events.'],
    [q2.id, 4, 'Communicates clearly and keeps parents well informed.'],
    [q3.id, 4, 'Excellent classroom delivery and consistently strong lesson plans.'],
  ]);
  await submit(aMgr.id, [
    [q1.id, 4, 'Strong ownership of her class this session.'],
    [q2.id, 5, 'Outstanding communicator with students and parents — a real strength.'],
    [q3.id, 4, 'High-quality teaching; a few deadlines for reports slipped.'],
  ]);

  const selfAvg = (4 + 4 + 5) / 3, peerAvg = (3 + 4 + 4) / 3, mgrAvg = (4 + 5 + 4) / 3;
  const finalScore = Math.round(((selfAvg * 20 + peerAvg * 30 + mgrAvg * 50) / 100) * 100) / 100;
  await prisma.appraisalParticipant.update({ where: { id: pNimra.id }, data: { finalScore, potentialRating: 4, status: 'in_progress' } });

  // ---- Feature flags ----
  await prisma.featureFlag.createMany({ data: [
    { organizationId, key: 'appraisal.calibration', isEnabled: true, description: 'Enable calibration UI' },
    { organizationId, key: 'ai.insights', isEnabled: false, description: 'AI insights (beta)' },
  ] });

  console.log('Sample data created successfully.');
  console.log('---------------------------------------------------------------');
  console.log(`Org: ${org.name} (slug=${SLUG}) · ${ROSTER.length} employees, ${DEPARTMENTS.length} departments (CARE Head Office root),`);
  console.log(`${DESIGNATIONS.length} designations, 3 competencies, 1 questionnaire template, 1 active cycle (scored).`);
  console.log(`\nAll sample users share the password: ${PASSWORD}`);
  console.log('  imran.farooqi@carepvtltd.com    Chairman (top of org chart, no manager)');
  console.log('  bilal.ahmed@carepvtltd.com      Director, Schools & Colleges');
  console.log('  ayesha.siddiqui@carepvtltd.com  Director Academics (Academics & Staff Development)');
  console.log('  usman.malik@carepvtltd.com      Director Administration (Administration & HR)');
  console.log('  sana.javed@carepvtltd.com       Principal, CARE School for Girls · zainab.qureshi Principal, Junior School');
  console.log('  hamza.sheikh@carepvtltd.com     IT Manager · fatima.raza HR Manager');
  console.log(`\nAdmin remains: sajidq@carepvtltd.com / (your bootstrap password), org slug '${SLUG}'.`);
}

main()
  .catch((error) => { console.error('Sample data failed:', error); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
