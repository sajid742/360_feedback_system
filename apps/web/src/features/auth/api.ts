import { apiClient } from '@/lib/api-client';

export interface AuthUser {
  id: string;
  email: string;
  fullName: string | null;
  organizationId: string;
  permissions: string[];
  /** When true, the user must set a new password before using the app. */
  mustChangePassword?: boolean;
  /** When true, the user must enrol in MFA before using the app (org policy). */
  mustEnrollMfa?: boolean;
}

export type MfaPolicyMode = 'optional' | 'required_admins' | 'required_all';

export interface PasswordPolicy {
  minLength: number;
  requireUpper: boolean;
  requireLower: boolean;
  requireNumber: boolean;
  requireSymbol: boolean;
  historyCount: number;
}
export interface LockoutPolicy { maxAttempts: number; windowMinutes: number }
export interface SecurityPolicy { password: PasswordPolicy; lockout: LockoutPolicy; mfa: { mode: MfaPolicyMode } }

export interface Session {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

export interface MfaChallenge {
  mfaRequired: true;
  mfaToken: string;
}

export type LoginResponse = Session | MfaChallenge;

export interface LoginInput {
  organizationSlug: string;
  email: string;
  password: string;
  captchaToken?: string;
}

export interface SessionInfo {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface MfaSetup {
  secret: string;
  otpauthUrl: string;
}

export function isMfaChallenge(res: LoginResponse): res is MfaChallenge {
  return 'mfaRequired' in res;
}

export const authApi = {
  login: (input: LoginInput): Promise<LoginResponse> => apiClient.post('/auth/login', input),
  mfaLogin: (mfaToken: string, code: string): Promise<Session> =>
    apiClient.post('/auth/mfa/login', { mfaToken, code }),
  refresh: (refreshToken: string): Promise<Session> => apiClient.post('/auth/refresh', { refreshToken }),
  logout: (refreshToken: string): Promise<void> => apiClient.post('/auth/logout', { refreshToken }),

  // Self-service password recovery + forced change.
  forgotPassword: (organizationSlug: string, email: string): Promise<{ success: boolean }> =>
    apiClient.post('/auth/password/forgot', { organizationSlug, email }),
  resetPassword: (token: string, newPassword: string): Promise<{ success: boolean }> =>
    apiClient.post('/auth/password/reset', { token, newPassword }),
  setInitialPassword: (newPassword: string): Promise<Session> =>
    apiClient.post('/auth/password/set-initial', { newPassword }),

  mfaStatus: (): Promise<{ enabled: boolean }> => apiClient.get('/auth/mfa/status'),
  mfaSetup: (): Promise<MfaSetup> => apiClient.post('/auth/mfa/setup'),
  mfaEnable: (code: string): Promise<{ backupCodes: string[] }> =>
    apiClient.post('/auth/mfa/enable', { code }),
  mfaDisable: (): Promise<void> => apiClient.post('/auth/mfa/disable'),

  listSessions: (): Promise<SessionInfo[]> => apiClient.get('/auth/sessions'),
  revokeSession: (id: string): Promise<void> => apiClient.delete(`/auth/sessions/${id}`),

  // Organisation MFA policy (F8, security admin)
  getMfaPolicy: (): Promise<{ mode: MfaPolicyMode }> => apiClient.get('/auth/mfa/policy'),
  setMfaPolicy: (mode: MfaPolicyMode): Promise<{ mode: MfaPolicyMode }> => apiClient.put('/auth/mfa/policy', { mode }),
  getSecurityPolicy: (): Promise<SecurityPolicy> => apiClient.get('/auth/security-policy'),
  setPasswordPolicy: (body: Partial<PasswordPolicy>): Promise<PasswordPolicy> => apiClient.put('/auth/security-policy/password', body),
  setLockoutPolicy: (body: Partial<LockoutPolicy>): Promise<LockoutPolicy> => apiClient.put('/auth/security-policy/lockout', body),
};
