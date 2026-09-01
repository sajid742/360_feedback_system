import { apiClient } from '@/lib/api-client';
import type { GridData } from '@/components/shared/DataGridModal';

export interface Enps {
  score: number;
  promoters: number;
  passives: number;
  detractors: number;
  responses: number;
}

export interface Institutional {
  participation: { total: number; started: number; completed: number; completionPct: number };
  avgScore: number | null;
  distribution: { bucket: string; count: number }[];
  topPerformers: { name: string; score: number }[];
  bottomPerformers: { name: string; score: number }[];
  enps: Enps | null;
}

export interface NineBox {
  scaleMax: number;
  employees: { employeeId: string; name: string; performance: number; potential: number }[];
}

export interface ReportSchedule {
  id: string;
  name: string;
  reportType: 'institutional' | 'departmental';
  frequency: 'daily' | 'weekly' | 'monthly';
  recipients: string[];
  cycleId: string | null;
  isActive: boolean;
  lastRunAt: string | null;
  createdAt: string;
}

export interface DepartmentRow {
  department: string;
  participants: number;
  completed: number;
  avgScore: number | null;
  completionPct: number;
}

export interface TrendRow {
  /** Present so the trend chart can drill into the clicked cycle. */
  cycleId?: string;
  cycle: string;
  avgScore: number | null;
  participants: number;
  completionPct: number;
}

export interface CampusRow {
  campus: string;
  participants: number;
  completed: number;
  avgScore: number | null;
  completionPct: number;
}

export interface Executive {
  target: number;
  kpis: { participants: number; completed: number; completionPct: number; avgScore: number | null; enps: Enps | null };
  readiness: { ready: number; developing: number; notYet: number };
  trend: TrendRow[];
  byDepartment: DepartmentRow[];
  byCampus: CampusRow[];
  atRisk: { employeeId?: string; name: string; unit: string; score: number }[];
  topGaps: { competency: string; score: number; gap: number }[];
}

export interface Hr {
  target: number;
  kpis: {
    pending: number;
    avgDeptPerformance: number | null;
    trainingNeeds: number;
    calibrationPct: number;
    departmentsCompleted: number;
    departmentsTotal: number;
  };
  pendingByDepartment: { department: string; pending: number }[];
  byDepartment: DepartmentRow[];
  trainingNeeds: { competency: string; count: number }[];
}

export interface Heatmap {
  competencies: string[];
  departments: string[];
  data: [number, number, number | null][];
}

export interface Radar {
  competencies: string[];
  series: { name: string; values: (number | null)[] }[];
  /**
   * competency -> quadrant labels whose questionnaire covers it. Lets a blank cell be
   * labelled "not assessed by this quadrant" instead of being confused with a score
   * held back by the anonymity threshold.
   */
  assessedBy?: Record<string, string[]>;
  /** Quadrants present for this employee but withheld by the minimum-response rule. */
  withheldSources?: string[];
  minResponses?: number;
  confidentialUnlocked?: boolean;
}

/** One evaluator group's view of a competency. */
export interface SharedQuadrantCell {
  source: string;
  code: string;
  score: number | null;
  reviewers: number;
  state: 'scored' | 'withheld' | 'no_responses';
}

export interface SharedCompetencyRow {
  competency: string;
  /** Derived: assessed by two or more quadrants, so comparable across them. */
  shared: boolean;
  assessedBy: string[];
  /** Enough visible quadrants to justify a verdict. */
  comparable: boolean;
  quadrants: SharedQuadrantCell[];
  othersMean: number | null;
  selfScore: number | null;
  selfGap: number | null;
  spread: number | null;
  sd: number | null;
  highest: { source: string; score: number } | null;
  lowest: { source: string; score: number } | null;
  findings: { kind: string; label: string; detail: string }[];
}

export interface SharedCompetencies {
  rules: {
    gapModerate: number;
    gapPronounced: number;
    consensusSdLow: number;
    consensusSdHigh: number;
    comparisonMinQuadrants: number;
  };
  target: number;
  minResponses: number;
  confidentialUnlocked: boolean;
  items: SharedCompetencyRow[];
}

export interface GapRow {
  competency: string;
  current: number;
  expected: number;
  gap: number;
  priority: 'high' | 'medium' | 'low';
}

export interface TeamMember {
  employeeId: string;
  name: string;
  designation: string | null;
  overallScore: number | null;
  target: number;
  topStrength: string | null;
  focusArea: string | null;
  belowTarget: boolean;
  competenciesRated: number;
}

export interface MyTeam {
  isManager: boolean;
  target?: number;
  reports: TeamMember[];
}

/** Anonymised written feedback grouped by question (F-C7). */
export interface CommentGroup {
  question: string;
  /** The appraisee's own answers — always attributable, never suppressed. */
  self: string[];
  /** Pooled answers from all other sources; empty when suppressed. */
  others: string[];
  othersCount: number;
  suppressed: boolean;
}

export interface Individual {
  employee: { id: string; name: string; designation: string | null; department: string | null };
  overallScore: number | null;
  previousOverall: number | null;
  minResponses: number;
  /**
   * True when this viewer holds `reports.confidential.view`, so quadrants below the
   * minimum-response threshold are shown to them. Everyone else still sees them
   * withheld. Reviewer identity is never returned either way.
   */
  confidentialUnlocked?: boolean;
  /** `quadrants` = how many rater groups contributed to this combined score. */
  byCompetency: { competency: string; score: number; quadrants?: number }[];
  bySource: { source: string; score: number | null; reviewers: number; suppressed: boolean }[];
  strengths: { competency: string; score: number }[];
  weaknesses: { competency: string; score: number }[];
  gap: GapRow[];
  comments: CommentGroup[];
}

/** Cross-cycle history + per-quadrant reviewer coverage for one employee. */
export interface Employee360 {
  trend: { cycleId: string; cycle: string; score: number | null }[];
  sourceStatus: {
    source: string;
    code: string;
    assigned: number;
    submitted: number;
    pending: number;
    required: number;
    completionPct: number;
  }[];
}

function q(cycleId?: string): { cycleId?: string } {
  return cycleId ? { cycleId } : {};
}

/** Strip undefined/empty values so they aren't serialized as "?department=undefined". */
function clean(params: Record<string, string | boolean | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '' || v === false) continue;
    out[k] = v === true ? '1' : String(v);
  }
  return out;
}

/** Org-level feedback rules: anonymity threshold + target score (F-C4). */
export type AggregateVisibility = 'all_report_viewers' | 'executives_only';

/** Thresholds behind the comparison of shared competencies between evaluator groups. */
export interface ComparisonThresholds {
  gapModerate: number;
  gapPronounced: number;
  consensusSdLow: number;
  consensusSdHigh: number;
  comparisonMinQuadrants: number;
}

export interface FeedbackRules extends ComparisonThresholds {
  targetScore: number;
  minResponsesToShow: number;
  aggregateVisibility: AggregateVisibility;
  defaults: ComparisonThresholds & {
    targetScore: number;
    minResponsesToShow: number;
    aggregateVisibility: AggregateVisibility;
  };
}

export const reportsApi = {
  getFeedbackRules: (): Promise<FeedbackRules> => apiClient.get('/reports/feedback-rules'),
  setFeedbackRules: (
    input: Partial<ComparisonThresholds> & {
      targetScore?: number;
      minResponsesToShow?: number;
      aggregateVisibility?: AggregateVisibility;
    },
  ): Promise<FeedbackRules> => apiClient.put('/reports/feedback-rules', input),
  employee360: (employeeId: string, cycleId?: string): Promise<Employee360> =>
    apiClient.get(`/reports/employee-360/${employeeId}`, q(cycleId)),
  institutional: (cycleId?: string): Promise<Institutional> => apiClient.get('/reports/institutional', q(cycleId)),
  myTeam: (cycleId?: string): Promise<MyTeam> => apiClient.get('/reports/my-team', q(cycleId)),
  nineBox: (cycleId?: string): Promise<NineBox> => apiClient.get('/reports/nine-box', q(cycleId)),
  listSchedules: (): Promise<ReportSchedule[]> => apiClient.get('/reports/schedules'),
  createSchedule: (body: { name: string; reportType: string; frequency: string; recipients: string[]; cycleId?: string }): Promise<{ id: string }> =>
    apiClient.post('/reports/schedules', body),
  deleteSchedule: (id: string): Promise<{ id: string; deleted: boolean }> => apiClient.delete(`/reports/schedules/${id}`),
  runSchedule: (id: string): Promise<{ sent: number }> => apiClient.post(`/reports/schedules/${id}/run`),
  departmental: (cycleId?: string): Promise<DepartmentRow[]> => apiClient.get('/reports/departmental', q(cycleId)),
  campus: (cycleId?: string): Promise<CampusRow[]> => apiClient.get('/reports/campus', q(cycleId)),
  executive: (cycleId?: string): Promise<Executive> => apiClient.get('/reports/executive', q(cycleId)),
  hr: (cycleId?: string): Promise<Hr> => apiClient.get('/reports/hr', q(cycleId)),
  drilldown: {
    participants: (params: { cycleId?: string; department?: string; campus?: string; band?: string }): Promise<GridData> =>
      apiClient.get('/reports/drilldown/participants', clean(params)),
    pending: (params: { cycleId?: string; department?: string }): Promise<GridData> =>
      apiClient.get('/reports/drilldown/pending', clean(params)),
    competency: (params: { cycleId?: string; competency?: string; belowTarget?: boolean }): Promise<GridData> =>
      apiClient.get('/reports/drilldown/competency', clean(params)),
  },
  trend: (): Promise<TrendRow[]> => apiClient.get('/reports/trend'),
  heatmap: (cycleId?: string): Promise<Heatmap> => apiClient.get('/reports/heatmap', q(cycleId)),
  individual: (employeeId: string, cycleId?: string): Promise<Individual> =>
    apiClient.get(`/reports/individual/${employeeId}`, q(cycleId)),
  sharedCompetencies: (employeeId: string, cycleId?: string): Promise<SharedCompetencies> =>
    apiClient.get(`/reports/shared-competencies/${employeeId}`, { cycleId }),
  radar: (employeeId: string, cycleId?: string): Promise<Radar> => apiClient.get(`/reports/radar/${employeeId}`, q(cycleId)),
  exportFile: (type: 'institutional' | 'departmental', format: 'csv' | 'xlsx', cycleId?: string): Promise<void> => {
    const stamp = new Date().toISOString().slice(0, 10);
    return apiClient.download('/reports/export', `360-${type}-${stamp}.${format}`, { type, format, ...q(cycleId) });
  },
  // Configurable dashboard layouts (Executive / HR) — stored per organization.
  getLayout: (type: DashboardType): Promise<{ type: DashboardType; layout: DashboardLayout | null }> =>
    apiClient.get(`/reports/dashboard-layout/${type}`),
  saveLayout: (type: DashboardType, layout: DashboardLayout): Promise<{ type: DashboardType; layout: DashboardLayout }> =>
    apiClient.put(`/reports/dashboard-layout/${type}`, layout),
  resetLayout: (type: DashboardType): Promise<{ type: DashboardType; layout: null }> =>
    apiClient.delete(`/reports/dashboard-layout/${type}`),
};

export type DashboardType = 'executive' | 'hr';
/** Per-widget config is presentation-only; kept opaque here (typed in the dashboard registry). */
export interface LayoutItem { key: string; span: number; config?: Record<string, unknown> }
export interface DashboardLayout { widgets: LayoutItem[]; theme?: string }
