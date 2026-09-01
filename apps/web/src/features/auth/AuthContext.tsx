import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { setAccessTokenGetter, setSessionHandlers } from '@/lib/api-client';
import { authApi, isMfaChallenge, type AuthUser, type LoginInput, type Session } from './api';

interface AuthState {
  user: AuthUser | null;
  token: string | null;
  initializing: boolean;
  /** Returns an mfaToken when MFA is required; otherwise the signed-in user. */
  login: (input: LoginInput) => Promise<{ mfaToken: string | null; user: AuthUser | null }>;
  completeMfa: (mfaToken: string, code: string) => Promise<AuthUser>;
  /** Complete a forced password change; persists the returned fresh session. */
  setInitialPassword: (newPassword: string) => Promise<void>;
  /** Refresh the access token (e.g. after enrolling in MFA) to clear pending flags. */
  refreshSession: () => Promise<void>;
  logout: () => void;
}

const TOKEN_KEY = 'e360.accessToken';
const REFRESH_KEY = 'e360.refreshToken';
const USER_KEY = 'e360.user';

const AuthContext = createContext<AuthState | null>(null);

function readStored<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }): JSX.Element {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));
  const [user, setUser] = useState<AuthUser | null>(() => readStored<AuthUser>(USER_KEY));
  const [initializing, setInitializing] = useState(true);

  useEffect(() => {
    setAccessTokenGetter(() => localStorage.getItem(TOKEN_KEY));
    // Keep React state in step with a background token refresh, and drop the
    // in-memory session once the refresh token is finally rejected (F-H1).
    setSessionHandlers({
      onRefreshed: (accessToken) => setToken(accessToken),
      onExpired: () => {
        setToken(null);
        setUser(null);
      },
    });
  }, []);

  useEffect(() => setInitializing(false), []);

  const persist = useCallback((session: Session) => {
    setToken(session.accessToken);
    setUser(session.user);
    localStorage.setItem(TOKEN_KEY, session.accessToken);
    localStorage.setItem(REFRESH_KEY, session.refreshToken);
    localStorage.setItem(USER_KEY, JSON.stringify(session.user));
  }, []);

  const login = useCallback(
    async (input: LoginInput): Promise<{ mfaToken: string | null; user: AuthUser | null }> => {
      const result = await authApi.login(input);
      if (isMfaChallenge(result)) return { mfaToken: result.mfaToken, user: null };
      persist(result);
      return { mfaToken: null, user: result.user };
    },
    [persist],
  );

  const completeMfa = useCallback(
    async (mfaToken: string, code: string): Promise<AuthUser> => {
      const session = await authApi.mfaLogin(mfaToken, code);
      persist(session);
      return session.user;
    },
    [persist],
  );

  const setInitialPassword = useCallback(
    async (newPassword: string) => {
      persist(await authApi.setInitialPassword(newPassword));
    },
    [persist],
  );

  const refreshSession = useCallback(async () => {
    const refresh = localStorage.getItem(REFRESH_KEY);
    if (refresh) persist(await authApi.refresh(refresh));
  }, [persist]);

  const logout = useCallback(() => {
    const refresh = localStorage.getItem(REFRESH_KEY);
    if (refresh) void authApi.logout(refresh).catch(() => undefined);
    setToken(null);
    setUser(null);
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(USER_KEY);
  }, []);

  const value = useMemo<AuthState>(
    () => ({ user, token, initializing, login, completeMfa, setInitialPassword, refreshSession, logout }),
    [user, token, initializing, login, completeMfa, setInitialPassword, refreshSession, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export function usePermissions(): { has: (code: string) => boolean; all: string[] } {
  const { user } = useAuth();
  const set = useMemo(() => new Set(user?.permissions ?? []), [user]);
  return { has: (code: string) => set.has(code), all: user?.permissions ?? [] };
}
