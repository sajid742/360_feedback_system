import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useFeatureFlags } from './useFeatureFlags';

/**
 * Hides a route behind a feature flag (F27).
 *
 * The flag previously filtered only the navigation list, so a disabled module was
 * still reachable by typing its URL — and its API answered normally. The server now
 * enforces the same flag; this keeps the UI honest so a user never lands on a page
 * that will only return errors.
 */
export function FeatureRoute({ flag, children }: { flag: string; children: ReactNode }): JSX.Element {
  const flags = useFeatureFlags();
  if (flags[flag] === false) return <Navigate to="/" replace />;
  return <>{children}</>;
}
