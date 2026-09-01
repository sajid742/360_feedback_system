import { apiClient } from '@/lib/api-client';

export type LicenseStatus =
  | 'ACTIVE' | 'EXPIRING' | 'GRACE_PERIOD' | 'EXPIRED'
  | 'NOT_STARTED' | 'SUSPENDED' | 'INVALID' | 'NONE';

export interface LicenseModule {
  key: string;
  label: string;
}

export interface LicenseUsage {
  employees: number;
  maxEmployees: number;
  employeePercent: number;
  users: number;
  maxUsers: number | null;
}

export interface LicenseView {
  status: LicenseStatus;
  /** Already written for an administrator — display it as-is, never re-word it. */
  message: string;
  daysRemaining: number | null;
  operational: boolean;
  isDevelopment: boolean;
  graceDays: number;
  maxEmployees: number;
  maxUsers: number | null;
  modules: LicenseModule[];
  license: {
    licenseId: string;
    organizationName: string;
    edition: string;
    issuedAt: string;
    startsAt: string;
    expiresAt: string;
    notes: string;
  } | null;
  usage?: LicenseUsage;
}

export const licenseApi = {
  get: (): Promise<LicenseView> => apiClient.get('/license'),
  status: (): Promise<LicenseView> => apiClient.get('/license/status'),
  install: (licenseKey: string): Promise<LicenseView> => apiClient.post('/license/install', { licenseKey }),
};
