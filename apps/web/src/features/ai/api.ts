import { apiClient } from '@/lib/api-client';

export type BlindSpotType = 'blind_spot' | 'hidden_strength' | 'aligned' | 'self_only' | 'no_self';

export interface BlindSpot {
  competency: string;
  selfScore: number | null;
  othersScore: number | null;
  delta: number | null;
  type: BlindSpotType;
}

export interface Recommendation {
  competency: string;
  priority: 'high' | 'medium' | 'low';
  action: string;
}

export interface Sentiment {
  positive: number;
  neutral: number;
  negative: number;
  score: number;
  samples: { text: string; sentiment: 'positive' | 'neutral' | 'negative' }[];
}

export interface ReadinessFactor {
  label: string;
  detail: string;
  value: number;
}

export interface PromotionReadiness {
  score: number;
  band: 'Ready' | 'Developing' | 'Not yet';
  factors: ReadinessFactor[];
}

export interface Insights {
  employee: { id: string; name: string; designation: string | null; department: string | null };
  overallScore: number | null;
  target: number;
  hasData: boolean;
  blindSpots: BlindSpot[];
  strengths: BlindSpot[];
  weaknesses: BlindSpot[];
  recommendations: Recommendation[];
  promotionReadiness: PromotionReadiness;
  sentiment: Sentiment;
  summary: string;
  generatedBy: 'ai' | 'heuristic';
}

export interface AtRisk {
  employeeId: string;
  name: string;
  department: string;
  score: number;
  risk: number;
  driver: string;
}

export interface Overview {
  target: number;
  appraised: number;
  readiness: { ready: number; developing: number; notYet: number };
  atRisk: AtRisk[];
  topGaps: { competency: string; score: number; gap: number }[];
  sentiment: Sentiment;
}

export interface AiStatus {
  configured: boolean;
  model: string | null;
}

/** The provider settings, as an administrator is allowed to see them back. */
export interface AiProviderView {
  configured: boolean;
  enabled: boolean;
  baseUrl: string | null;
  model: string | null;
  /** The last four characters of the stored key — never the key itself. */
  apiKeyHint: string | null;
}

export interface AiProviderTest {
  ok: boolean;
  model: string | null;
  detail: string;
}

function q(cycleId?: string): { cycleId?: string } {
  return cycleId ? { cycleId } : {};
}

export const aiApi = {
  status: (): Promise<AiStatus> => apiClient.get('/ai/status'),
  overview: (cycleId?: string): Promise<Overview> => apiClient.get('/ai/overview', q(cycleId)),
  insights: (employeeId: string, cycleId?: string): Promise<Insights> =>
    apiClient.get(`/ai/insights/${employeeId}`, q(cycleId)),

  // Provider settings. `apiKey` is write-only: it is never returned, and it is omitted
  // on save to keep whatever is already stored.
  provider: (): Promise<AiProviderView> => apiClient.get('/ai/provider'),
  saveProvider: (body: {
    baseUrl: string;
    apiKey?: string;
    model?: string;
    enabled?: boolean;
  }): Promise<AiProviderView> => apiClient.put('/ai/provider', body),
  removeProvider: (): Promise<AiProviderView> => apiClient.delete('/ai/provider'),
  testProvider: (): Promise<AiProviderTest> => apiClient.post('/ai/provider/test', {}),
};
