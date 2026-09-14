import { apiClient } from '@/lib/api-client';

export interface Cycle {
  id: string;
  name: string;
  status: string;
  startDate: string;
  endDate: string;
  /** Feedback is accepted up to and including this day. Null means "until the cycle is closed". */
  submissionDeadline: string | null;
  participants: number;
  sources: number;
}

export interface Source {
  id: string;
  code: string;
  label: string;
  weight: number;
  requiredCount: number;
  isAnonymous: boolean;
  weightShare: number;
  /** Questionnaire configured on this quadrant, or null when it inherits the cycle's. */
  templateId: string | null;
  templateName: string | null;
  /** What reviewers in this quadrant actually answer, after falling back to the cycle questionnaire. */
  effectiveTemplateId: string | null;
  effectiveTemplateName: string | null;
  inheritsCycleTemplate: boolean;
  /** Parents quadrant only. null = one form per teacher; 'consolidated' = one per student. */
  parentMode: string | null;
  parentRequireAll: boolean;
}

/** One quadrant's row in the competency coverage matrix. */
export interface CoverageQuadrant {
  sourceId: string;
  code: string;
  label: string;
  weight: number;
  effectiveTemplateId: string | null;
  effectiveTemplateName: string | null;
  ownTemplate: boolean;
  questionCount: number;
  competencyIds: string[];
}

export interface CoverageCompetency {
  competencyId: string;
  competency: string;
  /** Quadrant *codes* whose questionnaire asks about this competency. */
  quadrants: string[];
  questionCountByQuadrant: Record<string, number>;
  shared: boolean;
}

export interface CycleCoverage {
  cycleTemplateId: string | null;
  cycleTemplateName: string | null;
  mixedQuestionnaires: boolean;
  quadrants: CoverageQuadrant[];
  competencies: CoverageCompetency[];
  questionsWithoutCompetency: number;
}

export interface CycleTemplate {
  id: string;
  name: string;
  description: string | null;
  templateId: string | null;
  ratingScaleId: string | null;
  sources: { code: string; label: string; weight: number; requiredCount: number; isAnonymous: boolean }[];
  createdAt: string;
  createdBy: string;
}

export interface Participant {
  id: string;
  employeeId: string;
  name: string;
  status: string;
  finalScore: number | null;
  potentialRating: number | null;
  assignments: number;
  visibility: string;
  releasedAt: string | null;
}

export interface Assignment {
  id: string;
  appraisee: string;
  reviewer: string;
  source: string;
  status: string;
  nominationStatus: string;
}

export interface PendingReviewer {
  assignmentId: string;
  reviewer: string;
  appraisee: string;
  source: string;
  status: string;
  lastRemindedAt: string | null;
}

export interface Participation {
  total: number;
  submitted: number;
  completionPct: number;
  bySource: { source: string; total: number; submitted: number; completionPct: number }[];
  /** Total outstanding reviewers, which may exceed the length of `pending` (capped list). */
  pendingTotal: number;
  pending: PendingReviewer[];
}

export interface MyReview {
  id: string;
  cycle: string;
  /** The person being reviewed — always named to their assigned reviewer. */
  appraisee: string;
  appraiseeTitle: string | null;
  appraiseeDepartment: string | null;
  source: string;
  sourceCode: string;
  /** True when the reviewer's own identity is withheld from the appraisee's report. */
  anonymousToAppraisee: boolean;
  status: string;
  answered: number;
  deadline: string | null;
}

export interface ReviewQuestion {
  id: string;
  text: string;
  type: string;
  ratingValue: number | null;
  textValue: string | null;
}

export interface ScaleAnchor {
  value: number;
  label: string;
  color: string | null;
}

export interface ReviewForm {
  id: string;
  status: string;
  appraisee: string;
  appraiseeTitle: string | null;
  appraiseeDepartment: string | null;
  cycle: string;
  source: string;
  sourceCode: string;
  anonymousToAppraisee: boolean;
  deadline: string | null;
  scale: ScaleAnchor[];
  questions: ReviewQuestion[];
}

export interface ReminderSettings { enabled: boolean; cadenceDays: number; sendHour: number }

export const appraisalApi = {
  getReminderSettings: (): Promise<ReminderSettings> => apiClient.get('/appraisal/reminder-settings'),
  setReminderSettings: (body: Partial<ReminderSettings>): Promise<ReminderSettings> =>
    apiClient.put('/appraisal/reminder-settings', body),
  listCycles: (): Promise<Cycle[]> => apiClient.get('/appraisal/cycles'),
  createCycle: (input: { name: string; startDate: string; endDate: string; templateId?: string }): Promise<{ id: string }> =>
    apiClient.post('/appraisal/cycles', input),
  /**
   * Edit a draft or active cycle. Only the keys sent are changed, and
   * `submissionDeadline: null` CLEARS the deadline rather than leaving it alone —
   * which is how you say "collect feedback until I close this cycle by hand".
   * A closed or archived cycle is refused by the API.
   */
  updateCycle: (
    id: string,
    input: { name?: string; startDate?: string; endDate?: string; submissionDeadline?: string | null },
  ): Promise<Cycle & { templateId: string | null; ratingScaleId: string | null }> =>
    apiClient.put(`/appraisal/cycles/${id}`, input),
  activate: (id: string): Promise<unknown> => apiClient.post(`/appraisal/cycles/${id}/activate`),
  /** Ends collection. A closed cycle accepts no further feedback and no roster changes. */
  close: (id: string): Promise<{ id: string; status: string }> =>
    apiClient.post(`/appraisal/cycles/${id}/close`),
  cloneCycle: (id: string): Promise<{ id: string }> => apiClient.post(`/appraisal/cycles/${id}/clone`),
  // Reusable cycle templates (F31)
  listCycleTemplates: (): Promise<CycleTemplate[]> => apiClient.get('/appraisal/cycle-templates'),
  saveCycleTemplate: (input: { name: string; description?: string; fromCycleId: string }): Promise<CycleTemplate> =>
    apiClient.post('/appraisal/cycle-templates', input),
  deleteCycleTemplate: (templateId: string): Promise<{ id: string; deleted: boolean }> =>
    apiClient.delete(`/appraisal/cycle-templates/${templateId}`),
  applyCycleTemplate: (templateId: string, input: { name: string; startDate: string; endDate: string; submissionDeadline?: string }): Promise<{ id: string }> =>
    apiClient.post(`/appraisal/cycle-templates/${templateId}/apply`, input),
  participation: (id: string): Promise<Participation> => apiClient.get(`/appraisal/cycles/${id}/participation`),
  importParticipants: (id: string, emails: string[]): Promise<{ added: number; skipped: number; notFound: string[] }> =>
    apiClient.post(`/appraisal/cycles/${id}/participants/import`, { emails }),
  remindAssignment: (assignmentId: string): Promise<{ sent: number }> => apiClient.post(`/appraisal/assignments/${assignmentId}/remind`),
  approveNomination: (assignmentId: string): Promise<{ nominationStatus: string }> =>
    apiClient.post(`/appraisal/assignments/${assignmentId}/nominate/approve`),
  rejectNomination: (assignmentId: string): Promise<{ nominationStatus: string }> =>
    apiClient.post(`/appraisal/assignments/${assignmentId}/nominate/reject`),

  listSources: (id: string): Promise<Source[]> => apiClient.get(`/appraisal/cycles/${id}/sources`),
  /** Change a quadrant's label, weight, required count or anonymity. `code` is fixed. */
  updateSource: (
    id: string,
    sourceId: string,
    input: { label?: string; weight?: number; requiredCount?: number; isAnonymous?: boolean; isActive?: boolean },
  ): Promise<Source> => apiClient.put(`/appraisal/cycles/${id}/sources/${sourceId}`, input),

  addSource: (id: string, input: { code: string; label: string; weight?: number; isAnonymous?: boolean }): Promise<{ id: string }> =>
    apiClient.post(`/appraisal/cycles/${id}/sources`, input),
  /** Per-quadrant questionnaire; pass null to go back to inheriting the cycle questionnaire. */
  setSourceTemplate: (
    id: string,
    sourceId: string,
    templateId: string | null,
  ): Promise<{ id: string; templateId: string | null; templateName: string | null }> =>
    apiClient.put(`/appraisal/cycles/${id}/sources/${sourceId}/template`, { templateId }),
  /** Parents quadrant only: how it collects feedback. */
  setParentMode: (
    id: string,
    sourceId: string,
    mode: 'standard' | 'consolidated',
    requireAll: boolean,
  ): Promise<{ id: string; parentMode: string | null; parentRequireAll: boolean }> =>
    apiClient.put(`/appraisal/cycles/${id}/sources/${sourceId}/parent-mode`, { mode, requireAll }),
  coverage: (id: string): Promise<CycleCoverage> => apiClient.get(`/appraisal/cycles/${id}/coverage`),

  listParticipants: (id: string): Promise<Participant[]> => apiClient.get(`/appraisal/cycles/${id}/participants`),
  addParticipant: (id: string, employeeId: string): Promise<{ id: string }> =>
    apiClient.post(`/appraisal/cycles/${id}/participants`, { employeeId }),
  calibrate: (participantId: string, finalScore: number): Promise<void> =>
    apiClient.post(`/appraisal/participants/${participantId}/calibrate`, { finalScore }),
  setPotential: (participantId: string, potential: number): Promise<{ potentialRating: number }> =>
    apiClient.post(`/appraisal/participants/${participantId}/potential`, { potential }),
  release: (cycleId: string, participantId: string): Promise<{ visibility: string; releasedAt: string | null }> =>
    apiClient.post(`/appraisal/cycles/${cycleId}/participants/${participantId}/release`),
  retract: (cycleId: string, participantId: string): Promise<{ visibility: string; releasedAt: string | null }> =>
    apiClient.post(`/appraisal/cycles/${cycleId}/participants/${participantId}/retract`),
  remind: (cycleId: string): Promise<{ sent: number }> => apiClient.post(`/appraisal/cycles/${cycleId}/remind`),

  /** Paginated assignments; pass nominationStatus to fetch just the approval queue (F-P5). */
  listAssignments: (
    id: string,
    opts: { page?: number; pageSize?: number; nominationStatus?: string } = {},
  ): Promise<{ items: Assignment[]; page: number; pageSize: number; total: number; totalPages: number }> =>
    apiClient.get(`/appraisal/cycles/${id}/assignments`, {
      page: opts.page,
      pageSize: opts.pageSize,
      nominationStatus: opts.nominationStatus,
    }),
  createAssignment: (id: string, input: { participantId: string; sourceId: string; reviewerEmployeeId: string; propose?: boolean }): Promise<{ id: string }> =>
    apiClient.post(`/appraisal/cycles/${id}/assignments`, input),

  myReviews: (): Promise<MyReview[]> => apiClient.get('/appraisal/my-reviews'),
  reviewForm: (id: string): Promise<ReviewForm> => apiClient.get(`/appraisal/assignments/${id}/form`),
  saveDraft: (id: string, responses: { questionId: string; ratingValue?: number; textValue?: string }[]): Promise<{ status: string; answered: number }> =>
    apiClient.post(`/appraisal/assignments/${id}/save`, { responses }),
  submit: (id: string, responses: { questionId: string; ratingValue?: number; textValue?: string }[]): Promise<{ status: string; score: number | null }> =>
    apiClient.post(`/appraisal/assignments/${id}/submit`, { responses }),
};
