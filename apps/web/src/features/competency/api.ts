import { apiClient, type ListParams, type Paginated } from '@/lib/api-client';
import type {
  BehaviourIndicator,
  CategoryInput,
  Competency,
  CompetencyCategory,
  CompetencyInput,
  CompetencyStats,
  CompetencyVersion,
  IndicatorInput,
} from './types';

/**
 * Competency REST client. Paths follow the documented CRUD pattern; the
 * organization scope is derived server-side from the JWT, so no organization
 * id is ever sent from the client (shared-schema multi-tenancy).
 */
const BASE = '/competency';

export const competencyApi = {
  getStats: (): Promise<CompetencyStats> => apiClient.get(`${BASE}/stats`),

  /* Categories */
  listCategories: (params?: ListParams): Promise<Paginated<CompetencyCategory>> =>
    apiClient.get(`${BASE}/categories`, params),
  createCategory: (input: CategoryInput): Promise<CompetencyCategory> =>
    apiClient.post(`${BASE}/categories`, input),
  updateCategory: (id: string, input: CategoryInput): Promise<CompetencyCategory> =>
    apiClient.put(`${BASE}/categories/${id}`, input),
  deleteCategory: (id: string): Promise<void> => apiClient.delete(`${BASE}/categories/${id}`),

  /* Competencies */
  listCompetencies: (params?: ListParams): Promise<Paginated<Competency>> =>
    apiClient.get(`${BASE}/competencies`, params),
  getCompetency: (id: string): Promise<Competency> => apiClient.get(`${BASE}/competencies/${id}`),
  createCompetency: (input: CompetencyInput): Promise<Competency> =>
    apiClient.post(`${BASE}/competencies`, input),
  updateCompetency: (id: string, input: CompetencyInput): Promise<Competency> =>
    apiClient.put(`${BASE}/competencies/${id}`, input),
  archiveCompetency: (id: string): Promise<void> => apiClient.delete(`${BASE}/competencies/${id}`),

  /* Versions — activate retires the previously-active one server-side */
  cloneDraft: (competencyId: string): Promise<CompetencyVersion> =>
    apiClient.post(`${BASE}/competencies/${competencyId}/versions`),
  activateVersion: (versionId: string): Promise<CompetencyVersion> =>
    apiClient.post(`${BASE}/versions/${versionId}/activate`),

  /* Behaviour indicators — only editable while the version is a draft */
  listIndicators: (versionId: string): Promise<BehaviourIndicator[]> =>
    apiClient.get(`${BASE}/versions/${versionId}/indicators`),
  addIndicator: (versionId: string, input: IndicatorInput): Promise<BehaviourIndicator> =>
    apiClient.post(`${BASE}/versions/${versionId}/indicators`, input),
  updateIndicator: (indicatorId: string, input: IndicatorInput): Promise<BehaviourIndicator> =>
    apiClient.put(`${BASE}/indicators/${indicatorId}`, input),
  deleteIndicator: (indicatorId: string): Promise<void> =>
    apiClient.delete(`${BASE}/indicators/${indicatorId}`),
};
