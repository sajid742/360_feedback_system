/**
 * Connection-field specs for the SIS providers that have a live source. Mirrors the
 * HR integration's provider-connection descriptor: the single source of truth for the
 * admin form, the server allow-list, and which fields are secret (encrypted at rest,
 * never returned). `internal`/`csv` have no stored connection (they are populated by
 * the Excel/CSV import wizard, which carries the file + mapping at upload time).
 */
export interface SisConnectionFieldSpec {
  key: string;
  label: string;
  type?: 'text' | 'password' | 'select' | 'json' | 'number';
  placeholder?: string;
  secret?: boolean;
  options?: string[];
  help?: string;
}

export const SIS_PROVIDER_FIELDS: Record<string, SisConnectionFieldSpec[]> = {
  generic: [
    { key: 'sourceType', label: 'Source type', type: 'select', options: ['rest', 'sftp'], help: 'REST JSON bundle endpoint, or a JSON/Excel roster file on SFTP.' },
    { key: 'url', label: 'REST bundle URL', type: 'text', placeholder: 'https://sis.example.edu/api/roster', help: 'Returns { students, guardians, teachers, subjects, teachingAssignments, enrollments }.' },
    { key: 'authType', label: 'HTTP auth', type: 'select', options: ['none', 'bearer', 'apikey', 'basic'] },
    { key: 'token', label: 'Bearer token', type: 'password', secret: true },
    { key: 'apiKeyHeader', label: 'API key header name', type: 'text', placeholder: 'X-API-Key' },
    { key: 'apiKey', label: 'API key value', type: 'password', secret: true },
    { key: 'username', label: 'Username (basic / SFTP)', type: 'text' },
    { key: 'password', label: 'Password (basic / SFTP)', type: 'password', secret: true },
    { key: 'host', label: 'SFTP host', type: 'text' },
    { key: 'port', label: 'SFTP port', type: 'number', placeholder: '22' },
    { key: 'remotePath', label: 'SFTP file path (.json/.xlsx)', type: 'text', placeholder: '/exports/roster.json' },
    { key: 'privateKey', label: 'SFTP private key (optional)', type: 'password', secret: true },
  ],
  oneroster: [
    { key: 'baseUrl', label: 'OneRoster base URL', type: 'text', placeholder: 'https://sis.example.edu/ims/oneroster/v1p1', help: 'The OneRoster v1.1 REST base (…/ims/oneroster/v1p1).' },
    { key: 'tokenUrl', label: 'OAuth2 token URL', type: 'text', placeholder: 'https://sis.example.edu/oauth/token', help: 'Client-credentials token endpoint.' },
    { key: 'clientId', label: 'OAuth2 Client ID', type: 'text' },
    { key: 'clientSecret', label: 'OAuth2 Client Secret', type: 'password', secret: true },
  ],
};

export const SIS_CONFIGURABLE_PROVIDERS = new Set(Object.keys(SIS_PROVIDER_FIELDS));
export const SIS_KNOWN_PROVIDERS = new Set(['internal', 'mock', 'csv', ...SIS_CONFIGURABLE_PROVIDERS]);

export const SIS_SECRET_KEYS: Record<string, Set<string>> = Object.fromEntries(
  Object.entries(SIS_PROVIDER_FIELDS).map(([k, fields]) => [k, new Set(fields.filter((f) => f.secret).map((f) => f.key))]),
);
export const SIS_ALLOWED_KEYS: Record<string, Set<string>> = Object.fromEntries(
  Object.entries(SIS_PROVIDER_FIELDS).map(([k, fields]) => [k, new Set(fields.map((f) => f.key))]),
);

/** Providers that pull a live snapshot on "Sync" (vs. file-upload import). */
export const SIS_SYNC_PROVIDERS = new Set(['mock', 'generic', 'oneroster']);
/** Providers populated by the Excel/CSV upload wizard. */
export const SIS_IMPORT_PROVIDERS = new Set(['internal', 'csv']);
