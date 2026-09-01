import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/features/auth/AuthContext';

/** Redirects unauthenticated users to /login, preserving the intended path. */
export function RequireAuth({ children }: { children: JSX.Element }): JSX.Element {
  const { token, user, initializing } = useAuth();
  const location = useLocation();

  if (initializing) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  if (!token) return <Navigate to="/login" state={{ from: location }} replace />;
  // A user with a temporary password must set a new one before doing anything else.
  if (user?.mustChangePassword) return <Navigate to="/set-password" replace />;
  // Org MFA policy: a user who must enrol in MFA is routed to enrolment first.
  if (user?.mustEnrollMfa) return <Navigate to="/enroll-mfa" replace />;
  return children;
}
