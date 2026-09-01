import { apiClient } from '@/lib/api-client';

export interface FeatureFlag {
  id: string;
  key: string;
  isEnabled: boolean;
  description: string | null;
}

export interface RatingScaleLevel {
  id: string;
  value: number;
  label: string;
  color: string | null;
  icon: string | null;
  sortOrder: number;
}

export interface RatingScale {
  id: string;
  name: string;
  scaleType: string;
  minValue: number;
  maxValue: number;
  status: string;
  levels: RatingScaleLevel[];
}

export const configApi = {
  listFeatureFlags: (): Promise<FeatureFlag[]> => apiClient.get('/configuration/feature-flags'),
  createFeatureFlag: (input: { key: string; description?: string; isEnabled?: boolean }): Promise<FeatureFlag> =>
    apiClient.post('/configuration/feature-flags', input),
  updateFeatureFlag: (id: string, input: { isEnabled?: boolean; description?: string }): Promise<FeatureFlag> =>
    apiClient.put(`/configuration/feature-flags/${id}`, input),
  deleteFeatureFlag: (id: string): Promise<void> => apiClient.delete(`/configuration/feature-flags/${id}`),

  listRatingScales: (): Promise<RatingScale[]> => apiClient.get('/configuration/rating-scales'),
};
