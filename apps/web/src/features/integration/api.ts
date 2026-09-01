import { apiClient } from '@/lib/api-client';

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  status: 'active' | 'revoked' | 'expired';
  createdAt: string;
}

export interface CreatedApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  expiresAt: string | null;
  createdAt: string;
  key: string; // shown once
}

export interface WebhookEndpoint {
  id: string;
  url: string;
  events: string[];
  isActive: boolean;
  description: string | null;
  secretMasked: string;
  createdAt: string;
}

export interface CreatedWebhook extends Omit<WebhookEndpoint, 'secretMasked' | 'createdAt'> {
  secret: string; // shown once
}

export interface WebhookDelivery {
  id: string;
  event: string;
  status: string;
  statusCode: number | null;
  error: string | null;
  attempts: number;
  createdAt: string;
}

export interface TestResult {
  deliveryId: string;
  status: string;
  statusCode: number | null;
  error: string | null;
}

export interface ReportsApiParam { name: string; in: string; required: boolean; description: string }
export interface ReportsApiEndpoint { method: string; url: string; scope: string; label: string; description: string; params: ReportsApiParam[]; responseKeys: string[] }
export interface ReportsApiScope { scope: string; label: string; description: string }
export interface ReportsApiDoc {
  version: string;
  baseUrl: string;
  authHeader: string;
  readOnly: boolean;
  notes: string[];
  scopes: ReportsApiScope[];
  endpoints: ReportsApiEndpoint[];
}

export const integrationApi = {
  listKeys: (): Promise<ApiKey[]> => apiClient.get('/integration/api-keys'),
  createKey: (body: { name: string; scopes?: string[]; expiresAt?: string }): Promise<CreatedApiKey> =>
    apiClient.post('/integration/api-keys', body),
  revokeKey: (id: string): Promise<{ id: string; revoked: boolean }> => apiClient.delete(`/integration/api-keys/${id}`),
  reportsApiCatalog: (): Promise<ReportsApiDoc> => apiClient.get('/integration/reports-api/catalog'),

  listWebhooks: (): Promise<WebhookEndpoint[]> => apiClient.get('/integration/webhooks'),
  createWebhook: (body: { url: string; events?: string[]; description?: string }): Promise<CreatedWebhook> =>
    apiClient.post('/integration/webhooks', body),
  updateWebhook: (
    id: string,
    body: { url?: string; events?: string[]; isActive?: boolean; description?: string },
  ): Promise<WebhookEndpoint> => apiClient.put(`/integration/webhooks/${id}`, body),
  deleteWebhook: (id: string): Promise<{ id: string; deleted: boolean }> => apiClient.delete(`/integration/webhooks/${id}`),
  deliveries: (id: string): Promise<WebhookDelivery[]> => apiClient.get(`/integration/webhooks/${id}/deliveries`),
  test: (id: string): Promise<TestResult> => apiClient.post(`/integration/webhooks/${id}/test`, {}),
};

/** Domain events an org can subscribe a webhook to. */
export const WEBHOOK_EVENTS = [
  'appraisal.cycle.active',
  'appraisal.cycle.closed',
  'appraisal.cycle.archived',
] as const;
