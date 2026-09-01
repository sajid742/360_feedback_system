import { apiClient } from '@/lib/api-client';

export type ImportEntity = 'organization' | 'campuses' | 'departments' | 'designations' | 'employees' | 'competencies';
export type ImportMode = 'skip' | 'update' | 'replace' | 'reset';

export interface EntityCount { entity: ImportEntity; parsed: number; toCreate: number; toUpdate: number; toSkip: number }
export interface ValidationIssue { entity: string; row: number | null; field: string | null; key: string | null; severity: 'error' | 'warning'; message: string }
export interface ValidationResult {
  jobId: string;
  filename?: string;
  sheetsFound?: ImportEntity[];
  counts: EntityCount[];
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  preview: Record<string, Record<string, unknown>[]>;
  canImport: boolean;
  existing: Record<string, number>;
  activeCycleCount: number;
  mode?: ImportMode;
}
export interface EntitySummary { entity: ImportEntity; processed: number; created: number; updated: number; skipped: number; failed: number }
export interface ImportResult {
  jobId: string;
  summary: { perEntity: EntitySummary[]; warnings: ValidationIssue[]; failures: ValidationIssue[]; mode: ImportMode };
  verify: Record<string, number>;
}

export interface UploadPayload { filename: string; contentBase64: string; entity?: ImportEntity; mode?: ImportMode }
export interface ConfirmPayload { mode: ImportMode; confirmDestructive?: boolean; defaultPassword?: string }

export const orgImportApi = {
  validate: (p: UploadPayload): Promise<ValidationResult> => apiClient.post('/org-import/validate', p),
  preview: (jobId: string, mode: ImportMode): Promise<ValidationResult> => apiClient.get(`/org-import/${jobId}/preview`, { mode }),
  confirm: (jobId: string, p: ConfirmPayload): Promise<ImportResult> => apiClient.post(`/org-import/${jobId}/confirm`, p),
  downloadReport: (jobId: string): Promise<void> => apiClient.download(`/org-import/${jobId}/report`, 'import-report.csv'),
  downloadTemplate: (format: 'xlsx' | 'csv', entity?: ImportEntity): Promise<void> =>
    apiClient.download('/org-import/template/download', format === 'xlsx' ? 'organization-import-template.xlsx' : `import-template-${entity}.csv`, { format, entity }),

  /** Export current organization data in the same layout as the import template (F-H6). */
  exportData: (format: 'xlsx' | 'csv' = 'xlsx', entity = 'Employees'): Promise<void> => {
    const stamp = new Date().toISOString().slice(0, 10);
    return apiClient.download(
      '/org-import/export',
      format === 'xlsx' ? `organization-export-${stamp}.xlsx` : `organization-${entity.toLowerCase()}-${stamp}.csv`,
      { format, entity },
    );
  },
};

/** Read a File as base64 (no data: prefix). */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = String(reader.result);
      resolve(res.includes(',') ? res.slice(res.indexOf(',') + 1) : res);
    };
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.readAsDataURL(file);
  });
}
