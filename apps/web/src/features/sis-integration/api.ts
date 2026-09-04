import { apiClient } from '@/lib/api-client';

export interface SisProviderInfo { key: string; name: string; kind: 'import' | 'sync'; configurable: boolean; maturity?: 'stable' | 'beta'; maturityNote?: string }
export interface SisStatus {
  provider: string;
  providers: SisProviderInfo[];
  autoSync: boolean;
  intervalHours: number;
  mockScenario: string;
  lastSyncAt: string | null;
  nextSyncAt: string | null;
  dataset: { provider: string; students: number; teachers: number; updatedAt: string } | null;
  lastRun: { id: string; status: string; created: number; updated: number; deactivated: number; warnings: number; at: string } | null;
}

export interface SisIssue { entity: string; row: number | null; field: string | null; key: string | null; message: string }
export interface SisApplyResult {
  mode: 'dry_run' | 'live';
  provider: string;
  ok: boolean;
  counts: { created: number; updated: number; deactivated: number; autoMapped: number; protected: number };
  entityCounts: { students: number; guardians: number; teachers: number; teachingAssignments: number; enrollments: number };
  deactivate: { code: string; name: string | null }[];
  rename: { code: string; from: string; to: string }[];
  preserved: { code: string; name: string | null; reason: 'manual' | 'edited'; fields?: string[] }[];
  /**
   * Teacher → 360 employee mappings this run would move to a DIFFERENT employee.
   * Optional: runs recorded before this existed have no `repoint` in their summary.
   */
  repoint?: { code: string; name: string | null; from: string; to: string }[];
  /** True when this run would deactivate, rename, or re-point. */
  significant: boolean;
  /** Set when a live run was withheld pending confirmation — nothing was written. */
  requiresConfirmation?: boolean;
  errors: SisIssue[];
  warnings: SisIssue[];
  verify?: Record<string, number>;
  runId?: string;
}
export interface SisRun { id: string; mode: string; trigger: string; status: string; provider: string; by: string | null; created: number; updated: number; deactivated: number; warnings: number; at: string }

export interface ConnectionField { key: string; label: string; type?: 'text' | 'password' | 'select' | 'json' | 'number'; placeholder?: string; secret?: boolean; options?: string[]; help?: string }
export interface RedactedConnection { provider: string; fields: ConnectionField[]; settings: Record<string, unknown>; secretSet: Record<string, boolean> }
export interface TestResult { ok: boolean; provider: string; message: string; students?: number; teachers?: number }

export const sisApi = {
  status: (): Promise<SisStatus> => apiClient.get('/sis-integration/status'),
  history: (): Promise<SisRun[]> => apiClient.get('/sis-integration/history'),
  updateConfig: (p: { provider?: string; autoSync?: boolean; intervalHours?: number; mockScenario?: string }): Promise<unknown> => apiClient.put('/sis-integration/config', p),
  getConnection: (provider: string): Promise<RedactedConnection> => apiClient.get('/sis-integration/connection', { provider }),
  saveConnection: (provider: string, settings: Record<string, unknown>): Promise<RedactedConnection> => apiClient.put('/sis-integration/connection', { provider, settings }),
  testConnection: (): Promise<TestResult> => apiClient.post('/sis-integration/test', {}),
  sync: (live: boolean, confirm = false): Promise<SisApplyResult> => apiClient.post('/sis-integration/sync', { live, confirm }),
  import: (body: { filename: string; base64: string; entity?: string; dryRun: boolean; confirm?: boolean }): Promise<SisApplyResult> => apiClient.post('/sis-integration/import', body),
  downloadTemplate: (): Promise<void> => apiClient.download('/sis-integration/template', 'sis-import-template.xlsx'),
  downloadReport: (runId: string): Promise<void> => apiClient.download(`/sis-integration/${runId}/report`, 'sis-sync-report.csv'),
};
