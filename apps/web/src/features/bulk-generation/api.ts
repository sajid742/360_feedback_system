import { apiClient } from '@/lib/api-client';

export interface ScopeOption { id: string; name: string; employees: number; parentId?: string | null; unitType?: string }
export interface Scopes { totalActiveEmployees: number; campuses: ScopeOption[]; departments: ScopeOption[] }

export interface BulkConfig {
  evaluators: { self: boolean; manager: boolean; peer: boolean; subordinate: boolean; parent: boolean };
  /** Rungs of the reporting line to ask. 1 = the immediate line manager only. */
  managerLevels: number;
  peer: { min: number; max: number; crossDepartment: boolean };
  allowOutOfScope: boolean;
  includeParents: boolean;
  channels: string[];
  notify: boolean;
}

export interface PreviewSummary {
  scope: { type: string; name: string };
  employees: number;
  managers: number;
  managerLevels?: number;
  managersByLevel?: { level: number; count: number }[];
  peers: number;
  subordinates: number;
  selfAssignments: number;
  parentEvaluations: number;
  teachers: number;
  students: number;
  parents: number;
  totalAssignments: number;
  messages: { whatsapp: number; email: number; sms: number; inApp: number; total: number };
  issues: { missingManagers: string[]; noPeers: string[]; noSubordinates: string[]; shortChains?: string[]; teachersNoParents: string[] };
  counts: { missingManagers: number; noPeers: number; noSubordinates: number; teachersNoParents: number };
}

export interface GenerateResult {
  runId: string;
  cycleId: string;
  cycleStatus: string;
  summary: PreviewSummary;
  assignmentsCreated: number;
  skippedCount: number;
  failedCount: number;
  messagesQueued: number;
  skipped: { type: string; who: string; reason: string }[];
  failed: { type: string; who: string; reason: string }[];
}

export interface RunRow {
  id: string; cycleId: string | null; cycleName: string | null; initiatedByName: string | null;
  scopeType: string; scopeName: string | null; status: string;
  assignmentsCreated: number; skippedCount: number; failedCount: number; messagesQueued: number;
  createdAt: string; completedAt: string | null;
}

export interface ScopeInput { scopeType: 'all' | 'campus' | 'department'; scopeId?: string }
export interface CycleInput { name: string; startDate: string; endDate: string; submissionDeadline?: string; templateId?: string; ratingScaleId?: string }

export const bulkApi = {
  scopes: (): Promise<Scopes> => apiClient.get('/appraisal/bulk/scopes'),
  preview: (body: ScopeInput & { config: BulkConfig }): Promise<PreviewSummary> => apiClient.post('/appraisal/bulk/preview', body),
  generate: (body: ScopeInput & { config: BulkConfig; cycle: CycleInput }): Promise<GenerateResult> => apiClient.post('/appraisal/bulk/generate', body),
  runs: (): Promise<RunRow[]> => apiClient.get('/appraisal/bulk/runs'),
  run: (id: string): Promise<GenerateResult & { config: BulkConfig; createdAt: string }> => apiClient.get(`/appraisal/bulk/runs/${id}`),
};

export const DEFAULT_CONFIG: BulkConfig = {
  evaluators: { self: false, manager: true, peer: true, subordinate: true, parent: true },
  managerLevels: 1,
  peer: { min: 1, max: 5, crossDepartment: false },
  allowOutOfScope: false,
  includeParents: true,
  channels: ['in_app', 'email'],
  notify: true,
};
