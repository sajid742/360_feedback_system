import { apiClient } from '@/lib/api-client';

export interface AuditEvent {
  id: string;
  action: string;
  actorUserId: string | null;
  actorName: string | null;
  actorRole: string | null;
  cycleId: string | null;
  cycleName: string | null;
  evaluateeEmployeeId: string | null;
  evaluateeName: string | null;
  evaluatorEmployeeId: string | null;
  evaluatorName: string | null;
  sourceType: string | null;
  entityType: string;
  entityId: string | null;
  previousValue: unknown;
  newValue: unknown;
  reason: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
}

export interface AuditQuery {
  search?: string;
  from?: string;
  to?: string;
  cycleId?: string;
  evaluatee?: string;
  evaluator?: string;
  actor?: string;
  action?: string;
  sourceType?: string;
  limit?: number;
  offset?: number;
}

export interface AuditFacets {
  actions: string[];
  sourceTypes: string[];
}

/** Strip empty values so they don't become `?x=` query params. */
function clean(q: Record<string, string | number | undefined>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') out[k] = v;
  return out;
}

export const feedbackAuditApi = {
  list: (q: AuditQuery): Promise<{ items: AuditEvent[]; total: number }> => apiClient.get('/feedback-audit', clean(q as never)),
  facets: (): Promise<AuditFacets> => apiClient.get('/feedback-audit/facets'),
  history: (entityType: string, entityId: string): Promise<AuditEvent[]> =>
    apiClient.get('/feedback-audit/history', { entityType, entityId }),
  exportCsv: (q: AuditQuery): Promise<void> =>
    apiClient.download('/feedback-audit/export', 'feedback-audit-trail.csv', clean(q as never)),
};
