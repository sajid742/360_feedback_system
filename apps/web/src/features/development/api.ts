import { apiClient } from '@/lib/api-client';

export interface DevelopmentAction {
  id: string;
  employeeId: string;
  employeeName?: string;
  title: string;
  competency: string | null;
  description: string | null;
  status: 'open' | 'in_progress' | 'done';
  priority: 'low' | 'medium' | 'high';
  dueDate: string | null;
  createdAt: string;
}

export interface CreateAction {
  employeeId: string;
  title: string;
  competency?: string;
  description?: string;
  priority?: 'low' | 'medium' | 'high';
  dueDate?: string;
}

export const developmentApi = {
  list: (employeeId?: string): Promise<DevelopmentAction[]> =>
    apiClient.get('/development/actions', employeeId ? { employeeId } : {}),
  create: (body: CreateAction): Promise<DevelopmentAction> => apiClient.post('/development/actions', body),
  update: (
    id: string,
    body: Partial<Pick<DevelopmentAction, 'title' | 'competency' | 'description' | 'status' | 'priority' | 'dueDate'>>,
  ): Promise<DevelopmentAction> => apiClient.put(`/development/actions/${id}`, body),
  remove: (id: string): Promise<{ id: string; deleted: boolean }> => apiClient.delete(`/development/actions/${id}`),
};
