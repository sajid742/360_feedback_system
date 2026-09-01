/**
 * External Reports API (v1) — the read-only, API-key surface for external dashboards.
 * This file is the SINGLE SOURCE OF TRUTH for the scope catalogue and the endpoint
 * documentation: the controller decorators, the admin docs endpoint, and the admin UI
 * (scope picker + docs page) all derive from it. Adding an endpoint here + a handler
 * that calls the existing ReportsService is the whole job — no new reporting logic.
 *
 * Every scope is a plain string carried on an ApiKey (`api_keys.scopes[]`) and checked
 * by the standard PermissionsGuard, exactly like a user permission. These are API-only
 * scopes (not assignable to RBAC roles), so they never widen a human user's access.
 */

export const REPORTS_API_VERSION = 'v1';
/** Effective base path (platform prefix `/api/v1` + integration API `v1`). */
export const REPORTS_API_BASE = '/api/v1/integration/v1/reports';
export const REPORTS_API_AUTH_HEADER = 'X-Api-Key';

export const REPORTS_API_SCOPE = {
  executive: 'reports.api.executive',
  hr: 'reports.api.hr',
  institutional: 'reports.api.institutional',
  departmental: 'reports.api.departmental',
  campus: 'reports.api.campus',
  trend: 'reports.api.trend',
  ninebox: 'reports.api.ninebox',
  heatmap: 'reports.api.heatmap',
} as const;

export interface ReportsApiParam { name: string; in: 'query'; required: boolean; description: string }
export interface ReportsApiEndpoint {
  key: string;
  method: 'GET';
  /** Path relative to REPORTS_API_BASE. */
  path: string;
  scope: string;
  label: string;
  description: string;
  params: ReportsApiParam[];
  /** A few illustrative top-level keys of the JSON payload (for the docs page). */
  responseKeys: string[];
}

const CYCLE_PARAM: ReportsApiParam = { name: 'cycleId', in: 'query', required: false, description: 'Optional appraisal cycle UUID. Omit for all cycles.' };

export const REPORTS_API_ENDPOINTS: ReportsApiEndpoint[] = [
  { key: 'executive', method: 'GET', path: '/executive', scope: REPORTS_API_SCOPE.executive, label: 'Executive Dashboard',
    description: 'Executive KPIs (participants, completion, average score, eNPS), promotion readiness, performance/completion trend, and department & campus roll-ups.',
    params: [CYCLE_PARAM], responseKeys: ['kpis', 'readiness', 'trend', 'byDepartment', 'byCampus', 'atRisk', 'topGaps', 'target'] },
  { key: 'hr', method: 'GET', path: '/hr', scope: REPORTS_API_SCOPE.hr, label: 'HR Dashboard',
    description: 'HR KPIs (pending reviews, average department performance, training needs, calibration progress) with per-department breakdowns.',
    params: [CYCLE_PARAM], responseKeys: ['kpis', 'pendingByDepartment', 'byDepartment', 'trainingNeeds', 'target'] },
  { key: 'institutional', method: 'GET', path: '/institutional', scope: REPORTS_API_SCOPE.institutional, label: 'Institutional Reports',
    description: 'Institution-wide participation, average score, score distribution, top/bottom performers, and eNPS.',
    params: [CYCLE_PARAM], responseKeys: ['participation', 'avgScore', 'distribution', 'topPerformers', 'bottomPerformers', 'enps'] },
  { key: 'departmental', method: 'GET', path: '/departmental', scope: REPORTS_API_SCOPE.departmental, label: 'Departmental Reports',
    description: 'Per-department participation, completion, and average score.',
    params: [CYCLE_PARAM], responseKeys: ['[].department', '[].participants', '[].completed', '[].avgScore', '[].completionPct'] },
  { key: 'campus', method: 'GET', path: '/campus', scope: REPORTS_API_SCOPE.campus, label: 'Campus Reports',
    description: 'Per-campus participation, completion, and average score.',
    params: [CYCLE_PARAM], responseKeys: ['[].campus', '[].participants', '[].completed', '[].avgScore', '[].completionPct'] },
  { key: 'trend', method: 'GET', path: '/trend', scope: REPORTS_API_SCOPE.trend, label: 'Trends',
    description: 'Cycle-over-cycle trend of average score, participants, and completion percentage.',
    params: [], responseKeys: ['[].cycle', '[].avgScore', '[].participants', '[].completionPct'] },
  { key: 'nine-box', method: 'GET', path: '/nine-box', scope: REPORTS_API_SCOPE.ninebox, label: 'Nine-Box',
    description: 'Performance-versus-potential nine-box talent distribution.',
    params: [CYCLE_PARAM], responseKeys: ['scaleMax', 'employees'] },
  { key: 'heatmap', method: 'GET', path: '/heatmap', scope: REPORTS_API_SCOPE.heatmap, label: 'Heatmap',
    description: 'Competency-by-department score heatmap.',
    params: [CYCLE_PARAM], responseKeys: ['competencies', 'departments', 'data'] },
];

/** Compact scope catalogue for the admin key-creation form. */
export const REPORTS_API_SCOPE_CATALOG = REPORTS_API_ENDPOINTS.map((e) => ({ scope: e.scope, label: e.label, description: e.description }));

/** Full documentation document consumed by the admin docs page. */
export function reportsApiDoc() {
  return {
    version: REPORTS_API_VERSION,
    baseUrl: REPORTS_API_BASE,
    authHeader: REPORTS_API_AUTH_HEADER,
    readOnly: true,
    notes: [
      'Authenticate with the X-Api-Key request header over HTTPS. Never place the key in the URL.',
      'A key only ever reads the organization it was created for; org isolation is enforced server-side.',
      'Anonymity/minimum-response suppression and all reporting calculations are identical to the in-app dashboards.',
      'Responses use the standard envelope { success, message, data, errors } and carry ETag + Cache-Control for conditional caching.',
      'Requests are rate-limited per API key (HTTP 429 when exceeded).',
    ],
    scopes: REPORTS_API_SCOPE_CATALOG,
    endpoints: REPORTS_API_ENDPOINTS.map((e) => ({ method: e.method, url: `${REPORTS_API_BASE}${e.path}`, scope: e.scope, label: e.label, description: e.description, params: e.params, responseKeys: e.responseKeys })),
  };
}
