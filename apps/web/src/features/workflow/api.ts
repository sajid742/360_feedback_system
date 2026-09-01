import { apiClient } from '@/lib/api-client';

export interface WorkflowTask {
  id: string;
  workflow: string;
  step: string;
  entityType: string;
  entityId: string;
  createdAt: string;
}

export interface DefinitionSummary {
  id: string;
  name: string;
  entityType: string;
  mode: string;
  isActive: boolean;
  steps: number;
}

export interface StepInput {
  name: string;
  stepOrder: number;
  assigneeType: 'role' | 'user';
  assigneeValue?: string;
}

export const workflowApi = {
  myTasks: (): Promise<WorkflowTask[]> => apiClient.get('/workflow/my-tasks'),
  act: (id: string, decision: 'approve' | 'reject', comment?: string): Promise<{ instanceStatus: string }> =>
    apiClient.post(`/workflow/tasks/${id}/act`, { decision, comment }),

  listDefinitions: (): Promise<DefinitionSummary[]> => apiClient.get('/workflow/definitions'),
  createDefinition: (input: {
    name: string;
    entityType: string;
    mode: 'sequential' | 'parallel';
    steps: StepInput[];
  }): Promise<{ id: string }> => apiClient.post('/workflow/definitions', input),
  deleteDefinition: (id: string): Promise<void> => apiClient.delete(`/workflow/definitions/${id}`),
};
