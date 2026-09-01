import { BadRequestException, Injectable } from '@nestjs/common';
import { fetchJson } from '../../hr-integration/providers/provider-util';
import type { SisParent, SisStudent, SisSubject, SisTeacher, SisTeachingAssignment } from '../../sis/sis.types';
import type { SisSnapshot, SisSnapshotEnrollment } from '../sis-snapshot.types';
import type { SisSnapshotProvider } from './sis-snapshot-provider';
import { emptySnapshot } from '../sis-snapshot.types';

interface OrUser { sourcedId: string; status?: string; username?: string; givenName?: string; familyName?: string; role?: string; roles?: { role: string }[]; email?: string; sms?: string; phone?: string; grades?: string[]; orgs?: { sourcedId: string }[]; agents?: { sourcedId: string }[]; metadata?: Record<string, unknown> }
interface OrClass { sourcedId: string; title?: string; classCode?: string; grades?: string[]; subjects?: string[]; course?: { sourcedId: string }; school?: { sourcedId: string }; terms?: { sourcedId: string }[] }
interface OrEnrollment { sourcedId: string; user?: { sourcedId: string }; class?: { sourcedId: string }; role?: string; status?: string }
interface OrCourse { sourcedId: string; title?: string; courseCode?: string; subjects?: string[] }
interface OrOrg { sourcedId: string; name?: string; type?: string }

/**
 * OneRoster v1.1 (REST) provider — the open-standard connector covering PowerSchool,
 * Infinite Campus, Skyward and Clever/ClassLink-style feeds. OAuth2 client-credentials,
 * then reads users/classes/enrollments/courses/orgs and maps them into the shared
 * SisSnapshot. Adding Clever/ClassLink later is the same shape behind this interface.
 */
@Injectable()
export class OneRosterSisProvider implements SisSnapshotProvider {
  readonly name = 'OneRoster v1.1';

  async getSnapshot(_organizationId: string, options?: Record<string, unknown>): Promise<SisSnapshot> {
    const c = (options?.connection ?? {}) as Record<string, string>;
    const base = String(c.baseUrl ?? '').trim().replace(/\/$/, '');
    const tokenUrl = String(c.tokenUrl ?? '').trim();
    const clientId = String(c.clientId ?? '').trim();
    const clientSecret = String(c.clientSecret ?? '').trim();
    if (!base || !tokenUrl || !clientId || !clientSecret) throw new BadRequestException('OneRoster is not configured — set base URL, token URL and OAuth2 client id/secret.');

    // 1) OAuth2 client-credentials token.
    const tok = (await fetchJson(tokenUrl, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials&scope=https://purl.imsglobal.org/spec/or/v1p1/scope/roster-core.readonly',
    })) as { access_token?: string; error?: string };
    if (!tok.access_token) throw new BadRequestException(`OneRoster token request failed${tok.error ? `: ${tok.error}` : ''}.`);
    const headers = { Authorization: `Bearer ${tok.access_token}` };
    const get = async (path: string, key: string): Promise<Record<string, unknown>[]> => {
      const j = (await fetchJson(`${base}/${path}?limit=10000&offset=0`, { headers })) as Record<string, unknown>;
      const v = j[key] ?? Object.values(j).find((x) => Array.isArray(x));
      return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
    };

    const [users, classes, enrollments, courses, orgs] = await Promise.all([
      get('users', 'users') as unknown as Promise<OrUser[]>,
      get('classes', 'classes') as unknown as Promise<OrClass[]>,
      get('enrollments', 'enrollments') as unknown as Promise<OrEnrollment[]>,
      get('courses', 'courses') as unknown as Promise<OrCourse[]>,
      get('orgs', 'orgs') as unknown as Promise<OrOrg[]>,
    ]);

    const roleOf = (u: OrUser): string => u.role ?? u.roles?.[0]?.role ?? '';
    const orgName = new Map(orgs.map((o) => [o.sourcedId, o.name ?? o.sourcedId]));
    const courseById = new Map(courses.map((co) => [co.sourcedId, co]));
    const classById = new Map(classes.map((cl) => [cl.sourcedId, cl]));
    const userById = new Map(users.map((u) => [u.sourcedId, u]));
    const name = (u: OrUser): string => [u.givenName, u.familyName].filter(Boolean).join(' ').trim() || u.username || u.sourcedId;
    const isActive = (s?: string): string => (s && /tobedeleted|inactive|deleted/i.test(s) ? 'inactive' : 'active');

    // Teachers
    const teacherUsers = users.filter((u) => roleOf(u) === 'teacher');
    const teachers: SisTeacher[] = teacherUsers.map((u) => ({
      id: u.sourcedId, employeeCode: String(u.metadata?.employeeNumber ?? u.metadata?.staffId ?? u.username ?? u.sourcedId),
      name: name(u), designation: 'Teacher', department: undefined, faculty: undefined,
      mobile: u.phone ?? u.sms ?? null, email: u.email ?? null, status: isActive(u.status),
    }));

    // Subjects (from courses)
    const subjects: SisSubject[] = courses.map((co) => ({ id: co.sourcedId, code: co.courseCode ?? co.sourcedId, name: co.title ?? co.sourcedId, department: undefined, program: undefined, creditHours: 0, status: 'active' }));

    // Teaching assignments = teacher enrollments in a class
    const teachingAssignments: SisTeachingAssignment[] = [];
    const asgByClass = new Map<string, SisTeachingAssignment[]>();
    for (const e of enrollments.filter((x) => x.role === 'teacher' && x.user && x.class)) {
      const cl = classById.get(e.class!.sourcedId);
      const t = userById.get(e.user!.sourcedId);
      if (!cl || !t) continue;
      const co = cl.course ? courseById.get(cl.course.sourcedId) : undefined;
      const a: SisTeachingAssignment = {
        id: `${cl.sourcedId}:${t.sourcedId}`, teacherId: t.sourcedId, teacher: name(t),
        subjectId: co?.sourcedId ?? cl.subjects?.[0] ?? cl.sourcedId, subject: co?.title ?? cl.subjects?.[0] ?? cl.title ?? cl.sourcedId,
        subjectCode: co?.courseCode ?? undefined, session: cl.terms?.[0]?.sourcedId ?? undefined, semester: undefined,
        campus: cl.school ? orgName.get(cl.school.sourcedId) : undefined, program: undefined,
        gradeClass: cl.grades?.[0] ?? undefined, section: cl.title ?? cl.classCode ?? undefined, startDate: null, endDate: null, status: 'active',
      };
      teachingAssignments.push(a);
      const list = asgByClass.get(cl.sourcedId) ?? []; list.push(a); asgByClass.set(cl.sourcedId, list);
    }

    // Students
    const studentUsers = users.filter((u) => roleOf(u) === 'student');
    const students: SisStudent[] = studentUsers.map((u) => ({
      id: u.sourcedId, registrationNo: u.username ?? u.sourcedId, rollNo: u.username ?? u.sourcedId, name: name(u),
      gender: String(u.metadata?.sex ?? u.metadata?.gender ?? 'Unspecified'), status: isActive(u.status),
      program: undefined, campus: u.orgs?.[0] ? orgName.get(u.orgs[0].sourcedId) : undefined,
      currentClass: u.grades?.[0] ?? undefined, currentSection: undefined, faculty: undefined, department: undefined,
      session: undefined, semester: undefined, dateOfBirth: null, admissionDate: null,
    }));

    // Parents/guardians: a student's `agents` are the parent users.
    const parents: SisParent[] = [];
    for (const s of studentUsers) {
      for (const ag of s.agents ?? []) {
        const p = userById.get(ag.sourcedId);
        if (!p || roleOf(p) === 'student') continue;
        parents.push({ id: p.sourcedId + ':' + s.sourcedId, studentId: s.sourcedId, name: name(p), relationship: 'Guardian', mobile: p.phone ?? p.sms ?? null, whatsapp: p.sms ?? p.phone ?? null, email: p.email ?? null, preferredLanguage: 'en', active: true });
      }
    }

    // Student enrollments → link each student to every teacher-assignment of their class.
    const enrollmentsOut: SisSnapshotEnrollment[] = [];
    let ei = 1;
    for (const e of enrollments.filter((x) => x.role === 'student' && x.user && x.class)) {
      for (const a of asgByClass.get(e.class!.sourcedId) ?? []) {
        enrollmentsOut.push({ id: `enr-${ei++}`, studentId: e.user!.sourcedId, teachingAssignmentId: a.id, teacher: a.teacher, subject: a.subject, subjectCode: a.subjectCode, gradeClass: a.gradeClass, section: a.section, session: a.session, enrollmentDate: null, status: isActive(e.status) });
      }
    }

    const uniq = (vals: (string | undefined)[]) => [...new Set(vals.filter((v): v is string => !!v))].map((n) => ({ id: n, code: n, name: n }));
    const snap = emptySnapshot();
    snap.campuses = orgs.filter((o) => o.type !== 'district').map((o) => ({ id: o.sourcedId, code: o.sourcedId, name: o.name ?? o.sourcedId }));
    snap.classes = uniq(students.map((s) => s.currentClass));
    snap.sections = uniq(teachingAssignments.map((a) => a.section));
    snap.sessions = uniq(teachingAssignments.map((a) => a.session));
    snap.subjects = subjects; snap.teachers = teachers; snap.students = students; snap.parents = parents;
    snap.teachingAssignments = teachingAssignments; snap.enrollments = enrollmentsOut;
    return snap;
  }
}
