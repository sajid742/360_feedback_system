/**
 * Declarative connection-field specs for the real HR providers. This is the single
 * source of truth shared by the connection store (allow-list + which fields are
 * secret) and, indirectly, the admin UI. Adding a provider = add its fields here,
 * implement the HrProvider, and register it — nothing in the 360 business logic
 * changes.
 *
 * `type` is a UI hint only; the server treats every value as text (except `mapping`,
 * which is a JSON object). Secret fields are encrypted at rest and never returned to
 * the client.
 */
export interface ConnectionFieldSpec {
  key: string;
  label: string;
  /** UI hint: 'text' | 'password' | 'select' | 'json' | 'number'. */
  type?: 'text' | 'password' | 'select' | 'json' | 'number';
  placeholder?: string;
  secret?: boolean;
  options?: string[];
  help?: string;
}

export const PROVIDER_FIELDS: Record<string, ConnectionFieldSpec[]> = {
  bamboohr: [
    { key: 'subdomain', label: 'Company domain (subdomain)', type: 'text', placeholder: 'carepvtltd', help: 'The part before .bamboohr.com in your login URL.' },
    { key: 'apiKey', label: 'API key', type: 'password', secret: true, help: 'Generate in BambooHR → your account → API Keys.' },
  ],
  zoho_people: [
    { key: 'dc', label: 'Data center', type: 'select', options: ['com', 'eu', 'in', 'com.au', 'jp', 'sa', 'ca'], placeholder: 'com', help: 'Matches your Zoho account region (accounts.zoho.<dc>).' },
    { key: 'clientId', label: 'OAuth Client ID', type: 'text' },
    { key: 'clientSecret', label: 'OAuth Client Secret', type: 'password', secret: true },
    { key: 'refreshToken', label: 'OAuth Refresh Token', type: 'password', secret: true, help: 'Self-client/authorized-code refresh token with ZOHOPEOPLE.forms.READ scope.' },
  ],
  generic: [
    { key: 'sourceType', label: 'Source type', type: 'select', options: ['rest', 'csv_url', 'sftp'], help: 'REST JSON endpoint, a CSV file over HTTPS, or a CSV file on SFTP.' },
    { key: 'orgName', label: 'Organization name (optional)', type: 'text' },
    // REST / CSV-over-HTTP
    { key: 'url', label: 'URL (REST endpoint or CSV file URL)', type: 'text', placeholder: 'https://hr.carepvtltd.com/api/employees' },
    { key: 'authType', label: 'HTTP auth', type: 'select', options: ['none', 'bearer', 'apikey', 'basic'] },
    { key: 'token', label: 'Bearer token', type: 'password', secret: true },
    { key: 'apiKeyHeader', label: 'API key header name', type: 'text', placeholder: 'X-API-Key' },
    { key: 'apiKey', label: 'API key value', type: 'password', secret: true },
    { key: 'username', label: 'Username (basic / SFTP)', type: 'text' },
    { key: 'password', label: 'Password (basic / SFTP)', type: 'password', secret: true },
    { key: 'arrayPath', label: 'JSON path to the employee array (REST)', type: 'text', placeholder: 'data.employees', help: 'Dot path; leave blank if the response is already an array.' },
    // SFTP
    { key: 'host', label: 'SFTP host', type: 'text' },
    { key: 'port', label: 'SFTP port', type: 'number', placeholder: '22' },
    { key: 'remotePath', label: 'SFTP file path', type: 'text', placeholder: '/exports/employees.csv' },
    { key: 'privateKey', label: 'SFTP private key (optional)', type: 'password', secret: true },
    { key: 'delimiter', label: 'CSV delimiter', type: 'text', placeholder: ',' },
    // Field mapping (source column/key → our field)
    { key: 'mapping', label: 'Field mapping', type: 'json', help: 'Map your source columns to: employeeCode, fullName, email, department, designation, campus, managerCode, status, joinDate.' },
  ],
};

/** Providers that have a connection config (mock/internal don't). */
export const CONFIGURABLE_PROVIDERS = new Set(Object.keys(PROVIDER_FIELDS));

/** All provider keys selectable at runtime (mock is built-in, needs no config). */
export const KNOWN_PROVIDERS = new Set(['mock', ...CONFIGURABLE_PROVIDERS]);

/** Set of secret field keys per provider (encrypted at rest, never returned). */
export const SECRET_KEYS: Record<string, Set<string>> = Object.fromEntries(
  Object.entries(PROVIDER_FIELDS).map(([k, fields]) => [k, new Set(fields.filter((f) => f.secret).map((f) => f.key))]),
);

/** Field keys allowed for a provider (drops anything unrecognised). */
export const ALLOWED_KEYS: Record<string, Set<string>> = Object.fromEntries(
  Object.entries(PROVIDER_FIELDS).map(([k, fields]) => [k, new Set(fields.map((f) => f.key))]),
);
