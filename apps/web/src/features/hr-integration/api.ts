import { apiClient } from '@/lib/api-client';

export type OrgDataSource = 'internal' | 'external_hr';

export interface HrStatus {
  mode: OrgDataSource;
  provider: string;
  providers: { key: string; name: string; configurable?: boolean; maturity?: 'stable' | 'beta'; maturityNote?: string }[];
  autoSync: boolean;
  intervalHours: number;
  mockScenario: string;
  lastSyncAt: string | null;
  nextSyncAt: string | null;
  lastRun: { id: string; status: string; created: number; updated: number; deactivated: number; failed: number; warnings: number; at: string } | null;
}

export interface SyncIssue { entity: string; row: number | null; field: string | null; key: string | null; severity: string; message: string }
export interface SyncResult {
  mode: 'dry_run' | 'live';
  provider: string;
  canSync: boolean;
  counts: { created: number; updated: number; deactivated: number; skipped: number; failed: number };
  perEntity: { entity: string; parsed?: number; toCreate?: number; toUpdate?: number; toSkip?: number; created?: number; updated?: number; skipped?: number; failed?: number }[];
  deactivate: { employeeCode: string; name: string | null }[];
  internalOnly: number;
  errors: SyncIssue[];
  warnings: SyncIssue[];
  verify?: Record<string, number>;
  runId?: string;
}
export interface HrRun { id: string; mode: string; trigger: string; status: string; provider: string; by: string | null; created: number; updated: number; deactivated: number; failed: number; warnings: number; at: string }

export interface HrConfigPatch {
  mode?: OrgDataSource;
  provider?: string;
  autoSync?: boolean;
  intervalHours?: number;
  mockScenario?: string;
}

export interface ConnectionField {
  key: string;
  label: string;
  type?: 'text' | 'password' | 'select' | 'json' | 'number';
  placeholder?: string;
  secret?: boolean;
  options?: string[];
  help?: string;
}
export interface RedactedConnection {
  provider: string;
  fields: ConnectionField[];
  settings: Record<string, unknown>;
  secretSet: Record<string, boolean>;
}
export interface TestResult { ok: boolean; provider: string; message: string; employees?: number; departments?: number; sample?: string[] }

export const hrApi = {
  status: (): Promise<HrStatus> => apiClient.get('/hr-integration/status'),
  history: (): Promise<HrRun[]> => apiClient.get('/hr-integration/history'),
  updateConfig: (p: HrConfigPatch): Promise<unknown> => apiClient.put('/hr-integration/config', p),
  sync: (live: boolean): Promise<SyncResult> => apiClient.post('/hr-integration/sync', { live }),
  downloadReport: (runId: string): Promise<void> => apiClient.download(`/hr-integration/${runId}/report`, 'hr-sync-report.csv'),
  getConnection: (provider: string): Promise<RedactedConnection> => apiClient.get('/hr-integration/connection', { provider }),
  saveConnection: (provider: string, settings: Record<string, unknown>): Promise<RedactedConnection> => apiClient.put('/hr-integration/connection', { provider, settings }),
  testConnection: (): Promise<TestResult> => apiClient.post('/hr-integration/test', {}),
};
