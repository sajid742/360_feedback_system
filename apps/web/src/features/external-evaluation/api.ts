import { apiClient } from '@/lib/api-client';

export interface EvalQuestion {
  id: string;
  text: string;
  type: 'rating' | 'text';
}

export interface EvalContext {
  student: string | null;
  parent: string | null;
  teacher: string | null;
  subject: string | null;
  class: string | null;
  section: string | null;
  session: string | null;
  organizationName: string;
  questions: EvalQuestion[];
  scale: { value: number; label: string }[];
  status: 'open' | 'completed';
}

export interface EvaluationLink {
  id: string;
  studentId: string;
  student: string | null;
  /** The guardian's roster id, so a row can be traced back to the record it came from. */
  parentId: string | null;
  parent: string | null;
  recipient: string | null;
  teacherId: string | null;
  cycleId: string | null;
  /** 'consolidated' = one link covering every teacher; otherwise one link per teacher. */
  mode: string;
  teacher: string | null;
  subject: string | null;
  class: string | null;
  section: string | null;
  session: string | null;
  status: string;
  oneTime: boolean;
  expiresAt: string | null;
  overallScore: number | null;
  channel: string | null;
  sentAt: string | null;
  openedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  url?: string;
  token?: string;
  sent?: { channel: string; recipient: string } | null;
}

export interface EvalResponseItem {
  questionId: string;
  ratingValue?: number;
  textValue?: string;
}

/** One teacher on a consolidated form. */
export interface ConsolidatedTeacher {
  teacherId: string;
  teacher: string | null;
  subjects: string | null;
  rating: number | null;
}

/**
 * What a consolidated link returns. Distinguished from the per-teacher context by
 * `mode === 'consolidated'`; the two shapes never mix.
 */
export interface ConsolidatedContext {
  mode: 'consolidated';
  student: string | null;
  parent: string | null;
  class: string | null;
  section: string | null;
  organizationName: string;
  question: { id: string; text: string } | null;
  scale: { value: number; label: string }[];
  requireAll: boolean;
  teachers: ConsolidatedTeacher[];
  status: 'open' | 'completed';
}

export type AnyEvalContext = (EvalContext & { mode?: undefined }) | ConsolidatedContext;

export const isConsolidated = (c: AnyEvalContext): c is ConsolidatedContext => c.mode === 'consolidated';

// Public (no-auth) endpoints
export const publicEvalApi = {
  validate: (token: string): Promise<AnyEvalContext> => apiClient.get(`/public/evaluate/${encodeURIComponent(token)}`),
  submit: (token: string, responses: EvalResponseItem[]): Promise<{ status: string }> =>
    apiClient.post(`/public/evaluate/${encodeURIComponent(token)}`, { responses }),
  /** Consolidated form: every teacher's rating in one submission. */
  submitConsolidated: (
    token: string,
    ratings: { teacherId: string; ratingValue: number }[],
  ): Promise<{ status: string; rated: number; skipped: number }> =>
    apiClient.post(`/public/evaluate/${encodeURIComponent(token)}/consolidated`, { ratings }),
};

// SIS browse (read-only, for choosing who to evaluate)
export interface SisStudent {
  id: string;
  registrationNo: string;
  name: string;
  currentClass?: string;
  currentSection?: string;
  program?: string;
  campus?: string;
}
export interface SisParent {
  id: string;
  name: string;
  relationship: string;
  mobile?: string | null;
  whatsapp?: string | null;
  email?: string | null;
}
export interface SisTeacherOfStudent {
  teacherId: string;
  teacher: string;
  subjectId: string;
  subject: string;
  teachingAssignmentId: string;
  section?: string;
}

export const sisApi = {
  /**
   * The full roster. The old call asked for 100 rows and the caller then rendered
   * 50, so students beyond that could never be picked for parent feedback and
   * nothing said so. `search` is applied server-side.
   */
  students: (search?: string): Promise<SisStudent[]> =>
    apiClient.get('/sis/students', { limit: 2000, ...(search ? { search } : {}) }),
  parents: (studentId: string): Promise<SisParent[]> => apiClient.get(`/sis/students/${studentId}/parents`),
  teachers: (studentId: string): Promise<SisTeacherOfStudent[]> => apiClient.get(`/sis/students/${studentId}/teachers`),
};

// Teacher ↔ Employee identity mapping
export interface IdentityEmployee {
  id: string;
  employeeCode: string;
  name: string;
}
export interface TeacherMapping {
  teacherId: string;
  teacherName: string;
  employeeCode: string | null;
  designation: string | null;
  mappedEmployeeId: string | null;
  mappedEmployeeName: string | null;
  mappedActive: boolean | null;
  suggestedEmployeeId: string | null;
  suggestedEmployeeName: string | null;
}

export const identityApi = {
  employees: (search?: string): Promise<{ items: IdentityEmployee[]; total: number; truncated: boolean }> =>
    apiClient.get('/identity/employees', { search }),
  teacherMapping: (): Promise<TeacherMapping[]> => apiClient.get('/identity/teacher-mapping'),
  save: (input: { externalId: string; externalCode?: string; employeeId: string }): Promise<unknown> =>
    apiClient.post('/identity/maps', { externalType: 'teacher', ...input }),
  clear: (externalId: string): Promise<unknown> =>
    apiClient.post('/identity/maps/unmap', { externalType: 'teacher', externalId }),
};

// Admin endpoints
/** What a consolidated link returns to the admin who generated it. */
export interface ConsolidatedLink extends EvaluationLink {
  mode: 'consolidated';
  teachers: { teacherId: string; teacher: string; subjects: string }[];
  /** Teachers left off the form, with the reason — usually "not mapped to a 360 employee". */
  skipped: { teacher: string; reason: string }[];
}

export const evalAdminApi = {
  /** One consolidated form per student, covering every teacher that student has. */
  createConsolidated: (input: {
    studentId: string;
    parentId?: string;
    expiresInDays?: number;
    oneTime?: boolean;
    send?: boolean;
    channel?: 'whatsapp' | 'email' | 'sms';
    recipient?: string;
    /** Always pass this: several cycles can be active at once. */
    cycleId?: string;
  }): Promise<ConsolidatedLink> => apiClient.post('/external-evaluation/consolidated', input),
  /** Which parent feedback mode the target cycle is configured for. */
  parentMode: (cycleId?: string): Promise<{ cycleId: string | null; mode: string | null; requireAll: boolean }> =>
    apiClient.get('/external-evaluation/mode', cycleId ? { cycleId } : undefined),
  create: (input: {
    studentId: string;
    teachingAssignmentId: string;
    parentId?: string;
    expiresInDays?: number;
    oneTime?: boolean;
    send?: boolean;
    channel?: 'whatsapp' | 'email' | 'sms';
    recipient?: string;
  }): Promise<EvaluationLink> => apiClient.post('/external-evaluation', input),
  list: (studentId?: string): Promise<EvaluationLink[]> =>
    apiClient.get('/external-evaluation', studentId ? { studentId } : undefined),
  revoke: (id: string): Promise<EvaluationLink> => apiClient.post(`/external-evaluation/${id}/revoke`),
  /**
   * `force` is required only for a link the parent has already submitted: re-issuing
   * discards their responses and score, so the API refuses without it.
   */
  regenerate: (id: string, body?: { channel?: 'whatsapp' | 'email' | 'sms'; recipient?: string; force?: boolean }): Promise<EvaluationLink> =>
    apiClient.post(`/external-evaluation/${id}/regenerate`, body ?? {}),
};
